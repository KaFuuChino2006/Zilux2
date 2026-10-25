/**
 * 本地曲目标签编辑弹窗。
 *
 * 形态复用现有 sheet / field / btn 视觉类（右侧滑出面板，结构与 app.ts `openSheet()` 一致），
 * 写入走宿主回环接口 POST /api/local/tag（与宿主 T2 已定稿的契约一致）：
 *   请求：扁平 `{ rel, title?, artist?, album?, albumArtist?, track?: number, year?: number }`
 *        字段省略 = 不修改该字段；空字符串 = 清空；null = 清空。
 *   响应 200：`{ok:true, fields:{…回读的有效值，未设置项为 null}}` 或 `{ok:false, error:"可展示文案"}`。
 *   400 / 404 / 401 沿用 LocalMusicServer.WriteError 约定（`{error,message}`，由 api() 抛 OnlineError）。
 *
 * 封面不提供编辑：宿主本阶段只写 Title/Artist/Album/AlbumArtist/TrackNumber/Year，不写封面。
 */

import { api, OnlineError } from '../online/client';
import type { OnlineTrack } from '../online/types';
import { h, icon, toast } from './dom';
import { relOf } from './local';

export interface TagFields {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  track: string;
  year: string;
}

/** 保存成功回调：fields 为提交值合并宿主回读值（未回读的字段沿用编辑值）。 */
export type TagSavedHandler = (fields: TagFields) => void;

interface TagWriteResponse {
  ok?: boolean;
  /** `{ok:false}` 时宿主给的可直接展示的业务失败文案。 */
  error?: string;
  message?: string;
  /** 写入后从 Windows Property System 回读的有效值。 */
  fields?: Partial<Record<keyof TagFields, string | number | null>> | null;
}

interface TagFieldDef {
  id: keyof TagFields;
  label: string;
  placeholder: string;
  maxLength: number;
  /** 数字字段（曲目号 / 年份）：提交 JSON number。 */
  numeric?: boolean;
  /** 用户清空时是否提交空字符串清空标签；未知原值的字段不提交，避免误清。 */
  clearable?: boolean;
}

const FIELD_DEFS: TagFieldDef[] = [
  { id: 'title', label: '标题', placeholder: '歌曲标题', maxLength: 200, clearable: true },
  { id: 'artist', label: '歌手', placeholder: '多位歌手可用 / 分隔', maxLength: 200, clearable: true },
  { id: 'album', label: '专辑', placeholder: '专辑名（留空 = 不修改）', maxLength: 200 },
  { id: 'albumArtist', label: '专辑歌手', placeholder: '专辑歌手（留空 = 不修改）', maxLength: 200 },
  { id: 'track', label: '曲目号', placeholder: '如 3（留空 = 不修改）', maxLength: 3, numeric: true },
  { id: 'year', label: '年份', placeholder: '如 2024（留空 = 不修改）', maxLength: 4, numeric: true },
];

const HINT_HTML =
  '写入由宿主调用 Windows 属性系统完成（Title / Artist / AlbumTitle / AlbumArtist / TrackNumber / Year）。' +
  'MP3 / FLAC / M4A / AAC 通常可写；DSF / APE / OGG / WMA / AIFF 等格式可能不支持，' +
  '文件只读、被占用或正在播放时会失败。' +
  '<br>留空表示不修改该字段；把已知的标题 / 歌手清空会写入空值。封面编辑暂不支持。';

const SAVE_LABEL = '写入标签';

/** 当前打开的编辑器（同一时间只保留一个）。 */
let activeClose: (() => void) | null = null;

/** 文件名开头的编号（如「04. 歌名」）猜测曲目号；猜不到返回空串。 */
function guessTrackNumber(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const match = /^(\d{1,3})[\s._-]/.exec(name);
  if (!match) return '';
  const number = Number(match[1]);
  return number > 0 ? String(number) : '';
}

