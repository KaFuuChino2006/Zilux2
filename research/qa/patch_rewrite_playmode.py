# -*- coding: utf-8 -*-
"""v1.3：播放模式（列表 / 单曲循环 / 随机）+ 播放条模式按钮。"""
import io

ROOT = r"E:\Zilux2开发\web\src"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def nl(text):
    return "\r\n" if "\r\n" in text else "\n"


# ---------------- dom.ts：repeat / repeatOne / shuffle 图标 ----------------
p = ROOT + r"\ui\dom.ts"
text = load(p)
E = nl(text)
old = "  list: '"
assert text.count(old) == 1
new = (
    "  repeat: '<path d=\"M7 7h10l-2.2-2.2M17 17H7l2.2 2.2\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/><path d=\"M17 7v3.2M7 17v-3.2\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>',\n"
    "  repeatOne: '<path d=\"M7 7h10l-2.2-2.2M17 17H7l2.2 2.2\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/><path d=\"M17 7v3.2M7 17v-3.2\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/><path d=\"M12 10v4.6\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>',\n"
    "  shuffle: '<path d=\"M5 7h3.2l7.6 10H19M19 7h-3.2L8.2 17H5\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/><path d=\"M17 4.6 19.4 7 17 9.4M17 14.6 19.4 17 17 19.4\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/>',\n"
    "  list: '"
)
text = text.replace(old, new.replace("\n", E))
save(p, text)
print("dom.ts OK")

# ---------------- player.ts：播放模式 ----------------
p = ROOT + r"\ui\player.ts"
text = load(p)
E = nl(text)


def rep(old, new, label):
    global text
    o = old.replace("\n", E)
    n = new.replace("\n", E)
    assert text.count(o) == 1, "anchor: " + label
    text = text.replace(o, n)


rep(
    "export interface PlayerState {",
    "export type PlayMode = 'list' | 'single' | 'shuffle';\n\nconst MODE_KEY = 'zilux2.playMode';\n\nfunction readMode(): PlayMode {\n  try {\n    const saved = localStorage.getItem(MODE_KEY);\n    if (saved === 'single' || saved === 'shuffle') return saved;\n  } catch {\n    /* 忽略 */\n  }\n  return 'list';\n}\n\nexport interface PlayerState {",
    "mode type",
)

rep(
    "  volume: number;\n  liked: boolean;\n}",
    "  volume: number;\n  liked: boolean;\n  /** 播放模式：列表 / 单曲循环 / 随机 */\n  mode: PlayMode;\n}",
    "state mode",
)

rep(
    "  volume: getSettings().playback.volume,\n  liked: false,\n};",
    "  volume: getSettings().playback.volume,\n  liked: false,\n  mode: readMode(),\n};",
    "state init",
)

rep(
    "function onEnded(): void {\n  next();\n}",
    "function onEnded(): void {\n  if (state.mode === 'single') {\n    seek(0);\n    void audio.play().catch(() => undefined);\n    return;\n  }\n  advance();\n}",
    "onEnded",
)

rep(
    "export function next(): void {\n  if (state.queue.length === 0) return;\n  const index = state.index + 1;\n  if (index >= state.queue.length) {\n    load(0, true);\n    return;\n  }\n  load(index, true);\n}",
    "function advance(): void {\n  if (state.queue.length === 0) return;\n  if (state.mode === 'shuffle' && state.queue.length > 1) {\n    let index = state.index;\n    while (index === state.index) index = Math.floor(Math.random() * state.queue.length);\n    load(index, true);\n    return;\n  }\n  const index = state.index + 1;\n  load(index >= state.queue.length ? 0 : index, true);\n}\n\n/** 下一首（单曲循环时也跳下一首）。 */\nexport function next(): void {\n  if (state.queue.length === 0) return;\n  if (state.mode === 'single' && state.queue.length > 1) {\n    const index = state.index + 1;\n    load(index >= state.queue.length ? 0 : index, true);\n    return;\n  }\n  advance();\n}\n\n/** 切换播放模式（列表 → 单曲循环 → 随机 → 列表）。 */\nexport function cycleMode(): PlayMode {\n  const order: PlayMode[] = ['list', 'single', 'shuffle'];\n  const nextMode = order[(order.indexOf(state.mode) + 1) % order.length];\n  try {\n    localStorage.setItem(MODE_KEY, nextMode);\n  } catch {\n    /* 忽略 */\n  }\n  setState({ mode: nextMode });\n  return nextMode;\n}",
    "next/advance/cycleMode",
)

