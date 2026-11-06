/**
 * 播放效果「PV」的设置模型（只给 pvScene 用，不与几何设置混用）。
 *
 * 和上一版的差别：配色不再是「均匀换一套色」，而是 `arc` —— 按整首歌的进度走过五个幕
 * （墨蓝 → 白与卡 → 朱红 → 灰绿 → 黑白收尾），其余几项是可以钉死到某一幕的手动档。
 */

export type PvPalette = 'arc' | 'navy' | 'red' | 'sage' | 'mono';

export interface PvStyleSettings {
  /** 配色：跟歌走 / 墨蓝 / 朱红 / 灰绿 / 黑白 */
  palette: PvPalette;
  /** 渲染分辨率（1–2.5） */
  dpr: number;
  /** 字号倍率（0.7–1.4） */
  sizeScale: number;
  /** 故障强度（0–1.5）：撕裂错位与 RGB 分离的幅度 */
  glitch: number;
  /** 纸纹、颗粒与扫描线强度（0–1.5） */
  grain: number;
  /** 版面倾斜与手持抖动的强度（0–1.5）：0 是完全水平的静态版 */
  tilt: number;
  /** 图形转场强度（0–1.5）：0 时所有换句都是硬切 */
  transitions: number;
  /** 角落的页眉页脚小字（标题 / 时间码 / 页码） */
  showChrome: boolean;
  /** 是否显示译文小字 */
  showTranslation: boolean;
}

export const PV_SETTINGS_KEY = 'zilux2.pvStyle';

export const PV_PALETTE_LABELS: ReadonlyArray<{ id: PvPalette; label: string; hint: string }> = [
  { id: 'arc', label: '跟歌走', hint: '墨蓝 → 白与卡 → 朱红 → 灰绿 → 黑白收尾，按整首歌的进度换幕' },
  { id: 'navy', label: '墨蓝', hint: '整首停在墨蓝幕：深底浅字，只留一路朱红重音' },
  { id: 'red', label: '朱红', hint: '整首停在朱红幕：红底奶油字，情绪最长的一段' },
  { id: 'sage', label: '灰绿', hint: '整首停在灰绿幕：三栏报刊、细黑框、竖排小字' },
  { id: 'mono', label: '黑白', hint: '纯黑白灰，不带任何重音色' },
];

export const DEFAULT_PV_SETTINGS: PvStyleSettings = {
  palette: 'arc',
  dpr: 1.75,
  sizeScale: 1,
  glitch: 1,
  grain: 0.9,
  tilt: 1,
  transitions: 1,
  showChrome: true,
  showTranslation: true,
};

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 旧存档里已经下线过的配色名：尽量落在观感最接近的一幕上。 */
const LEGACY_PALETTE: Record<string, PvPalette> = {
  signal: 'arc',
  ink: 'red',
  classic: 'arc',
};

export function normalizePvSettings(input?: Partial<PvStyleSettings> | Record<string, unknown> | null): PvStyleSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawPalette = typeof raw.palette === 'string' ? raw.palette : '';
  const palette: PvPalette = PV_PALETTE_LABELS.some((item) => item.id === rawPalette)
    ? (rawPalette as PvPalette)
    : LEGACY_PALETTE[rawPalette] ?? DEFAULT_PV_SETTINGS.palette;
  return {
    palette,
    dpr: clamp(num(raw.dpr, DEFAULT_PV_SETTINGS.dpr), 1, 2.5),
    sizeScale: clamp(num(raw.sizeScale, DEFAULT_PV_SETTINGS.sizeScale), 0.7, 1.4),
    glitch: clamp(num(raw.glitch, DEFAULT_PV_SETTINGS.glitch), 0, 1.5),
    grain: clamp(num(raw.grain, DEFAULT_PV_SETTINGS.grain), 0, 1.5),
    tilt: clamp(num(raw.tilt, DEFAULT_PV_SETTINGS.tilt), 0, 1.5),
    transitions: clamp(num(raw.transitions, DEFAULT_PV_SETTINGS.transitions), 0, 1.5),
    showChrome: raw.showChrome !== false,
    showTranslation: raw.showTranslation !== false,
  };
}

export function pvStyleSettings(): PvStyleSettings {
  try {
    const stored = localStorage.getItem(PV_SETTINGS_KEY);
    if (!stored) return { ...DEFAULT_PV_SETTINGS };
    return normalizePvSettings(JSON.parse(stored) as Partial<PvStyleSettings>);
  } catch {
    return { ...DEFAULT_PV_SETTINGS };
  }
}

export function savePvStyleSettings(next: Partial<PvStyleSettings>): PvStyleSettings {
  const merged = normalizePvSettings({ ...pvStyleSettings(), ...next });
  try {
    localStorage.setItem(PV_SETTINGS_KEY, JSON.stringify(merged));
  } catch {
    /* 存不了就只在本帧生效 */
  }
  return merged;
}
