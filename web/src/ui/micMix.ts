/**
 * 麦克风混音：把「本软件正在播放的音乐」和「物理麦克风」混成一路，送到虚拟音频线
 * （VB-Audio CABLE Input / VoiceMeeter Input 等）的播放端。
 *
 * 使用方式：语音软件把麦克风选成虚拟线的录音端（CABLE Output）。这样对方既能听到
 * 你正常说话，也能听到 Zilux2 的音乐；本机扬声器仍然照常播放。
 *
 * 只取 Zilux2 自己的音频（audioTap 的 Web Audio 图），不采集系统里其它应用的声音。
 */

import { appMusicOutputNode, audioTapState, ensureAppAudioGraph } from '../core/audioTap';
import { host, postMessage } from '../core/bridge';

export interface MicMixConfig {
  micDeviceId: string;
  outputDeviceId: string;
  /** 播放端友好名（Chromium deviceId 不是 WASAPI 端点 ID，宿主按名字拉系统音量） */
  outputLabel: string;
  /** 0–6，1 = 原始电平 */
  musicGain: number;
  micGain: number;
  /** 0–6，混音后的总增益；默认 1.5 让虚拟麦克风电平接近系统其它麦克风 */
  outputGain: number;
}

export interface MicrophoneDevice {
  id: string;
  label: string;
}

const STORAGE_KEY = 'zilux2.micMix.v1';

const DEFAULT_CONFIG: MicMixConfig = {
  micDeviceId: '',
  outputDeviceId: '',
  outputLabel: '',
  musicGain: 0.85,
  micGain: 1,
  outputGain: 1.5,
};

function clampGain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(6, Math.max(0, value));
}

function clampOutputGain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1.5;
  return Math.min(6, Math.max(0, value));
}

export function loadMicMixConfig(): MicMixConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    const record = parsed as Partial<MicMixConfig>;
    return {
      micDeviceId: typeof record.micDeviceId === 'string' ? record.micDeviceId : '',
      outputDeviceId: typeof record.outputDeviceId === 'string' ? record.outputDeviceId : '',
      outputLabel: typeof record.outputLabel === 'string' ? record.outputLabel : '',
      musicGain: clampGain(record.musicGain),
      micGain: clampGain(record.micGain),
      outputGain: clampOutputGain(record.outputGain),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveMicMixConfig(config: MicMixConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 设置仍会在本次会话内生效；localStorage 不可用不影响混音。
  }
}

/**
 * 枚举物理麦克风。Chromium 在拿到麦克风权限后才返回设备名称；宿主已授权，
 * 但部分机器仍要先用一次 getUserMedia 解锁标签。
 */
export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) return [];
  let devices = await media.enumerateDevices();
  const hasInput = devices.some((device) => device.kind === 'audioinput');
  const missingLabel = devices.some((device) => device.kind === 'audioinput' && !device.label);
  if (hasInput && missingLabel) {
    try {
      const stream = await media.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      devices = await media.enumerateDevices();
    } catch (error) {
      console.warn('[micMix] microphone permission failed', error);
      throw new Error('没有麦克风权限：请在 Windows 设置里允许 Zilux2 使用麦克风');
    }
  }

  const seen = new Set<string>();
  const result: MicrophoneDevice[] = [];
  for (const device of devices) {
    if (device.kind !== 'audioinput') continue;
    const id = device.deviceId;
    if (!id || id === 'default' || id === 'communications' || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: device.label || '未命名麦克风' });
  }
  return result;
}

interface ActiveMicMix {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  musicNode: AudioNode;
  musicGain: GainNode;
  micGain: GainNode;
  mix: GainNode;
  masterGain: GainNode;
  limiter: DynamicsCompressorNode;
  destination: MediaStreamAudioDestinationNode;
  player: HTMLAudioElement;
}

let active: ActiveMicMix | null = null;

export function micMixRunning(): boolean {
  return active !== null;
}

