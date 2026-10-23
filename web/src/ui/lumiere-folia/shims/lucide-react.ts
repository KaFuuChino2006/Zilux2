// Zilux2 移植用 shim：只提供类型形状（图标解析见 services/lucideIconResolver.ts）
export interface LucideIcon {
  (props: Record<string, unknown>): unknown;
  render?: (props: Record<string, unknown>, ref: null) => unknown;
}

export type IconNode = readonly (readonly [string, Record<string, unknown>, unknown?])[];
