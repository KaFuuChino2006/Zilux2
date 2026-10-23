/**
 * 与应用风格一致的确认弹窗：替代原生 window.confirm 的「系统对话框」观感。
 * 用法：const ok = await confirmDialog({ title, message, detail?, tone: 'danger' });
 */

import { h, icon } from './dom';

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'default' | 'danger';
  iconName?: string;
}

/** 打开一个居中确认框；确认返回 true，取消/ESC/点击遮罩返回 false。 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  const {
    title = '确认操作',
    message,
    detail,
    confirmText = '确定',
    cancelText = '取消',
    tone = 'danger',
    iconName = tone === 'danger' ? 'trash' : 'info',
  } = options;

  return new Promise<boolean>((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('is-closing');
      window.setTimeout(() => backdrop.remove(), 170);
      previousFocus?.focus({ preventScroll: true });
      resolve(value);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    };

    const iconWrap = h('div', { class: `ui-confirm-icon${tone === 'danger' ? ' is-danger' : ''}` });
    iconWrap.append(icon(iconName, 19));

    const cancelBtn = h('button', { class: 'ui-confirm-btn', type: 'button', text: cancelText });
    cancelBtn.addEventListener('click', () => finish(false));

    const confirmBtn = h('button', {
      class: `ui-confirm-btn is-primary${tone === 'danger' ? ' is-danger' : ''}`,
      type: 'button',
      text: confirmText,
    });
    confirmBtn.addEventListener('click', () => finish(true));

    const backdrop = h(
      'div',
      { class: 'ui-confirm-backdrop', role: 'presentation' },
      h(
        'div',
        { class: 'ui-confirm-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h(
          'div',
          { class: 'ui-confirm-head' },
          iconWrap,
          h('div', { class: 'ui-confirm-title', text: title }),
        ),
        h(
          'div',
          { class: 'ui-confirm-body' },
          h('div', { class: 'ui-confirm-message', text: message }),
          detail ? h('div', { class: 'ui-confirm-detail', text: detail }) : null,
        ),
        h('div', { class: 'ui-confirm-foot' }, cancelBtn, confirmBtn),
      ),
    );

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(false);
    });
    backdrop.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    window.requestAnimationFrame(() => backdrop.classList.add('is-in'));
    confirmBtn.focus({ preventScroll: true });
  });
}
