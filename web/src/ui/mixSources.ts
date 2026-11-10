/**
 * 「融合」显示的来源选择。
 *
 * null 表示用户还没手动选过：默认显示当前所有可用平台（保持旧行为）。
 * 显式保存数组后，只显示数组里仍然可用的平台；空数组表示全不选。
 */

export type MixKind = 'daily' | 'liked';

const KEYS: Record<MixKind, string> = {
  daily: 'zilux2.mixDailySources.v1',
  liked: 'zilux2.mixLikedSources.v1',
};

function read(kind: MixKind): string[] | null {
  try {
    const text = window.localStorage.getItem(KEYS[kind]);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasMixSelection(kind: MixKind): boolean {
  return read(kind) !== null;
}

/** 返回仍然可用、且被用户选中的平台；没有显式选择时返回全部可用平台。 */
export function resolveMixSources(kind: MixKind, available: readonly string[]): string[] {
  const stored = read(kind);
  if (stored === null) return available.slice();
  const selected = new Set(stored);
  const resolved = available.filter((source) => selected.has(source));
  if (available.length > 0 && resolved.length === available.length) {
    // 旧版本可能把「全选」存成了显式数组；视为默认全选，方便以后新平台自动加入。
    try {
      window.localStorage.removeItem(KEYS[kind]);
    } catch {
      // ignore
    }
  }

  return resolved;
}

export function saveMixSources(kind: MixKind, available: readonly string[], selected: readonly string[]): void {
  const selectedSet = new Set(selected);
  const normalized = available.filter((source) => selectedSet.has(source));
  try {
    if (normalized.length === available.length) {
      // 全选不写显式列表：以后新登录的平台会自动加入默认融合。
      window.localStorage.removeItem(KEYS[kind]);
      return;
    }

    window.localStorage.setItem(KEYS[kind], JSON.stringify(normalized));
  } catch {
    // localStorage 不可用时只影响本次选择持久化，不阻断页面。
  }
}

export function clearMixSelection(kind: MixKind): void {
  try {
    window.localStorage.removeItem(KEYS[kind]);
  } catch {
    // ignore
  }
}
