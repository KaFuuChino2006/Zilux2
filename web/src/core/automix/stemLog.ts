/**
 * 分轨试听的设置与记录（纯函数，localStorage 持久化）。
 *
 * 为什么要有记录：用户调完四轨增益后要能把「哪首歌、第几秒、怎么调的」贴回来校对，
 * 与原来的 `eqLog` 一样只是一份文本，不改任何音频状态。
 */

import type { StemName } from '../../audio/stemSolo';

export const STEM_GAIN_STORE_KEY = 'zilux2.dev.stemgains';
export const STEM_LOG_KEY = 'zilux2.dev.stemlog';
export const STEM_LOG_LIMIT = 240;

export type StemGains = Record<StemName, number>;

export interface StemLogEntry {
  at: string;
  track: string;
  posMs: number;
  phase: string;
  gains: StemGains;
  solo: StemName | null;
  /** 这一窗宿主给的四轨重建误差（dBFS，NaN = 旧缓存）。 */
  reconDbfs?: number;
  note?: string;
}

const STEM_KEYS: StemName[] = ['vocals', 'drums', 'bass', 'other'];
const GAIN_MIN = -48;
const GAIN_MAX = 6;

function clampGain(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, num));
}

export function normalizeStemGains(input: unknown): StemGains {
  const src = (input ?? {}) as Partial<Record<StemName, unknown>>;
  const out = { vocals: 0, drums: 0, bass: 0, other: 0 } as StemGains;
  for (const stem of STEM_KEYS) out[stem] = clampGain(src[stem], 0);
  return out;
}

export function readStemGains(): StemGains {
  try {
    const raw = localStorage.getItem(STEM_GAIN_STORE_KEY);
    return raw ? normalizeStemGains(JSON.parse(raw)) : normalizeStemGains(null);
  } catch {
    return normalizeStemGains(null);
  }
}

export function writeStemGains(gains: StemGains): void {
  try {
    localStorage.setItem(STEM_GAIN_STORE_KEY, JSON.stringify(normalizeStemGains(gains)));
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 归一化 + 严格校验：坏数据整条丢掉，不让浮层显示假记录。 */
export function normalizeStemLog(input: unknown): StemLogEntry[] {
  if (!Array.isArray(input)) return [];
  const out: StemLogEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<StemLogEntry>;
    const solo = entry.solo === 'vocals' || entry.solo === 'drums' || entry.solo === 'bass' || entry.solo === 'other'
      ? entry.solo
      : null;
    out.push({
      at: typeof entry.at === 'string' ? entry.at : new Date(0).toISOString(),
      track: typeof entry.track === 'string' ? entry.track : '',
      posMs: Number.isFinite(Number(entry.posMs)) ? Math.max(0, Math.round(Number(entry.posMs))) : 0,
      phase: typeof entry.phase === 'string' ? entry.phase : 'idle',
      gains: normalizeStemGains(entry.gains),
      solo,
      reconDbfs: Number.isFinite(Number(entry.reconDbfs)) ? Number(entry.reconDbfs) : undefined,
      note: typeof entry.note === 'string' && entry.note.length > 0 ? entry.note : undefined,
    });
  }
  return out.slice(-STEM_LOG_LIMIT);
}

export function readStemLog(): StemLogEntry[] {
  try {
    const raw = localStorage.getItem(STEM_LOG_KEY);
    return raw ? normalizeStemLog(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function pushStemLog(entry: StemLogEntry): StemLogEntry[] {
  const log = readStemLog();
  const last = log.at(-1);
  // 同一毫秒、同一首歌、同一位置：覆盖末条（拖滑杆时不要刷屏）
  if (last && last.at === entry.at && last.track === entry.track && last.posMs === entry.posMs) {
    log[log.length - 1] = entry;
  } else {
    log.push(entry);
  }
  const trimmed = log.slice(-STEM_LOG_LIMIT);
  try {
    localStorage.setItem(STEM_LOG_KEY, JSON.stringify(trimmed));
  } catch {
    /* 忽略 */
  }
  return trimmed;
}

export function clearStemLog(): void {
  try {
    localStorage.removeItem(STEM_LOG_KEY);
  } catch {
    /* 忽略 */
  }
}

function fmtPos(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fmtClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toTimeString().slice(0, 8);
}

/** 一条记录 → 一行文本：`01:05:09 马思唯 - House Music @95s [fading] 人声 -6.0 鼓 0.0 … 独听 贝斯 — 低频糊` */
export function formatStemLogLine(entry: StemLogEntry): string {
  const gains = (['vocals', 'drums', 'bass', 'other'] as StemName[])
    .map((stem) => `${stem === 'vocals' ? '人声' : stem === 'drums' ? '鼓' : stem === 'bass' ? '贝斯' : '其他'} ${entry.gains[stem].toFixed(1)}`)
    .join(' ');
  const solo = entry.solo ? ` 独听 ${entry.solo}` : '';
  const recon = Number.isFinite(entry.reconDbfs) && (entry.reconDbfs ?? 0) < 0
    ? ` 残差 ${Math.round(entry.reconDbfs as number)}dB`
    : '';
  const note = entry.note ? ` — ${entry.note}` : '';
  return `${fmtClock(entry.at)} ${entry.track || '(未知曲目)'} @${fmtPos(entry.posMs)} [${entry.phase}] ${gains}${solo}${recon}${note}`;
}

export function formatStemLog(log: StemLogEntry[]): string {
  return log.map(formatStemLogLine).join('\n');
}
