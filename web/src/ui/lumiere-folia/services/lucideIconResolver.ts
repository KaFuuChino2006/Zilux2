// Zilux2 移植：folia 的 lucide-react 按需加载在这里降级成空实现。
// Zilux2 的主题不带 lyricsIcons（主题色来自封面/内置浅色主题），因此图标线稿保持关闭；
// 如果以后要给主题加图标，在 resolveLucideIcon 里接一份图片路径表即可。
import type { LucideIcon } from '../shims/lucide-react';

export type LucideIconStatus = 'loading' | 'ready' | 'missing';

export const loadLucideIcons = async (_names: readonly unknown[] | undefined): Promise<void> => {};

export const hasLucideIcon = async (_name: string): Promise<boolean> => false;

export const resolveLucideIcon = (_name: string | null | undefined): LucideIcon | null => null;

export const getLucideIconStatus = (_name: string | null | undefined): LucideIconStatus => 'missing';

export const resolveLucideIconNames = (_names: readonly string[] | undefined): string[] => [];

export const subscribeLucideIcons = (_listener: () => void): (() => void) => () => {};

export const getLucideIconRevision = (): number => 0;
