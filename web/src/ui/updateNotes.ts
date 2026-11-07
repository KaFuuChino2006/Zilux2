/**
 * 版本更新提示面板：发现新版本 / 新版本已下载 / 刚更新完，都复用这一块。
 *
 * 交互约定（按需求）：点空白处、按 Esc、点右上角 × 都能关掉，不需要非得点「确定」；
 * 底部的下载 / 立即安装只是可选项，关掉就等于「稍后」。
 */
import { h, icon } from './dom';

export type UpdateNotesKind = 'available' | 'downloaded' | 'installed';

export interface UpdateNotesOptions {
  kind: UpdateNotesKind;
  version: string;
  releaseName?: string;
  notes: string;
  /** 后台自动下载中：显示但不需要按钮。 */
  downloading?: boolean;
  /** 显示「不再提示 / 多少天内不再提示」选项（仅 available / downloaded）。 */
  allowSnooze?: boolean;
  /** 被动关闭（点空白 / Esc / × / 稍后）时回调；点下载、安装、知道了不算。 */
  onDismiss?: (choice: { ignore: boolean; days: number }) => void;
  onDownload?: () => void;
  onInstall?: () => void;
  onOpenRelease?: () => void;
}

let current: { root: HTMLElement; close: (passive?: boolean) => void } | null = null;

function renderNotes(container: HTMLElement, notes: string): void {
  const lines = notes.split(/\r?\n/);
  let rendered = 0;
  for (const raw of lines) {
    const text = raw.trimEnd();
    if (!text.trim()) {
      if (rendered > 0) container.append(h('div', { class: 'update-notes-gap' }));
      continue;
    }
    if (rendered >= 400) {
      container.append(h('div', { class: 'update-notes-line is-more', text: '…' }));
      break;
    }
    rendered += 1;
    if (/^#{1,6}\s+/.test(text)) {
      container.append(h('div', { class: 'update-notes-heading', text: text.replace(/^#{1,6}\s+/, '') }));
    } else if (/^[-*]\s+/.test(text)) {
      container.append(h('div', { class: 'update-notes-item', text: `• ${text.replace(/^[-*]\s+/, '')}` }));
    } else if (/^\d+[.)]\s+/.test(text)) {
      container.append(h('div', { class: 'update-notes-item', text }));
    } else {
      container.append(h('div', { class: 'update-notes-line', text }));
    }
  }
}

/** 关闭当前面板（如果有）。 */
export function closeUpdateNotes(): void {
  current?.close();
}

/**
 * 打开更新面板；同一个面板再次调用会替换内容。
 * 返回关闭函数。
 */
export function showUpdateNotes(options: UpdateNotesOptions): () => void {
  closeUpdateNotes();

  const versionLabel = options.version ? `v${options.version}` : '';
  const title =
    options.kind === 'available'
      ? `发现新版本${versionLabel ? ` ${versionLabel}` : ''}`
      : options.kind === 'downloaded'
        ? `新版本已就绪${versionLabel ? ` ${versionLabel}` : ''}`
        : `已更新到${versionLabel ? ` ${versionLabel}` : '新版本'}`;

  const notes = options.notes.trim();
  const notesHost = h('div', { class: 'update-notes-body' });
  if (notes) {
    renderNotes(notesHost, notes);
  } else {
    notesHost.append(h('div', { class: 'update-notes-empty', text: '这个版本没有附更新说明。' }));
  }

  const actions = h('div', { class: 'update-notes-actions' });
  if (options.kind === 'installed') {
    if (options.onOpenRelease) {
      const more = h('button', { class: 'btn is-quiet', type: 'button', text: '查看发布页' });
      more.addEventListener('click', () => options.onOpenRelease?.());
      actions.append(more);
    }
    const done = h('button', { class: 'btn', type: 'button', text: '知道了' });
    done.addEventListener('click', () => close());
    actions.append(done);
  } else if (options.kind === 'downloaded') {
    if (options.onInstall) {
      const later = h('button', { class: 'btn is-quiet', type: 'button', text: '稍后' });
      later.addEventListener('click', () => close(true));
      const install = h('button', { class: 'btn is-primary', type: 'button', text: '立即安装并重启' });
      install.addEventListener('click', () => {
        options.onInstall?.();
        close();
      });
      actions.append(later, install);
    }
  } else {
    if (options.onOpenRelease) {
      const more = h('button', { class: 'btn is-quiet', type: 'button', text: '查看发布页' });
      more.addEventListener('click', () => options.onOpenRelease?.());
      actions.append(more);
    }
    if (options.downloading) {
      actions.append(h('div', { class: 'update-notes-progress', text: '正在后台下载…' }));
    } else if (options.onDownload) {
      const later = h('button', { class: 'btn is-quiet', type: 'button', text: '稍后' });
      later.addEventListener('click', () => close(true));
      const download = h('button', { class: 'btn is-primary', type: 'button', text: '下载更新' });
      download.addEventListener('click', () => {
        options.onDownload?.();
        close();
      });
      actions.append(later, download);
    }
  }

  // 提醒选项：不再提示这个版本 / 关闭后 N 天内不再提示。
  let reminder: HTMLElement | null = null;
  let ignoreBox: HTMLInputElement | null = null;
  let daysSelect: HTMLSelectElement | null = null;
  if (options.allowSnooze && options.kind !== 'installed') {
    ignoreBox = h('input', { class: 'update-notes-checkbox', type: 'checkbox' }) as HTMLInputElement;
    daysSelect = h(
      'select',
      { class: 'update-notes-select', title: '关闭后多久内不再提示' },
      ...[1, 3, 7, 30].map((days) => h('option', { value: String(days), text: `${days} 天` })),
    ) as HTMLSelectElement;
    daysSelect.value = '3';
    ignoreBox.addEventListener('change', () => {
      daysSelect!.disabled = ignoreBox!.checked;
    });
    reminder = h(
      'div',
      { class: 'update-notes-remind' },
      h('label', { class: 'update-notes-check' }, ignoreBox, h('span', { text: '不再提示这个版本' })),
      h('label', { class: 'update-notes-days' }, h('span', { text: '关闭后' }), daysSelect, h('span', { text: '内不再提示' })),
    );
  }

  // 没有可选操作时整条底栏去掉，避免空条。
  if (!actions.childElementCount) actions.remove();

  const closeBtn = h('button', { class: 'icon-btn update-notes-close', title: '关闭' }, icon('close', 16));
  const panel = h(
    'div',
    { class: 'update-notes-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'update-notes-head' },
      h(
        'div',
        { class: 'update-notes-titles' },
        h('div', { class: 'update-notes-title', text: title }),
        options.releaseName && options.releaseName !== versionLabel
          ? h('div', { class: 'update-notes-subtitle', text: options.releaseName })
          : null,
      ),
      closeBtn,
    ),
    notesHost,
    reminder,
    actions,
  );
  const root = h('div', { class: 'update-notes-overlay' }, panel);

  const close = (passive = false): void => {
    if (current?.root !== root) return;
    if (passive && options.onDismiss) {
      options.onDismiss({ ignore: Boolean(ignoreBox?.checked), days: Number(daysSelect?.value) || 3 });
    }
    current = null;
    document.removeEventListener('keydown', onKey, true);
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 160);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  // 点空白处关闭（面板内部的点击不关）。
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close(true);
  });
  closeBtn.addEventListener('click', () => close(true));
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  current = { root, close };
  return close;
}
