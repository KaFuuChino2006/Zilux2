# -*- coding: utf-8 -*-
"""搜索栏：统一按钮样式 + 双平台（网易/QQ）搜索。"""
import io

SHELL = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"


def replace_once(text, old, new, label):
    assert text.count(old) == 1, (label, text.count(old))
    return text.replace(old, new, 1)


s = io.open(SHELL, "r", encoding="utf-8", newline="").read()

old_tpl = (
    '        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">'
    "${icon('search', 16)}<span>搜索</span></button>\n"
    "        <input class=\"space-search-input\" data-search-input type=\"search\" "
    "placeholder=\"搜索歌曲 / 歌手 / 专辑（网易云）\" autocomplete=\"off\" hidden />\n"
    "        <button class=\"space-search-go\" data-search-go type=\"button\" hidden>搜索</button>"
)
new_tpl = (
    '        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">'
    "${icon('search', 16)}<span>搜索</span></button>\n"
    "        <div class=\"space-search-src\" data-search-src hidden>\n"
    "          <button class=\"space-src-btn is-on\" data-search-source=\"netease\" type=\"button\">网易</button>\n"
    "          <button class=\"space-src-btn\" data-search-source=\"qq\" type=\"button\">QQ</button>\n"
    "        </div>\n"
    "        <input class=\"space-search-input\" data-search-input type=\"search\" "
    "placeholder=\"搜索歌曲 / 歌手 / 专辑\" autocomplete=\"off\" hidden />\n"
    "        <button class=\"space-search-go\" data-search-go type=\"button\" hidden>搜索</button>"
)
s = replace_once(s, old_tpl, new_tpl, "template")

old_ref = "  const searchGoBtn = root.querySelector<HTMLButtonElement>('[data-search-go]')!;"
new_ref = (
    "  const searchGoBtn = root.querySelector<HTMLButtonElement>('[data-search-go]')!;\n"
    "  const searchSrcEl = root.querySelector<HTMLElement>('[data-search-src]')!;\n"
    "  const searchSrcBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-search-source]'));"
)
s = replace_once(s, old_ref, new_ref, "refs")

if "let searchOpen = false;" in s:
    s = replace_once(
        s,
        "let searchOpen = false;",
        "let searchOpen = false;\n  let searchSource: MusicSource = 'netease';",
        "state",
    )
else:
    s = replace_once(
        s,
        "  function openSearch(): void {",
        "  let searchSource: MusicSource = 'netease';\n\n  function openSearch(): void {",
        "state-fallback",
    )

old_open = (
    "    searchInput.hidden = false;\n"
    "    searchGoBtn.hidden = false;\n"
    "    searchCancelBtn.hidden = false;"
)
new_open = old_open + "\n    searchSrcEl.hidden = false;"
s = replace_once(s, old_open, new_open, "open")

old_close = (
    "    searchInput.hidden = true;\n"
    "    searchGoBtn.hidden = true;\n"
    "    searchCancelBtn.hidden = true;\n"
    "    searchInput.value = '';"
)
new_close = (
    "    searchInput.hidden = true;\n"
    "    searchGoBtn.hidden = true;\n"
    "    searchCancelBtn.hidden = true;\n"
    "    searchSrcEl.hidden = true;\n"
    "    searchInput.value = '';"
)
s = replace_once(s, old_close, new_close, "close")

s = replace_once(
    s,
    "      const result = await searchOnline('netease', keyword, 30);",
    "      const result = await searchOnline(searchSource, keyword, 30);",
    "run",
)

old_status = "      setStatus(`搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);"
new_status = (
    "      const srcLabel = searchSource === 'qq' ? 'QQ 音乐' : '网易云音乐';\n"
    "      setStatus(`${srcLabel} 搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);"
)
s = replace_once(s, old_status, new_status, "status")

old_bind = "  topSearchBtn.addEventListener('click', () => openSearch());"
new_bind = (
    "  searchSrcBtns.forEach((btn) => {\n"
    "    btn.addEventListener('click', () => {\n"
    "      const source = btn.dataset.searchSource === 'qq' ? 'qq' : 'netease';\n"
    "      searchSource = source;\n"
    "      searchSrcBtns.forEach((item) => item.classList.toggle('is-on', item === btn));\n"
    "      searchInput.placeholder = source === 'qq' ? '搜索 QQ 音乐歌曲 / 歌手 / 专辑' : '搜索网易云歌曲 / 歌手 / 专辑';\n"
    "      searchInput.focus();\n"
    "    });\n"
    "  });\n"
    "  topSearchBtn.addEventListener('click', () => openSearch());"
)
s = replace_once(s, old_bind, new_bind, "bind")

io.open(SHELL, "w", encoding="utf-8", newline="").write(s)
print("search dual-source wired")

c = io.open(CSS, "r", encoding="utf-8", newline="").read()
old_go = (
    ".space-search-go {\n"
    "  height: 38px;\n"
    "  padding: 0 16px;\n"
    "  border-radius: 999px;\n"
    "  border: 0;\n"
    "  background: linear-gradient(135deg, #6a5cff, #3bb6f5);\n"
    "  color: #fff;\n"
    "  font-size: 13px;\n"
    "  cursor: pointer;\n"
    "}\n"
    ".space-search-go:hover {\n"
    "  filter: brightness(1.05);\n"
    "}"
)
new_go = (
    ".space-search-src {\n"
    "  display: flex;\n"
    "  align-items: center;\n"
    "  gap: 2px;\n"
    "  padding: 2px;\n"
    "  border-radius: 999px;\n"
    "  background: rgba(23, 26, 33, 0.05);\n"
    "}\n"
    ".space-src-btn {\n"
    "  height: 32px;\n"
    "  padding: 0 12px;\n"
    "  border: 0;\n"
    "  border-radius: 999px;\n"
    "  background: transparent;\n"
    "  color: #5d6470;\n"
    "  font-size: 12.5px;\n"
    "  font-weight: 500;\n"
    "  cursor: pointer;\n"
    "  transition: background 0.16s ease, color 0.16s ease;\n"
    "}\n"
    ".space-src-btn:hover {\n"
    "  background: rgba(255, 255, 255, 0.6);\n"
    "}\n"
    ".space-src-btn.is-on {\n"
    "  background: rgba(255, 255, 255, 0.92);\n"
    "  color: #171a21;\n"
    "  box-shadow: 0 2px 8px rgba(23, 26, 33, 0.08);\n"
    "}\n"
    "/* 与「返回登录」等按钮统一：白玻璃胶囊，不用品牌渐变蓝 */\n"
    ".space-search-go {\n"
    "  height: 38px;\n"
    "  padding: 0 16px;\n"
    "  border-radius: 999px;\n"
    "  border: 1px solid rgba(255, 255, 255, 0.85);\n"
    "  background: rgba(255, 255, 255, 0.92);\n"
    "  color: #171a21;\n"
    "  font-size: 13px;\n"
    "  font-weight: 500;\n"
    "  cursor: pointer;\n"
    "  box-shadow: 0 4px 12px rgba(23, 26, 33, 0.08);\n"
    "  transition: background 0.16s ease, transform 0.16s ease;\n"
    "}\n"
    ".space-search-go:hover {\n"
    "  background: #ffffff;\n"
    "  transform: translateY(-1px);\n"
    "}"
)
c = replace_once(c, old_go, new_go, "css-go")
io.open(CSS, "w", encoding="utf-8", newline="").write(c)
print("search css unified")
