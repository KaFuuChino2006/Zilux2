/**
 * 高级过渡调参窗（内部测试版）。
 *
 * 形态：跟随应用启动自动弹出的独立浮窗（可拖动、置顶于页面、记住位置与开关）。
 * 为什么不是系统级窗口：Zilux2 的界面跑在 WebView2 里，开真窗口要动 WPF 宿主；
 * 先把「参数全开放 + 即时生效」做到位。
 *
 * 交互约定：**全部是滑杆**（拖动即写 localStorage，下一次过渡立刻按新值走），
 * 右侧数字只是读数，不再需要输入框。
 */

import { handoffStatus } from '../core/advancedHandoff';
import { setLiveStemTrim } from '../core/stemsDeck';
import {
  MIX_ENGINE_HINTS,
  MIX_ENGINE_LABELS,
  MIX_ENGINE_ORDER,
  MIX_TEMPLATE_HINTS,
  MIX_TEMPLATE_LABELS,
  MIX_TEMPLATE_ORDER,
  MIX_TRANSITION_HINTS,
  MIX_TRANSITION_LABELS,
  MIX_TRANSITION_UI_ORDER,
  readMixTransitionEngine,
  readMixTransitionMode,
  readMixTransitionTemplate,
  writeMixTransitionEngine,
  writeMixTransitionMode,
  writeMixTransitionTemplate,
} from '../core/mixTransitionMode';
import {
  DEFAULT_TUNING,
  readTuning,
  resetTuning,
  writeTuning,
  type StartBars,
} from '../core/transitionTuning';

const POS_KEY = 'advancedPanelPos';
const STYLE_ID = 'advanced-panel-style';

let panel: HTMLElement | null = null;
let dragAbort: AbortController | null = null;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.adv-panel{position:fixed;z-index:9000;width:332px;max-height:calc(100vh - 60px);overflow:auto;
  background:rgba(18,18,20,.97);color:#e6e6e6;border:1px solid #3a3a3e;border-radius:10px;
  box-shadow:0 12px 40px rgba(0,0,0,.55);font:12px/1.45 system-ui,"Segoe UI",sans-serif}
.adv-panel header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;
  padding:7px 10px;cursor:move;border-bottom:1px solid #2f2f33;background:#232327;border-radius:10px 10px 0 0;z-index:1}