rep(
    "export function prev(): void {\n  if (state.queue.length === 0) return;\n  if (positionMs() > 3000) {\n    seek(0);\n    return;\n  }\n  const index = state.index - 1;\n  load(index < 0 ? state.queue.length - 1 : index, true);\n}",
    "export function prev(): void {\n  if (state.queue.length === 0) return;\n  if (positionMs() > 3000) {\n    seek(0);\n    return;\n  }\n  if (state.mode === 'shuffle' && state.queue.length > 1) {\n    let index = state.index;\n    while (index === state.index) index = Math.floor(Math.random() * state.queue.length);\n    load(index, true);\n    return;\n  }\n  const index = state.index - 1;\n  load(index < 0 ? state.queue.length - 1 : index, true);\n}",
    "prev",
)

rep(
    "    durationMs: 0,\n    liked: false,\n  });\n  likeToken += 1;",
    "    durationMs: 0,\n    liked: false,\n  });\n  likeToken += 1;",
    "stop noop",
)

save(p, text)
print("player.ts OK")

# ---------------- app.ts：模式按钮 ----------------
p = ROOT + r"\ui\app.ts"
text = load(p)
E = nl(text)


def rep2(old, new, label):
    global text
    o = old.replace("\n", E)
    n = new.replace("\n", E)
    assert text.count(o) == 1, "anchor: " + label
    text = text.replace(o, n)


rep2(
    "  private pbLikeBtn!: HTMLButtonElement;",
    "  private pbLikeBtn!: HTMLButtonElement;\n  private pbModeBtn!: HTMLButtonElement;",
    "field",
)

rep2(
    "  toggleLiked,",
    "  toggleLiked,\n  cycleMode,",
    "import cycleMode",
)

rep2(
    "    this.pbLikeBtn = h('button', { class: 'pb-btn pb-like', title: '喜欢' }, icon('heart'));",
    "    this.pbModeBtn = h('button', { class: 'pb-btn pb-mode', title: '播放模式' }, icon('repeat'));\n    this.pbModeBtn.addEventListener('click', () => {\n      const mode = cycleMode();\n      toast(mode === 'list' ? '列表循环' : mode === 'single' ? '单曲循环' : '随机播放');\n    });\n\n    this.pbLikeBtn = h('button', { class: 'pb-btn pb-like', title: '喜欢' }, icon('heart'));",
    "mode button",
)

rep2(
    "        this.pbLikeBtn,\n        lyricsBtn,",
    "        this.pbModeBtn,\n        this.pbLikeBtn,\n        lyricsBtn,",
    "extra order",
)

rep2(
    "    this.pbLikeBtn.textContent = '';\n    this.pbLikeBtn.append(icon(state.liked ? 'heartFill' : 'heart'));\n    this.pbLikeBtn.classList.toggle('is-liked', state.liked);",
    "    this.pbLikeBtn.textContent = '';\n    this.pbLikeBtn.append(icon(state.liked ? 'heartFill' : 'heart'));\n    this.pbLikeBtn.classList.toggle('is-liked', state.liked);\n    this.pbModeBtn.textContent = '';\n    this.pbModeBtn.append(icon(state.mode === 'single' ? 'repeatOne' : state.mode === 'shuffle' ? 'shuffle' : 'repeat'));\n    this.pbModeBtn.title = state.mode === 'list' ? '列表循环（点击切换）' : state.mode === 'single' ? '单曲循环（点击切换）' : '随机播放（点击切换）';\n    this.pbModeBtn.classList.toggle('is-active', state.mode !== 'list');",
    "sync mode btn",
)

save(p, text)
print("app.ts OK")