function readFields(inputs: Map<keyof TagFields, HTMLInputElement>): TagFields {
  const fields: TagFields = {
    title: '',
    artist: '',
    album: '',
    albumArtist: '',
    track: '',
    year: '',
  };
  for (const def of FIELD_DEFS) {
    fields[def.id] = (inputs.get(def.id)?.value ?? '').trim();
  }
  return fields;
}

/** 返回错误提示文案；通过返回 null。 */
function validateFields(fields: TagFields): string | null {
  if (fields.title.length > 200) return '标题过长（最多 200 字）';
  if (fields.artist.length > 200) return '歌手过长（最多 200 字）';
  if (fields.album.length > 200) return '专辑名过长（最多 200 字）';
  if (fields.albumArtist.length > 200) return '专辑歌手过长（最多 200 字）';
  if (fields.track && !/^[1-9]\d{0,2}$/.test(fields.track)) return '曲目号需为 1–999 的数字';
  if (fields.year && !/^\d{4}$/.test(fields.year)) return '年份需为 4 位数字（如 2024）';
  return null;
}

/** 只提交改动过的字段：省略 = 不修改；clearable 字段清空时提交空串清空标签。 */
function buildPayload(
  rel: string,
  fields: TagFields,
  initial: TagFields,
): Record<string, string | number | null> {
  const payload: Record<string, string | number | null> = { rel };
  for (const def of FIELD_DEFS) {
    const next = fields[def.id];
    if (next === initial[def.id]) continue;
    if (next === '') {
      if (def.clearable) payload[def.id] = '';
      continue;
    }
    payload[def.id] = def.numeric ? Number(next) : next;
  }
  return payload;
}

/** 宿主回读值合并进编辑值（null / 缺失表示该属性未写入或不支持回读，沿用编辑值）。 */
function mergeWrittenFields(
  fields: TagFields,
  written: TagWriteResponse['fields'],
): TagFields {
  const merged: TagFields = { ...fields };
  if (!written || typeof written !== 'object') return merged;
  for (const def of FIELD_DEFS) {
    const value = written[def.id];
    if (typeof value === 'string') merged[def.id] = value.trim();
    else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      merged[def.id] = String(Math.round(value));
    }
  }
  return merged;
}

function tagErrorMessage(err: unknown): string {
  if (err instanceof OnlineError) {
    switch (err.code) {
      case 'not-ready':
        return '宿主尚未就绪，暂时无法写入标签';
      case 'mock-unsupported':
        return '演示模式不支持写入标签';
      case 'timeout':
        return '标签写入超时，请稍后重试';
      case 'unauthorized':
        return '宿主鉴权失败，请重启 Zilux2 后再试';
      case 'not-found':
        return '找不到该文件，可能已被移动或删除';
      case 'network':
        return '无法连接宿主，请确认 Zilux2 正在运行';
      default:
        return `标签写入失败：${err.message}`;
    }
  }
  if (err instanceof Error && err.message) return `标签写入失败：${err.message}`;
  return '标签写入失败，请稍后重试';
}

/**
 * 打开本地曲目标签编辑器。
 * @param track    source='local' 的曲目（须由 ui/local.ts 的 trackOf()/歌单解析生成，才能拿到 rel）
 * @param onSaved  写入成功后回调；Lead 可据此刷新列表（宿主通常也会推送本地曲库刷新）
 */
