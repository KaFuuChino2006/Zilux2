/**
 * 界面模式：经典主界面 / 音乐地铁图。
 *
 * - 选择会写入 localStorage，应用启动时由 `main.ts` 读取并决定是否直接进入地铁图；
 * - 设置面板里切换时**立即生效**（热切换）：切到地铁图立刻打开覆盖层，切回经典立刻关闭；
 * - 关闭地铁图覆盖层视为切回经典界面，同步更新记忆，避免「看到的界面」与「记住的界面」不一致。
 */
export type InterfaceMode = 'classic' | 'metro';

export const INTERFACE_MODE_KEY = 'zilux2.interfaceMode';

/** 读取界面模式（存储不可用时退回经典界面）。 */
export function readInterfaceMode(): InterfaceMode {
  try {
    return localStorage.getItem(INTERFACE_MODE_KEY) === 'metro' ? 'metro' : 'classic';
  } catch {
    return 'classic';
  }
}

/** 记住界面模式。 */
export function writeInterfaceMode(mode: InterfaceMode): void {
  try {
    localStorage.setItem(INTERFACE_MODE_KEY, mode);
  } catch {
    /* 存储不可用时只在本次会话生效 */
  }
}
