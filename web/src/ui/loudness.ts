/** 响度均衡 / 夜间模式的本地偏好（纯前端设置，存在 localStorage）。 */
const LOUDNESS_KEY = 'zilux2.audio.loudness';
const NIGHT_KEY = 'zilux2.audio.night';

export function loudnessEnabled(): boolean {
  return localStorage.getItem(LOUDNESS_KEY) !== '0';
}

export function setLoudnessEnabled(value: boolean): void {
  localStorage.setItem(LOUDNESS_KEY, value ? '1' : '0');
}

export function nightModeEnabled(): boolean {
  return localStorage.getItem(NIGHT_KEY) === '1';
}

export function setNightModeEnabled(value: boolean): void {
  localStorage.setItem(NIGHT_KEY, value ? '1' : '0');
}

/**
 * 按 LUFS 算一首歌的响度补偿（dB）。
 * 关掉响度均衡 / 没分析结果时返回 null，调用方据此不处理。
 * 夜间模式目标更低（-17 LUFS）并再压 2 dB。
 */
export function compensationDbFor(lufs: number | null | undefined): number | null {
  if (!loudnessEnabled()) return null;
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return null;
  const night = nightModeEnabled();
  const target = night ? -17 : -14;
  const db = Math.max(-9, Math.min(6, target - lufs)) + (night ? -2 : 0);
  return Math.round(db * 10) / 10;
}
