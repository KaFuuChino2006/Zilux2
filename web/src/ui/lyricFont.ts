/**
 * 全局歌词字体：一份设置供所有歌词效果共用，并可按语言覆盖。
 *
 * - DOM 歌词（播放效果=默认，含背景歌词窗口）通过根节点上的 --lyric-font / --lyric-font-<lang> 取字体；
 *   每个字/词会带 data-lang（zh/en/ja/ko），特定语言优先用该语言设定的字体。
 * - 画布歌词效果（纯字/房间/唱片/拼合/压力）按整首/整行文本判断主要语言，把该语言的字体插到内置字族栈最前面；
 *   flow 一首歌共用一个主题字体，因此取全曲主要语言对应的字体。
 *
 * 背景歌词是独立窗口：它也会 import 本模块，并通过 storage 事件跟上主窗口的改动。
 */

export const LYRIC_FONT_KEY = 'zilux2.lyricFont';
export const LYRIC_FONTS_KEY = 'zilux2.lyricFonts';

export type LyricFontLang = 'zh' | 'en' | 'ja' | 'ko';

export const LYRIC_FONT_LANGS: ReadonlyArray<{ id: LyricFontLang; label: string }> = [
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日文' },
  { id: 'ko', label: '韩文' },
  { id: 'en', label: '英文' },
];

type FontListener = (family: string, fonts: LyricFontOverrides) => void;

export type LyricFontOverrides = Partial<Record<LyricFontLang, string>>;

const listeners = new Set<FontListener>();

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z\u00c0-\u024f]/;

function normalizeFamily(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function readFamily(): string {
  try {
    return normalizeFamily(window.localStorage.getItem(LYRIC_FONT_KEY));
  } catch {
    return '';
  }
}

function readOverrides(): LyricFontOverrides {
  try {
    const raw = window.localStorage.getItem(LYRIC_FONTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: LyricFontOverrides = {};
    for (const { id } of LYRIC_FONT_LANGS) {
      const family = normalizeFamily(typeof parsed[id] === 'string' ? (parsed[id] as string) : '');
      if (family) result[id] = family;
    }
    return result;
  } catch {
    return {};
  }
}

let current: string = readFamily();
let overrides: LyricFontOverrides = readOverrides();

const quote = (family: string): string => `"${family.replace(/["\\]/g, '\\$&')}"`;

/** 判断一段文本主要属于哪种语言；无法判断时返回空串。 */
export function lyricLangOf(text: string): LyricFontLang | '' {
  if (!text) return '';
  // 假名/谚文优先于汉字：日文、韩文里常混有汉字。
  if (KANA.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (HAN.test(text)) return 'zh';
  if (LATIN.test(text)) return 'en';
  return '';
}

/** 一段文本里出现次数最多的语言（用于画布效果按行选字体）。 */
export function lyricDominantLang(text: string): LyricFontLang | '' {
  const counts: Record<LyricFontLang, number> = { zh: 0, en: 0, ja: 0, ko: 0 };
  for (const ch of Array.from(text)) {
    if (KANA.test(ch)) counts.ja += 1;
    else if (HANGUL.test(ch)) counts.ko += 1;
    else if (HAN.test(ch)) counts.zh += 1;
    else if (LATIN.test(ch)) counts.en += 1;
  }
  let best: LyricFontLang | '' = '';
  let max = 0;
  for (const id of ['zh', 'ja', 'ko', 'en'] as const) {
    if (counts[id] > max) {
      max = counts[id];
      best = id;
    }
  }
  return best;
}

/** 当前自定义歌词字体；空串表示跟随各效果自己的默认字体。 */
export function lyricFontFamily(): string {
  return current;
}

/** 所有按语言覆盖的字体。 */
export function lyricFontOverrides(): LyricFontOverrides {
  return { ...overrides };
}

/** 某个语言实际生效的字体：先看该语言覆盖，再看主字体。 */
export function lyricFontFamilyFor(lang: LyricFontLang | ''): string {
  return (lang && overrides[lang]) || current;
}

/** 把指定字体插到字族栈前面；family 为空时原样返回（用于选择器里预览还没应用的字体）。 */
export function lyricFontStackOf(family: string, fallback: string): string {
  return family ? `${quote(family)}, ${fallback}` : fallback;
}

/** 把自定义字体插到效果自带字族栈前面；没设置时原样返回。传入文本时按该语言优先。 */
export function lyricFontStack(fallback: string, text?: string): string {
  const lang = text ? lyricDominantLang(text) : '';
  return lyricFontStackOf(lyricFontFamilyFor(lang), fallback);
}

/** DOM 歌词的兜底字族：与 app.css 里 html,body 的默认字体保持一致。 */
const DOM_FALLBACK = 'Zilux2 Sans SC, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif';

/** 写到根节点：DOM 歌词的 CSS 用 var(--lyric-font) / var(--lyric-font-<lang>) 取。 */
export function applyLyricFontVar(): void {
  const root = document.documentElement;
  if (current) root.style.setProperty('--lyric-font', lyricFontStack(DOM_FALLBACK));
  else root.style.removeProperty('--lyric-font');
  for (const { id } of LYRIC_FONT_LANGS) {
    const family = overrides[id];
    if (family) root.style.setProperty(`--lyric-font-${id}`, quote(family));
    else root.style.removeProperty(`--lyric-font-${id}`);
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(current, { ...overrides });
    } catch (error) {
      console.warn('[lyrics] lyric font listener failed', error);
    }
  }
}

/** 修改自定义歌词字体；lang 为空改主字体，否则改该语言覆盖。歌词页开着时立即生效。 */
export function setLyricFontFamily(family: string, lang: LyricFontLang | '' = ''): void {
  const next = normalizeFamily(family);
  if (lang) {
    if ((overrides[lang] ?? '') === next) return;
    if (next) overrides = { ...overrides, [lang]: next };
    else {
      const copy = { ...overrides };
      delete copy[lang];
      overrides = copy;
    }
  } else {
    if (next === current) return;
    current = next;
  }
  try {
    if (current) window.localStorage.setItem(LYRIC_FONT_KEY, current);
    else window.localStorage.removeItem(LYRIC_FONT_KEY);
    if (Object.keys(overrides).length > 0) window.localStorage.setItem(LYRIC_FONTS_KEY, JSON.stringify(overrides));
    else window.localStorage.removeItem(LYRIC_FONTS_KEY);
  } catch {
    // ignore
  }
  applyLyricFontVar();
  notify();
}

/** 订阅字体变化（lyrics.ts 用它刷新已打开的画布效果）。 */
export function onLyricFont(listener: FontListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 从 localStorage 重新读一遍（背景歌词窗口收到跨窗口 storage 事件后调用）。 */
export function reloadLyricFont(): void {
  current = readFamily();
  overrides = readOverrides();
  applyLyricFontVar();
}

applyLyricFontVar();

window.addEventListener('storage', (event) => {
  if (event.key !== LYRIC_FONT_KEY && event.key !== LYRIC_FONTS_KEY && event.key !== null) return;
  current = readFamily();
  overrides = readOverrides();
  applyLyricFontVar();
  notify();
});