export function openTagEditor(track: OnlineTrack, onSaved?: TagSavedHandler): void {
  const rel = track.source === 'local' ? relOf(track) : null;
  if (track.source !== 'local' || !rel) {
    toast('只能编辑本地歌曲的标签', 'error');
    return;
  }

  // 已开着编辑器时先关掉上一个（不进动画，直接替换）。
  activeClose?.();
  activeClose = null;

  const initial: TagFields = {
    title: track.title.trim(),
    artist: track.artist.trim(),
    album: track.album.trim(),
    albumArtist: '',
    track: guessTrackNumber(rel),
    year: '',
  };

  const inputs = new Map<keyof TagFields, HTMLInputElement>();
  const form = h('div', { class: 'tag-editor-form', 'data-qa': 'tag-editor-form' });
  for (const def of FIELD_DEFS) {
    const input = h('input', {
      class: 'tag-input',
      type: 'text',
      value: initial[def.id],
      placeholder: def.placeholder,
      maxlength: def.maxLength,
      autocomplete: 'off',
      spellcheck: 'false',
      inputmode: def.numeric ? 'numeric' : 'text',
      'data-qa': `tag-input-${def.id}`,
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void save();
      }
    });
    inputs.set(def.id, input);
    form.append(
      h(
        'label',
        { class: 'field is-stacked tag-editor-field', 'data-qa': `tag-field-${def.id}` },
        h('span', { class: 'field-label', text: def.label }),
        input,
      ),
    );
  }

  const closeBtn = h(
    'button',
    { class: 'icon-btn', type: 'button', title: '关闭', 'data-qa': 'tag-editor-close' },
    icon('close', 16),
  );
  const cancelBtn = h('button', {
    class: 'btn',
    type: 'button',
    'data-qa': 'tag-editor-cancel',
    text: '取消',
  });
  const saveBtn = h('button', {
    class: 'btn is-primary',
    type: 'button',
    'data-qa': 'tag-editor-save',
    text: SAVE_LABEL,
  });

  const body = h(
    'div',
    { class: 'sheet-body' },
    form,
    h('div', { class: 'tag-editor-hint', 'data-qa': 'tag-editor-hint', html: HINT_HTML }),
    h('div', { class: 'tag-editor-foot' }, cancelBtn, saveBtn),
  );

  const panel = h(
    'div',
    { class: 'sheet-panel', 'data-qa': 'tag-editor-panel' },
    h(
      'div',
      { class: 'sheet-head' },
      h(
        'div',
        { class: 'tag-editor-headtext' },
        h('div', { class: 'sheet-title', text: '编辑标签' }),
        h('div', {
          class: 'tag-editor-file',
          title: rel,
          'data-qa': 'tag-editor-file',
          text: `文件：${rel}`,
        }),
      ),
      closeBtn,
    ),
    body,
  );

  const root = h(
    'div',
    { class: 'sheet tag-editor-sheet', 'data-qa': 'tag-editor' },
    panel,
  );

  let closed = false;
  let saving = false;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // 捕获阶段拦截：避免 main.ts 的全局 Escape 把背后打开的其他弹层一起关掉。
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    saving = false;
    window.removeEventListener('keydown', onKey, true);
    if (activeClose === close) activeClose = null;
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 220);
  };

  const save = async (): Promise<void> => {
    if (saving || closed) return;
    const fields = readFields(inputs);
    const invalid = validateFields(fields);
    if (invalid) {
      toast(invalid, 'error');
      return;
    }
    const payload = buildPayload(rel, fields, initial);
    if (Object.keys(payload).length <= 1) {
      toast('没有需要写入的修改');
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = '写入中…';
    try {
      const response = await api<TagWriteResponse>('/api/local/tag', {}, 15_000, 'POST', payload);
      if (!response || response.ok !== true) {
        toast(response?.error || response?.message || '宿主未能写入标签', 'error');
        return;
      }
      const saved = mergeWrittenFields(fields, response.fields);
      toast('标签已保存');
      close();
      onSaved?.(saved);
    } catch (err) {
      toast(tagErrorMessage(err), 'error');
    } finally {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = SAVE_LABEL;
    }
  };

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', () => {
    void save();
  });
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close();
  });
  window.addEventListener('keydown', onKey, true);

  activeClose = close;
  document.body.append(root);
  window.setTimeout(() => {
    const titleInput = inputs.get('title');
    titleInput?.focus();
    titleInput?.select();
  }, 60);
}

/** 关闭当前标签编辑器（Lead 在整页切换/关闭弹层时可主动调用）。 */
export function closeTagEditor(): void {
  activeClose?.();
}
