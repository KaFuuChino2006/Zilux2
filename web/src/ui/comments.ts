/**
 * 评论 Sheet：发现页 / 播放条 / 右键菜单共用同一套评论渲染。
 *
 * 数据来自 `fetchComments`（宿主 `/api/discover/comments`，原生优先）；
 * 只负责「取数 → 组装 DOM → 加载更多」，打开 Sheet 由调用方负责。
 */

import {
  discoverCover,
  discoverErrorText,
  fetchComments,
  fmtCount,
  isLoginRequired,
  isUnsupported,
  type DiscoverComment,
} from '../online/discover';
import { SOURCE_LABEL } from '../online/types';
import { h, icon, toast } from './dom';
import { ui } from './theme';

/** 往 Sheet body 里渲染一整块评论区（首屏自动加载）。 */
export function buildCommentsPanel(body: HTMLDivElement, source: string, songId: string): void {
  const totalEl = h('span', { class: 'disc-total', text: '评论加载中…' });
  const head = h(
    'div',
    { class: 'disc-comments-head' },
    totalEl,
    h('span', { class: 'disc-src-label', text: SOURCE_LABEL[source] ?? source }),
  );
  const list = h('div', { class: 'disc-comments' });
  const more = h('div', { class: 'disc-more' });
  body.append(head, list, more);

  let offset = 0;
  let loading = false;
  let exhausted = false;
  const pageSize = 20;
  const seen = new Set<string>();
  const keyOf = (comment: DiscoverComment): string =>
    `${comment.user}\u0001${comment.content}\u0001${comment.time}`;

  const load = (): void => {
    if (loading || exhausted) return;
    loading = true;
    const current = more.querySelector('button');
    if (current) {
      current.disabled = true;
      current.textContent = '加载中…';
    }
    void (async () => {
      try {
        const data = await fetchComments(source, songId, offset, pageSize);
        // 按请求页长步进：首屏热评去重后返回条数可能少于 pageSize，
        // 若按返回条数步进，下一页会从中间开始、把看过的那几条再取回来。
        offset += pageSize;
        const fresh = data.comments.filter((comment) => !seen.has(keyOf(comment)));
        exhausted = !data.hasMore || data.comments.length === 0 || fresh.length === 0;
        totalEl.textContent = `共 ${fmtCount(data.total)} 条评论`;
        if (fresh.length === 0) {
          if (list.childElementCount === 0) list.append(emptyBox('还没有评论'));
        } else {
          for (const comment of fresh) {
            seen.add(keyOf(comment));
            list.append(commentNode(comment));
          }
        }
        more.textContent = '';
        if (!exhausted) {
          const btn = h('button', { class: ui.btn({ size: 'sm' }), type: 'button', text: '加载更多' });
          btn.addEventListener('click', () => load());
          more.append(btn);
        } else if (offset > 0) {
          more.append(h('div', { class: 'disc-foot-note', text: '已加载全部评论' }));
        }
      } catch (err) {
        if (isUnsupported(err)) {
          totalEl.textContent = '该平台暂不支持评论';
          toast('该平台暂不支持评论', 'error');
        } else {
          toast(discoverErrorText(err, '评论加载失败'), 'error');
          if (list.childElementCount === 0) list.append(errorBox(err));
        }
      } finally {
        loading = false;
      }
    })();
  };
  load();
}

function commentNode(comment: DiscoverComment): HTMLElement {
  const avatar = h('span', { class: 'disc-c-avatar' });
  const src = discoverCover(comment.avatar);
  if (src) {
    const img = h('img', { src, loading: 'lazy', alt: '' });
    img.addEventListener('error', () => {
      img.remove();
      avatar.append(icon('user', 16));
    });
    avatar.append(img);
  } else {
    avatar.append(icon('user', 16));
  }
  const head = h('div', { class: 'disc-c-head' }, h('span', { class: 'disc-c-user', text: comment.user }));
  if (comment.hot) head.append(h('span', { class: 'disc-hot', text: '热评' }));
  const time = formatCommentTime(comment.time);
  if (time) head.append(h('span', { class: 'disc-c-time', text: time }));
  return h(
    'div',
    { class: 'disc-comment' },
    avatar,
    h(
      'div',
      { class: 'disc-c-body' },
      head,
      h('p', { class: 'disc-c-text', text: comment.content }),
      h('div', { class: 'disc-c-foot' }, icon('heart', 12), h('span', { text: fmtCount(comment.liked) })),
    ),
  );
}

function emptyBox(title: string): HTMLElement {
  return h('div', { class: 'disc-empty' }, h('div', { class: 'disc-empty-title', text: title }));
}

function errorBox(err: unknown): HTMLElement {
  const title = isLoginRequired(err) ? '需要登录后查看评论' : discoverErrorText(err, '评论加载失败');
  return h('div', { class: 'disc-empty' }, h('div', { class: 'disc-empty-title', text: title }));
}

/** 评论时间：兼容时间戳秒/毫秒与已格式化的字符串。 */
function formatCommentTime(value: string): string {
  const text = (value || '').trim();
  if (!text) return '';
  if (/^\d{10}$/.test(text)) return shortDate(new Date(Number(text) * 1000));
  if (/^\d{13}$/.test(text)) return shortDate(new Date(Number(text)));
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

function shortDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}
