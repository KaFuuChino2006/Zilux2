/**
 * 更新提示的「不再提示 / 多少天内不再提示」状态（localStorage）。
 *
 * - 忽略版本：只跳过这一个版本；出现更新的版本仍会提示。
 * - 稍后提醒：按时间整体静默，到点后恢复提示。
 * 两者都能在「设置 → 更新」里一键恢复。
 */
const IGNORED_KEY = 'zilux2.updateIgnoredVersion';
const SNOOZE_KEY = 'zilux2.updateSnoozeUntil';

export interface UpdateReminderState {
  ignoredVersion: string;
  snoozeUntil: number;
}

const read = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};

const write = (key: string, value: string): void => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* 存储不可用时只影响本次会话 */
  }
};

/** 被「不再提示」的版本号（不带 v）。 */
export function ignoredUpdateVersion(): string {
  return read(IGNORED_KEY).replace(/^v/i, '').trim();
}

/** 静默截止时间（毫秒时间戳）；0 表示没有设置。 */
export function updateSnoozeUntil(): number {
  const value = Number(read(SNOOZE_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function updateReminderState(): UpdateReminderState {
  return { ignoredVersion: ignoredUpdateVersion(), snoozeUntil: updateSnoozeUntil() };
}

/** 该版本现在是否应该弹更新提示。 */
export function shouldPromptUpdate(version: string, now = Date.now()): boolean {
  const normalized = version.replace(/^v/i, '').trim();
  if (!normalized) return true;
  if (ignoredUpdateVersion() === normalized) return false;
  return now >= updateSnoozeUntil();
}

/** 不再提示这个版本（直到出现更新的版本）。 */
export function ignoreUpdateVersion(version: string): void {
  write(IGNORED_KEY, version.replace(/^v/i, '').trim());
}

/** 多少天内不再提示任何更新。 */
export function snoozeUpdateReminder(days: number): void {
  const safeDays = Number.isFinite(days) ? Math.min(365, Math.max(1, Math.round(days))) : 3;
  write(SNOOZE_KEY, String(Date.now() + safeDays * 24 * 60 * 60 * 1000));
}

/** 清除两种「不再提示」状态，恢复默认提示。 */
export function clearUpdateReminders(): void {
  write(IGNORED_KEY, '');
  write(SNOOZE_KEY, '');
}