/** 启动混音。outputDeviceId 必须是播放端的虚拟线（如 CABLE Input）。 */
export async function startMicMix(config: MicMixConfig): Promise<void> {
  stopMicMix();
  if (!config.outputDeviceId) {
    throw new Error('没有选择虚拟音频线输出（CABLE Input）');
  }

  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    throw new Error('当前环境不支持麦克风采集');
  }

  const context = ensureAppAudioGraph();
  const musicNode = appMusicOutputNode();
  if (!context || !musicNode) {
    throw new Error('播放器音频还没准备好，请先播放一首歌再开启混音');
  }
  const tap = audioTapState();
  host.log('info', `[micMix] graph running=${tap.running} localVolume=${tap.localVolume.toFixed(3)} localGain=${tap.localGain.toFixed(3)} state=${tap.context}`);

  await context.resume();

  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let musicGain: GainNode | null = null;
  let micGain: GainNode | null = null;
  let mix: GainNode | null = null;
  let masterGain: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let player: HTMLAudioElement | null = null;

  try {
    stream = await media.getUserMedia({
      audio: {
        ...(config.micDeviceId ? { deviceId: { exact: config.micDeviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    source = context.createMediaStreamSource(stream);
    musicGain = context.createGain();
    musicGain.gain.value = clampGain(config.musicGain);
    micGain = context.createGain();
    micGain.gain.value = clampGain(config.micGain);
    mix = context.createGain();
    mix.gain.value = 1;
    masterGain = context.createGain();
    masterGain.gain.value = clampOutputGain(config.outputGain);
    // 末级限幅：总增益拉高后防止削波，正常电平几乎不压缩。
    limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    destination = context.createMediaStreamDestination();

    musicNode.connect(musicGain);
    musicGain.connect(mix);
    source.connect(micGain);
    micGain.connect(mix);
    mix.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(destination);

    player = document.createElement('audio');
    player.autoplay = true;
    player.setAttribute('playsinline', '');
    player.style.display = 'none';
    player.srcObject = destination.stream;
    player.volume = 1;
    document.body.append(player);

    const sink = player as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof sink.setSinkId !== 'function') {
      throw new Error('当前环境不支持把音频送到指定播放设备');
    }
    // CABLE Input 的 Windows 端点音量经常只有 20–50%；先拉满，页面总增益才有意义。
    postMessage({ v: 1, type: 'audioMix', action: 'setEndpointVolume', deviceId: config.outputDeviceId, deviceName: config.outputLabel, volume: 1 });
    await sink.setSinkId(config.outputDeviceId);
    await player.play();

    active = { stream, source, musicNode, musicGain, micGain, mix, masterGain, limiter, destination, player };
    player = null;
    stream = null;
    source = null;
    musicGain = null;
    micGain = null;
    mix = null;
    masterGain = null;
    limiter = null;
    destination = null;
  } finally {
    // 启动失败时把半成品全部拆掉，避免麦克风一直开着。
    if (player || stream) {
      try {
        player?.pause();
        player?.remove();
      } catch {
        // ignore
      }
      stream?.getTracks().forEach((track) => track.stop());
      try {
        if (musicGain) musicNode.disconnect(musicGain);
      } catch {
        // ignore
      }
      [musicGain, micGain, mix, masterGain, limiter, destination, source].forEach((node) => {
        try {
          node?.disconnect();
        } catch {
          // ignore
        }
      });
      if (active) stopMicMix();
    }
  }
}

export function stopMicMix(): void {
  const current = active;
  if (!current) return;
  active = null;
  try {
    current.player.pause();
    current.player.srcObject = null;
    current.player.remove();
  } catch {
    // ignore
  }
  try {
    current.musicNode.disconnect(current.musicGain);
  } catch {
    // ignore
  }
  try {
    current.musicGain.disconnect();
    current.micGain.disconnect();
    current.mix.disconnect();
    current.masterGain.disconnect();
    current.limiter.disconnect();
    current.destination.disconnect();
    current.source.disconnect();
  } catch {
    // ignore
  }
  current.stream.getTracks().forEach((track) => track.stop());
}

export function updateMicMixGains(musicGain: number, micGain: number, outputGain = 1.5): void {
  if (!active) return;
  active.musicGain.gain.value = clampGain(musicGain);
  active.micGain.gain.value = clampGain(micGain);
  active.masterGain.gain.value = clampOutputGain(outputGain);
}

/** 往虚拟麦克风里发 1 秒提示音，用来验证 CABLE 链路是否真的通。 */
export function playMicMixTestTone(): boolean {
  if (!active) return false;
  const context = active.mix.context;
  if (!(context instanceof AudioContext)) return false;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 1000;
  gain.gain.value = 0.12;
  oscillator.connect(gain);
  gain.connect(active.mix);
  const now = context.currentTime;
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
  oscillator.start(now);
  oscillator.stop(now + 1.2);
  oscillator.onended = () => {
    try {
      oscillator.disconnect();
      gain.disconnect();
    } catch {
      // ignore
    }
  };
  return true;
}

export async function setMicMixOutput(deviceId: string): Promise<void> {
  if (!active) return;
  const sink = active.player as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sink.setSinkId !== 'function') {
    throw new Error('当前环境不支持切换输出设备');
  }
  await sink.setSinkId(deviceId);
}

/** 打开 VB-CABLE 官方下载页；由宿主用默认浏览器打开，避免 WebView2 拦截弹窗。 */
export function openCableDownload(): void {
  postMessage({ v: 1, type: 'audioMix', action: 'openCableDownload' });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => stopMicMix());
}
