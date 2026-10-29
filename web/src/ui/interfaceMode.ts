/**
 * 首页界面模式：经典首页（默认）与「平面世界」MG 画布（第二种使用方式）。
 *
 * 两者互不影响：经典首页保留原来的左栏 + 信息流；平面世界是整块可拖动缩放的
 * 画布，在设置里切换。只持久化一个偏好值，不改变其它页面。
 */
export type InterfaceMode = 'classic' | 'mgplane';

/** 用户可见的模式选项（设置面板用）。 */
export const INTERFACE_MODE_OPTIONS: ReadonlyArray<{ value: InterfaceMode; label: string }> = [
  { value: 'classic', label: '经典首页' },
  { value: 'mgplane', label: '平面世界' },
];

const STORAGE_KEY = 'zilux2.interfaceMode';

/** 读取上次选择；缺省为经典首页，保证老用户无感升级。 */
export function readInterfaceMode(): InterfaceMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mgplane' ? 'mgplane' : 'classic';
  } catch {
    return 'classic';
  }
}

/** 保存选择（设置面板切换时调用）。 */
export function saveInterfaceMode(mode: InterfaceMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 忽略：本地存储不可用时仅本次会话生效 */
  }
}
