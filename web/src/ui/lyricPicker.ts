import { decryptQrc } from 'qrc-decoder';
import { fetchLyric, searchOnline } from '../online/client';
import { extractQrcPayload, parseCharLyric, parseLrc, parseQrcLyric } from '../online/lrc';
import { onlineArtwork } from '../online/artwork';
import { lyricSourceIds, sourceMeta } from '../online/sources';
import { SOURCE_LABEL, type OnlineLyric, type OnlineTrack } from '../online/types';
import { fmtTime, h, icon, toast } from './dom';
import { candidateQueries, metaMatchScore } from './lyricMatch';
import { applyManualLyric, clearManualLyric, currentLyricSource, manualLyricLabelOf } from './lyrics';
import { onPlayer, playerState, seek } from './player';

interface Candidate {
  track: OnlineTrack;
  score: number;
}

interface PreviewWord {
  text: string;
  startMs: number;
  endMs: number;
}

interface PreviewLine {
  timeMs: number;
  text: string;
  translation?: string;
  word: boolean;
  words?: PreviewWord[];
}

const PREVIEW_LINES = 14;

/** 把平台歌词负载转成预览行（带逐字标记）。 */
function previewLines(lyric: OnlineLyric): { lines: PreviewLine[]; word: boolean; translation: boolean } {
  const trimmed = (value: string | null | undefined): string => (value ?? '').trim();
  const translationLines = trimmed(lyric.translation) ? parseLrc(lyric.translation ?? '') : [];
  const pickTranslation = (timeMs: number): string | undefined =>
    translationLines.find((item) => Math.abs(item.timeMs - timeMs) <= 500)?.text;
  if (trimmed(lyric.qrc)) {
    try {
      const parsed = parseQrcLyric(extractQrcPayload(decryptQrc(lyric.qrc ?? '')));
      if (parsed.length > 0) {
        return {
          lines: parsed.slice(0, PREVIEW_LINES).map((line) => ({
            timeMs: line.timeMs,
            text: line.text ?? line.words.map((word) => word.text).join(''),
            translation: pickTranslation(line.timeMs),
            word: true,
            words: line.words.map((word) => ({
              text: word.text,
              startMs: word.startMs,
              endMs: word.endMs,
              spaceBefore: word.spaceBefore,
            })),
          })),
          word: true,
          translation: translationLines.length > 0,
        };
      }
    } catch {
      /* 解密失败就退回普通 LRC 预览 */
    }
  }
  if (trimmed(lyric.yrc)) {
    const parsed = parseCharLyric(lyric.yrc);
    if (parsed.length > 0) {
      return {
        lines: parsed.slice(0, PREVIEW_LINES).map((line) => ({
          timeMs: line.timeMs,
          text: line.text ?? line.chars.map((char) => char.text).join(''),
          translation: pickTranslation(line.timeMs),
          word: true,
          words: line.chars.map((char) => ({
            text: char.text,
            startMs: char.startMs,
            endMs: char.endMs,
            spaceBefore: char.spaceBefore,
          })),
        })),
        word: true,
        translation: translationLines.length > 0,
      };
    }
  }
  const base = parseLrc(lyric.lrc ?? '');
  return {
    lines: base.slice(0, PREVIEW_LINES).map((line) => ({
      timeMs: line.timeMs,
      text: line.text,
      translation: pickTranslation(line.timeMs),
      word: false,
    })),
    word: false,
    translation: translationLines.length > 0,
  };
}

function fmtPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** 打开「匹配歌词」窗口：自己搜、自己选哪份歌词。 */
export function openLyricPicker(track: OnlineTrack | null): void {
  if (!track) {
    toast('先播放一首歌再来匹配歌词');
    return;
  }
  document.querySelector('.lyric-picker')?.remove();

  let activeTab: string = track.source === 'local' ? (lyricSourceIds()[0] ?? '') : track.source;
  let candidates: Candidate[] = [];
  let selected: Candidate | null = null;
  let query = `${track.title} ${track.artist ?? ''}`.trim();
  let seq = 0;

  const tabs = h('div', { class: 'lp-tabs' });
  const input = h('input', { class: 'lp-input', type: 'search', placeholder: '搜索歌词…', value: query }) as HTMLInputElement;
  const searchBtn = h('button', { class: 'lp-search-btn' }, icon('search', 15), h('span', { text: '搜索' }));
  const list = h('div', { class: 'lp-list' });
  const status = h('div', { class: 'lp-status', text: '选择平台后点搜索，或直接看自动推荐结果' });
  const preview = h('div', { class: 'lp-preview' });
  let previewEls: Array<{ el: HTMLElement; timeMs: number; words: HTMLSpanElement[] }> = [];
  let previewTrack: HTMLElement | null = null;
  const progressFill = h('div', { class: 'lp-progress-fill' });
  const progressTrack = h('div', { class: 'lp-progress-track' }, progressFill);
  const progressCur = h('span', { class: 'lp-progress-time', text: '0:00' });
  const progressDur = h('span', { class: 'lp-progress-time', text: '0:00' });
  const progressRow = h(
    'div',
    { class: 'lp-progress' },
    progressCur,
    progressTrack,
    progressDur,
  );
  progressTrack.title = '点击可跳转播放位置';
  const syncPreviewProgress = (): void => {
    const state = playerState();
    const ratio = state.durationMs > 0 ? Math.min(1, Math.max(0, state.positionMs / state.durationMs)) : 0;
    progressFill.style.width = `${(ratio * 100).toFixed(2)}%`;
    progressCur.textContent = fmtTime(state.positionMs);
    progressDur.textContent = fmtTime(state.durationMs);
    let active = -1;
    for (let index = 0; index < previewEls.length; index += 1) {
      if ((previewEls[index]?.timeMs ?? 0) <= state.positionMs + 120) active = index;
      else break;
    }
    const positionMs = state.positionMs;
    previewEls.forEach((item, index) => {
      item.el.classList.toggle('is-active', index === active);
      item.el.classList.toggle('is-near', Math.abs(index - active) === 1);
      for (const span of item.words) {
        const start = Number(span.dataset.start ?? 0);
        const end = Number(span.dataset.end ?? 0);
        span.classList.toggle('is-sung', positionMs >= end);
        span.classList.toggle('is-hot', positionMs >= start && positionMs < end);
      }
    });
    const el = active >= 0 ? previewEls[active]?.el : undefined;
    if (el && previewTrack) {
      const offset = el.offsetTop + el.offsetHeight / 2;
      previewTrack.style.transform = `translateY(${-offset}px)`;
    }
  };
  progressTrack.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = progressTrack.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    seek(Math.round(ratio * playerState().durationMs));
  });
  const unsubscribePlayer = onPlayer(() => syncPreviewProgress());
  const saveBtn = h('button', { class: 'lp-btn is-primary', text: '使用这份歌词' }) as HTMLButtonElement;
  const autoBtn = h('button', { class: 'lp-btn', text: '恢复自动匹配' }) as HTMLButtonElement;
  const cancelBtn = h('button', { class: 'lp-btn', text: '取消' }) as HTMLButtonElement;
  saveBtn.disabled = true;

  let closing = false;
  // 预览进度用独立 rAF 驱动：不依赖播放状态推送的时机，打开期间始终跟着当前播放位置走。
  let rafId = 0;
  const progressLoop = (): void => {
    if (closing) return;
    syncPreviewProgress();
    rafId = window.requestAnimationFrame(progressLoop);
  };
  rafId = window.requestAnimationFrame(progressLoop);
  const close = (): void => {
    if (closing) return;
    closing = true;
    window.cancelAnimationFrame(rafId);
    root.classList.add('is-leaving');
    unsubscribePlayer();
    window.setTimeout(() => root.remove(), 170);
  };

  const renderTabs = (): void => {
    tabs.textContent = '';
    const items: Array<{ id: string; label: string }> = [
      { id: 'auto', label: '自动推荐' },
      ...lyricSourceIds().map((id) => ({ id, label: sourceMeta(id)?.label ?? SOURCE_LABEL[id] ?? id })),
    ];
    for (const item of items) {
      const button = h('button', {
        class: `lp-tab${activeTab === item.id ? ' is-on' : ''}`,
        text: item.label,
      });
      button.addEventListener('click', () => {
        if (activeTab === item.id) return;
        activeTab = item.id;
        renderTabs();
        void runSearch();
      });
      tabs.append(button);
    }
  };

  const renderList = (): void => {
    list.textContent = '';
    if (candidates.length === 0) {
      list.append(h('div', { class: 'lp-empty', text: '没有搜到结果，换个关键词试试' }));
      return;
    }
    for (const item of candidates) {
      const cover = h('img', { class: 'lp-item-cover', alt: '', src: onlineArtwork(item.track) });
      const badge = h('span', {
        class: `lp-score${item.score >= 0.8 ? ' is-high' : item.score >= 0.55 ? ' is-mid' : ''}`,
        text: fmtPercent(item.score),
        title: '按歌名 / 歌手 / 时长估算的匹配度，与歌词文本相似度无关',
      });
      const row = h(
        'button',
        { class: `lp-item${selected?.track.id === item.track.id && selected?.track.source === item.track.source ? ' is-on' : ''}` },
        cover,
        h(
          'div',
          { class: 'lp-item-body' },
          h(
            'div',
            { class: 'lp-item-line' },
            h('span', { class: 'lp-item-title', text: item.track.title }),
            item.track.vip ? h('span', { class: 'lp-vip', text: 'VIP' }) : null,
            badge,
          ),
          h('div', { class: 'lp-item-artist', text: item.track.artist ?? '' }),
        ),
        h('span', { class: 'lp-item-src', text: sourceMeta(item.track.source)?.short ?? '' }),
        h('span', { class: 'lp-item-check' }, icon('check', 15)),
      );
      row.addEventListener('click', () => {
        selected = item;
        saveBtn.disabled = false;
        renderList();
        void renderPreview(item);
      });
      list.append(row);
    }
  };

  const renderPreview = async (item: Candidate): Promise<void> => {
    preview.textContent = '';
    previewEls = [];
    const cover = h('img', { class: 'lp-preview-cover', alt: '', src: onlineArtwork(item.track) });
    preview.append(
      cover,
      h('div', { class: 'lp-preview-title', text: item.track.title }),
      h('div', { class: 'lp-preview-artist', text: item.track.artist ?? '' }),
      h('div', { class: 'lp-preview-meta', text: `${sourceMeta(item.track.source)?.label ?? item.track.source} · 匹配 ${fmtPercent(item.score)}` }),
    );
    const tags = h('div', { class: 'lp-preview-tags' });
    const lines = h('div', { class: 'lp-preview-lines' });
    const track = h('div', { class: 'lp-preview-track' });
    previewTrack = track;
    lines.append(track);
    preview.append(lines);
    track.append(h('div', { class: 'lp-preview-loading', text: '歌词加载中…' }));
    try {
      const lyric = await fetchLyric(item.track.source, item.track.id);
      const parsed = previewLines(lyric);
      track.textContent = '';
      if (parsed.lines.length === 0) {
        track.append(h('div', { class: 'lp-preview-loading', text: '这份歌词是空的' }));
        return;
      }
      tags.append(
        h('span', { class: `lp-chip${parsed.word ? ' is-on' : ''}`, text: parsed.word ? '逐字歌词' : '整行歌词' }),
        h('span', { class: `lp-chip${parsed.translation ? ' is-on' : ''}`, text: parsed.translation ? '带翻译' : '无翻译' }),
      );
      preview.insertBefore(tags, lines);
      for (const line of parsed.lines) {
        const wordEls: HTMLSpanElement[] = [];
        let textNode: HTMLElement;
        if (line.words && line.words.length > 0) {
          textNode = h('span', { class: 'lp-preview-text' });
          for (const word of line.words) {
            const span = h('span', { class: 'lp-word', text: word.text });
            span.dataset.start = String(word.startMs);
            span.dataset.end = String(word.endMs);
            textNode.append(span);
            wordEls.push(span);
          }
        } else {
          textNode = h('span', { class: 'lp-preview-text', text: line.text });
        }
        const lineEl = h(
            'div',
            { class: 'lp-preview-line' },
            h('span', { class: 'lp-preview-time', text: `${(line.timeMs / 1000).toFixed(1)}s` }),
            textNode,
            line.translation ? h('span', { class: 'lp-preview-trans', text: line.translation }) : null,
          );
        track.append(lineEl);
        previewEls.push({ el: lineEl, timeMs: line.timeMs, words: wordEls });
      }
      // 首帧定位：进入后立刻把当前行摆到中间，不留跳一下
      requestAnimationFrame(() => syncPreviewProgress());
    } catch {
      track.textContent = '';
      track.append(h('div', { class: 'lp-preview-loading', text: '歌词加载失败' }));
    }
  };

  const runSearch = async (): Promise<void> => {
    const token = ++seq;
    list.textContent = '';
    status.textContent = '搜索中…';
    let found: Candidate[] = [];
    try {
      if (activeTab === 'auto') {
        for (const source of lyricSourceIds()) {
          let result: OnlineTrack[] = [];
          for (const q of candidateQueries(track)) {
            try {
              result = (await searchOnline(source, q, 8)).tracks;
            } catch {
              result = [];
            }
            if (result.length > 0) break;
          }
          found.push(...result.map((item) => ({ track: item, score: metaMatchScore(track, item) })));
        }
        found = found.sort((a, b) => b.score - a.score).slice(0, 20);
      } else {
        let result: OnlineTrack[] = [];
        for (const q of candidateQueries(track)) {
          try {
            result = (await searchOnline(activeTab, q, 12)).tracks;
          } catch {
            result = [];
          }
          if (result.length > 0) break;
        }
        found = result.map((item) => ({ track: item, score: metaMatchScore(track, item) })).sort((a, b) => b.score - a.score);
      }
    } catch {
      found = [];
    }
    if (token !== seq) return;
    candidates = found;
    status.textContent = found.length > 0 ? `找到 ${found.length} 首，点一首看歌词预览` : '没有搜到结果';
    saveBtn.disabled = found.length === 0;
    renderList();
    if (found.length > 0) {
      selected = found[0] ?? null;
      saveBtn.disabled = found.length === 0;
      renderList();
      void renderPreview(found[0] as Candidate);
    }
  };

  const root = h('div', { class: 'sheet lyric-picker' });
  const panel = h('div', { class: 'sheet-panel lp-panel' });
  const head = h(
    'div',
    { class: 'sheet-head lp-head' },
    h('div', { class: 'lp-head-text' }, h('div', { class: 'sheet-title', text: '匹配歌词' }), h('div', { class: 'lp-head-song', text: track.title })),
    h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 16)),
  );
  head.lastElementChild?.addEventListener('click', close);
  const body = h(
    'div',
    { class: 'lp-body' },
    h(
      'div',
      { class: 'lp-left' },
      tabs,
      h('div', { class: 'lp-search-row' }, input, searchBtn),
      status,
      list,
    ),
    h('div', { class: 'lp-right' }, preview, progressRow),
  );
  const foot = h(
    'div',
    { class: 'lp-foot' },
    h('div', { class: 'lp-current', text: manualLyricLabelOf() ? `当前：手动选择 ${manualLyricLabelOf()}` : `当前：${currentLyricSource() || '自动'}` }),
    h('div', { class: 'lp-foot-actions' }, autoBtn, cancelBtn, saveBtn),
  );
  panel.append(head, body, foot);
  root.append(panel);

  searchBtn.addEventListener('click', () => {
    query = input.value.trim();
    void runSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      query = input.value.trim();
      void runSearch();
    }
  });
  cancelBtn.addEventListener('click', close);
  autoBtn.addEventListener('click', () => {
    clearManualLyric(track);
    toast('已恢复自动匹配歌词');
    close();
  });
  saveBtn.addEventListener('click', () => {
    const picked = selected;
    if (!picked) return;
    saveBtn.disabled = true;
    void applyManualLyric(track, picked.track.source, picked.track.id, SOURCE_LABEL[picked.track.source] ?? picked.track.source)
      .then((ok) => {
        if (!ok) {
          toast('这份歌词没有可用内容，换一份试试', 'error');
          saveBtn.disabled = false;
          return;
        }
        toast(`已切换到 ${SOURCE_LABEL[picked.track.source] ?? picked.track.source} 的歌词`);
        close();
      })
      .catch(() => {
        toast('应用歌词失败', 'error');
        saveBtn.disabled = false;
      });
  });
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close();
  });

  document.body.append(root);
  renderTabs();
  void runSearch();
}