.adv-panel header b{font-size:12px;font-weight:600}
.adv-panel .x{cursor:pointer;padding:0 4px;color:#9aa0a6}
.adv-panel .x:hover{color:#fff}
.adv-panel .body{padding:8px 10px 10px}
.adv-sep{margin:9px 0 2px;color:#7d838a;font-size:10px;letter-spacing:.6px}
.adv-row{margin:5px 0}
.adv-row .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.adv-row .name{color:#b9bec4}
.adv-row .val{font-variant-numeric:tabular-nums;color:#6fb3ff}
.adv-row input[type=range]{width:100%;height:16px;margin:1px 0 0;accent-color:#3b82f6}
.adv-row select{width:100%;background:#16161a;color:#e6e6e6;border:1px solid #38383d;
  border-radius:6px;padding:3px 6px;font:inherit;margin-top:2px}
.adv-actions{display:flex;gap:8px;margin-top:10px}
.adv-actions button{flex:1;background:#2b2b31;color:#e6e6e6;border:1px solid #3d3d44;
  border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit}
.adv-actions button:hover{background:#34343b}
.adv-hint{color:#8b9199;margin-top:6px;font-size:11px}
.adv-status{margin-top:4px;padding:5px 6px;border-radius:6px;background:#14161a;border:1px solid #2c3036;font-size:11px}
.adv-status.ok{color:#5ee08a;border-color:#28583a}
.adv-status.bad{color:#ff9a8b;border-color:#5a2f2a}
.adv-refresh{margin-top:6px;width:100%;background:#2b2b31;color:#e6e6e6;border:1px solid #3d3d44;
  border-radius:6px;padding:4px;cursor:pointer;font:inherit}
`;
  document.head.append(style);
}

function readPos(): { left: number; top: number } {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { left?: number; top?: number };
      if (Number.isFinite(p.left) && Number.isFinite(p.top)) {
        return { left: Math.max(0, p.left as number), top: Math.max(0, p.top as number) };
      }
    }
  } catch {
    /* 忽略 */
  }
  return { left: Math.max(12, window.innerWidth - 360), top: 64 };
}

function savePos(el: HTMLElement): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop }));
  } catch {
    /* 忽略 */
  }
}

function sep(body: HTMLElement, text: string): void {
  const el = document.createElement('div');
  el.className = 'adv-sep';
  el.textContent = text;
  body.append(el);
}

function selectRow(
  label: string,
  options: readonly string[],
  labels: Record<string, string>,
  current: string,
  onChange: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'adv-row';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = label;
  const select = document.createElement('select');
  for (const value of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = labels[value] ?? value;
    if (value === current) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  row.append(name, select);
  return row;
}

interface SliderOptions {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

function sliderRow(options: SliderOptions): HTMLElement {
  const row = document.createElement('div');
  row.className = 'adv-row';
  const top = document.createElement('div');
  top.className = 'top';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = options.label;
  const val = document.createElement('span');
  val.className = 'val';
  const format = options.format ?? ((v: number) => String(Math.round(v * 100) / 100));
  val.textContent = format(options.value);
  top.append(name, val);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = format(v);
    options.onInput(v);
  });

  row.append(top, input);
  return row;
}

function buildPanel(): HTMLElement {
  ensureStyle();
  const tuning = readTuning();
  const wrap = document.createElement('section');
  wrap.className = 'adv-panel';
  const pos = readPos();
  wrap.style.left = `${pos.left}px`;
  wrap.style.top = `${pos.top}px`;

  const header = document.createElement('header');
  const title = document.createElement('b');
  title.textContent = '高级过渡 · 内部测试';
  const close = document.createElement('span');
  close.className = 'x';
  close.textContent = '✕';
  close.addEventListener('click', () => closePanel());
  header.append(title, close);
  wrap.append(header);

  const body = document.createElement('div');
  body.className = 'body';
  wrap.append(body);

  // —— 状态：这一次到底有没有走分轨换手，以及为什么 ——
  const status = document.createElement('div');
  const paintStatus = (): void => {
    const s = handoffStatus();
    const when = s.at ? new Date(s.at).toLocaleTimeString() : '—';
    status.className = `adv-status ${s.ok ? 'ok' : 'bad'}`;
    status.textContent = `${s.ok ? '✓ 已接管' : '× 未接管'}（${when}）：${s.reason}`;
  };
  paintStatus();
  body.append(status);
  const refresh = document.createElement('button');
  refresh.className = 'adv-refresh';
  refresh.textContent = '刷新状态';
  refresh.addEventListener('click', paintStatus);
  body.append(refresh);

  const hint = document.createElement('div');
  hint.className = 'adv-hint';
  hint.textContent = MIX_ENGINE_HINTS[readMixTransitionEngine()];

  sep(body, '全局');
  body.append(selectRow('引擎', MIX_ENGINE_ORDER, MIX_ENGINE_LABELS, readMixTransitionEngine(), (v) => {
    writeMixTransitionEngine(v as Parameters<typeof writeMixTransitionEngine>[0]);
    hint.textContent = MIX_ENGINE_HINTS[readMixTransitionEngine()];
  }));
  body.append(selectRow('模式', MIX_TRANSITION_UI_ORDER, MIX_TRANSITION_LABELS, readMixTransitionMode(), (v) => {
    writeMixTransitionMode(v as Parameters<typeof writeMixTransitionMode>[0]);
    hint.textContent = MIX_TRANSITION_HINTS[readMixTransitionMode()];
  }));
  body.append(selectRow('手法', MIX_TEMPLATE_ORDER, MIX_TEMPLATE_LABELS, readMixTransitionTemplate(), (v) => {
    writeMixTransitionTemplate(v as Parameters<typeof writeMixTransitionTemplate>[0]);
    hint.textContent = MIX_TEMPLATE_HINTS[readMixTransitionTemplate()];
  }));

  sep(body, '强制进阶');
  body.append(sliderRow({
    label: '忽略门控降级',
    value: tuning.forceAdvanced ? 1 : 0,
    min: 0,
    max: 1,
    step: 1,
    format: (v) => (v >= 1 ? '开（强制走进阶）' : '关（按置信度降级）'),
    onInput: (v) => writeTuning({ forceAdvanced: v >= 1 }),
  }));

  sep(body, '四轨电平（实时）');
  const gains = tuning.stemGains;
  for (const [key, label] of [['vocals', '人声'], ['other', '旋律'], ['bass', '低音'], ['drums', '鼓']] as const) {
    body.append(sliderRow({
      label,
      value: gains[key],
      min: 0,
      max: 1.5,
      step: 0.01,
      format: (v) => (v === 0 ? '切掉' : v === 1 ? '原样' : `${Math.round(v * 100)}%`),
      onInput: (v) => {
        const base = readTuning().stemGains;
        writeTuning({ stemGains: { ...base, [key]: v } });
        // 实时推拉：正在播的分轨立刻跟手（没有活动分轨时只记忆，下次起播按新值）。
        setLiveStemTrim(key, v);
      },
    }));
  }
  const gainsHint = document.createElement('div');
  gainsHint.className = 'adv-hint';
  gainsHint.textContent = '0 = 该轨整条切掉；1 = 原样；>1 推响（上限 150%）。普通播放仍只有 人声/伴奏 两路。';
  body.append(gainsHint);

  sep(body, '长度与换手时刻');
  body.append(sliderRow({
    label: '总小节数',
    value: tuning.bars,
    min: 0,
    max: 64,
    step: 1,
    format: (v) => (v === 0 ? '模板默认' : `${v} 小节`),
    onInput: (v) => writeTuning({ bars: Math.round(v) }),
  }));

  const startBase: StartBars = tuning.startBars ?? { drums: 2, bass: 0, other: 4, vocals: 8 };
  for (const [key, label] of [['bass', '低音进入'], ['drums', '鼓进入'], ['other', '旋律进入'], ['vocals', '人声进入']] as const) {
    body.append(sliderRow({
      label,
      value: startBase[key],
      min: 0,
      max: 32,
      step: 1,
      format: (v) => `第 ${Math.round(v)} 小节`,
      onInput: (v) => {
        const base = readTuning().startBars ?? { ...startBase };
        writeTuning({ startBars: { ...base, [key]: Math.round(v) } });
      },
    }));
  }

  sep(body, '回声甩尾');
  body.append(sliderRow({
    label: '反馈',
    value: tuning.echoFeedback,
    min: 0,
    max: 0.7,
    step: 0.01,
    onInput: (v) => writeTuning({ echoFeedback: v }),
  }));
  body.append(sliderRow({
    label: '阻尼',
    value: tuning.echoDampHz,
    min: 200,
    max: 12000,
    step: 100,
    format: (v) => `${(v / 1000).toFixed(1)} kHz`,
    onInput: (v) => writeTuning({ echoDampHz: v }),
  }));
  body.append(sliderRow({
    label: '拍分',
    value: tuning.echoDivision,
    min: 0.125,
    max: 1,
    step: 0.125,
    format: (v) => (v === 1 ? '1 拍' : `1/${Math.round(1 / v)} 拍`),
    onInput: (v) => writeTuning({ echoDivision: v }),
  }));

  sep(body, '滤波扫频（filterBuild）');
  body.append(sliderRow({
    label: '开门起点',
    value: tuning.filterFromHz,
    min: 20,
    max: 20000,
    step: 20,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`),
    onInput: (v) => writeTuning({ filterFromHz: v }),
  }));
  body.append(sliderRow({
    label: '开门终点',
    value: tuning.filterToHz,
    min: 20,
    max: 20000,
    step: 100,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`),
    onInput: (v) => writeTuning({ filterToHz: v }),
  }));

  body.append(hint);

  const actions = document.createElement('div');
  actions.className = 'adv-actions';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '恢复默认';
  resetBtn.addEventListener('click', () => {
    resetTuning();
    closePanel();
    openAdvancedPanel();
  });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => closePanel());
  actions.append(resetBtn, closeBtn);
  body.append(actions);

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  header.addEventListener('mousedown', (event) => {
    dragging = true;
    offsetX = event.clientX - wrap.offsetLeft;
    offsetY = event.clientY - wrap.offsetTop;
    event.preventDefault();
  });
  // 拖拽监听挂在 window 上，面板关掉必须一起撤，否则每开关一次就多两条监听器，
  // 而且它们闭包着 wrap —— 整个面板 DOM 都回收不掉。
  dragAbort?.abort();
  dragAbort = new AbortController();
  const dragSignal = dragAbort.signal;
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    wrap.style.left = `${Math.max(0, event.clientX - offsetX)}px`;
    wrap.style.top = `${Math.max(0, event.clientY - offsetY)}px`;
  }, { signal: dragSignal });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    savePos(wrap);
  }, { signal: dragSignal });

  // 过渡发生时能立刻在窗里看到原因：状态每 3 s 自动刷一次。
  const timer = window.setInterval(() => {
    if (!panel) {
      window.clearInterval(timer);
      return;
    }
    paintStatus();
  }, 3000);
  wrap.dataset.timer = String(timer);

  return wrap;
}

export function openAdvancedPanel(): void {
  closePanel();
  panel = buildPanel();
  document.body.append(panel);
  if (JSON.stringify(readTuning()) === JSON.stringify(DEFAULT_TUNING)) {
    // 默认值下没什么可提示的；保留这行是为了将来加「首次使用」引导。
  }
}

export function closePanel(): void {
  // 先撤 window 级拖拽监听，再摘 DOM：顺序反了会留下闭包住已移除节点的监听器。
  dragAbort?.abort();
  dragAbort = null;
  if (panel) {
    const timer = Number(panel.dataset.timer ?? 0);
    if (timer) window.clearInterval(timer);
    panel.remove();
    panel = null;
  }
}

export function toggleAdvancedPanel(): void {
  if (panel) closePanel();
  else openAdvancedPanel();
}

/** 应用启动时是否自动弹出（默认弹；置 localStorage.advancedPanelAuto='0' 可关）。 */
export function shouldAutoOpen(): boolean {
  return false;
}
