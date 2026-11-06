/**
 * 设置 → 存储 → 缓存：本机 localStorage 缓存的统计、上限与自动收缩。
 *
 * 为什么不用 Settings：宿主的 settings schema 固定（core/settings.ts 的 SettingsPatch 只接受
 * general / appearance / playback / shortcuts / downloads / updates 六段），新增 storage 段会让
 * 宿主与 Web 双侧校验不一致。缓存上限属于「这台机器上的前端偏好」，与 metronome / 页面背景
 * 的偏好一样存 localStorage，刷新后仍然生效。
 *
 * 只统计 settingsIO 里声明的可重建缓存键，不碰设置、主题、歌词偏移、搜索历史与自定义 EQ 预设。
 */

import { LOCAL_CACHE_KEYS, LOCAL_CACHE_PREFIXES } from './settingsIO';

export const CACHE_LIMIT_KEY = 'zilux2.cacheLimitMb';
export const CACHE_LIMIT_MIN_MB = 128;
export const CACHE_LIMIT_MAX_MB = 16384;
export const CACHE_LIMIT_STEP_MB = 1;
export const DEFAULT_CACHE_LIMIT_MB = 512;

/** 这些键代表用户主动选择（自定义背景图 / 本地曲库目录），自动收缩时不删，只允许手动清空。 */
const AUTO_TRIM_PROTECTED = new Set(['zilux2.appBgImage', 'zilux2.localFolder']);

export interface LocalCacheEntry {
  key: string;
  label: string;
  bytes: number;
}

export interface LocalCacheUsage {
  /** 估算字节数（localStorage 以 UTF-16 保存，按 2 字节/字符计）。 */
  bytes: number;
  entries: LocalCacheEntry[];
  available: boolean;
}

const LABELS = new Map<string, string>(LOCAL_CACHE_KEYS.map((item) => [item.key, item.label]));

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function byteSize(key: string, value: string): number {
  // 键与值都按 UTF-16 计；额外加一点结构开销，让展示值更接近浏览器配额占用。
  return (key.length + value.length) * 2 + 16;
}

function isCacheKey(key: string): boolean {
  if (LABELS.has(key)) return true;
  return LOCAL_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function labelOf(key: string): string {
  const known = LABELS.get(key);
  if (known) return known;
  const prefix = LOCAL_CACHE_PREFIXES.find((item) => key.startsWith(item));
  return prefix ? `实验功能缓存（${key.slice(prefix.length)}）` : key;
}

/** 当前缓存占用；localStorage 不可用时 available=false。 */
export function measureLocalCache(): LocalCacheUsage {
  const store = storage();
  if (!store) return { bytes: 0, entries: [], available: false };
  const entries: LocalCacheEntry[] = [];
  let bytes = 0;
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key || !isCacheKey(key)) continue;
      const value = store.getItem(key) ?? '';
      const size = byteSize(key, value);
      bytes += size;
      entries.push({ key, label: labelOf(key), bytes: size });
    }
  } catch (error) {
    console.warn('[cacheSettings] 读取本地缓存占用失败', error);
    return { bytes: 0, entries: [], available: false };
  }
  entries.sort((left, right) => right.bytes - left.bytes);
  return { bytes, entries, available: true };
}

export function clampCacheLimit(mb: number): number {
  if (!Number.isFinite(mb)) return DEFAULT_CACHE_LIMIT_MB;
  // 只夹到宿主支持的范围，不再按步进取整：用户输入 5000 就应保存 5000。
  return Math.min(CACHE_LIMIT_MAX_MB, Math.max(CACHE_LIMIT_MIN_MB, Math.round(mb)));
}

export function readCacheLimitMb(): number {
  const store = storage();
  if (!store) return DEFAULT_CACHE_LIMIT_MB;
  try {
    const raw = Number(store.getItem(CACHE_LIMIT_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampCacheLimit(raw) : DEFAULT_CACHE_LIMIT_MB;
  } catch {
    return DEFAULT_CACHE_LIMIT_MB;
  }
}

export function writeCacheLimitMb(mb: number): number {
  const next = clampCacheLimit(mb);
  const store = storage();
  if (!store) return next;
  try {
    store.setItem(CACHE_LIMIT_KEY, String(next));
  } catch (error) {
    console.warn('[cacheSettings] 保存缓存上限失败', error);
  }
  return next;
}

export interface EnforceCacheLimitResult {
  limitMb: number;
  beforeBytes: number;
  afterBytes: number;
  trimmed: string[];
}

/**
 * 超过上限时从最大的可重建缓存开始删，直到回到上限以内。
 * 只删纯缓存；自定义背景图与本地曲库目录即使很大也不会自动删（用户主动选择的资料）。
 */
export function enforceCacheLimit(limitMb = readCacheLimitMb()): EnforceCacheLimitResult {
  const usage = measureLocalCache();
  const limitBytes = limitMb * 1024 * 1024;
  const before = usage.bytes;
  if (!usage.available || before <= limitBytes) {
    return { limitMb, beforeBytes: before, afterBytes: before, trimmed: [] };
  }
  const store = storage();
  const trimmed: string[] = [];
  let current = before;
  if (store) {
    for (const entry of usage.entries) {
      if (current <= limitBytes) break;
      if (AUTO_TRIM_PROTECTED.has(entry.key)) continue;
      try {
        store.removeItem(entry.key);
        current = Math.max(0, current - entry.bytes);
        trimmed.push(entry.key);
      } catch (error) {
        console.warn(`[cacheSettings] 收缩缓存 ${entry.key} 失败`, error);
      }
    }
  }
  return { limitMb, beforeBytes: before, afterBytes: measureLocalCache().bytes, trimmed };
}
