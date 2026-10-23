# -*- coding: utf-8 -*-
"""搜索改为「点击搜索按钮后下方下拉面板」，不再横向撑开胶囊。"""
import io

SHELL = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"


def replace_once(text, old, new, label):
    assert text.count(old) == 1, (label, text.count(old))
    return text.replace(old, new, 1)


s = io.open(SHELL, "r", encoding="utf-8", newline="").read()

old_tpl = (
    '      <div class="space-searchbar" data-searchbar>\n'
    '        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">'
    "${icon('search', 16)}<span>搜索</span></button>\n"
    "        <div class=\"space-search-src\" data-search-src hidden>\n"
    "          <button class=\"space-src-btn is-on\" data-search-source=\"netease\" type=\"button\">网易</button>\n"
    "          <button class=\"space-src-btn\" data-search-source=\"qq\" type=\"button\">QQ</button>\n"
    "        </div>\n"
    "        <input class=\"space-search-input\" data-search-input type=\"search\" "
    "placeholder=\"搜索歌曲 / 歌手 / 专辑\" autocomplete=\"off\" hidden />\n"
    "        <button class=\"space-search-go\" data-search-go type=\"button\" hidden>搜索</button>\n"
    "        <button class=\"space-search-cancel\" data-search-cancel type=\"button\" aria-label=\"收起\" hidden>×</button>\n"
    "      </div>"
)
new_tpl = (
    '      <div class="space-searchbar" data-searchbar>\n'
    '        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">'
    "${icon('search', 16)}<span>搜索</span></button>\n"
    "      </div>\n"
    "      <div class=\"space-search-drop\" data-search-drop hidden>\n"
    "        <div class=\"space-search-row\">\n"
    "          <div class=\"space-search-src\" data-search-src>\n"
    "            <button class=\"space-src-btn is-on\" data-search-source=\"netease\" type=\"button\">网易</button>\n"
    "            <button class=\"space-src-btn\" data-search-source=\"qq\" type=\"button\">QQ</button>\n"
    "          </div>\n"
    "          <input class=\"space-search-input\" data-search-input type=\"search\" "
    "placeholder=\"搜索歌曲 / 歌手 / 专辑\" autocomplete=\"off\" />\n"
    "        </div>\n"
    "        <div class=\"space-search-actions\">\n"
    "          <button class=\"space-search-go\" data-search-go type=\"button\">搜索</button>\n"
    "          <button class=\"space-search-cancel\" data-search-cancel type=\"button\">取消</button>\n"
    "        </div>\n"
    "      </div>"
)
s = replace_once(s, old_tpl, new_tpl, "template")

old_ref = "  const searchSrcEl = root.querySelector<HTMLElement>('[data-search-src]')!;"
new_ref = (
    "  const searchSrcEl = root.querySelector<HTMLElement>('[data-search-src]')!;\n"
    "  const searchDrop = root.querySelector<HTMLElement>('[data-search-drop]')!;"
)
s = replace_once(s, old_ref, new_ref, "refs")

old_open = (
    "    searchOpen = true;\n"
    "    searchBar.classList.add('is-open');\n"
    "    topSearchBtn.hidden = true;\n"
    "    searchInput.hidden = false;\n"
    "    searchGoBtn.hidden = false;\n"
    "    searchCancelBtn.hidden = false;\n"
    "    searchSrcEl.hidden = false;\n"
    "    window.requestAnimationFrame(() => searchInput.focus());"
)
new_open = (
    "    searchOpen = true;\n"
    "    searchBar.classList.add('is-open');\n"
    "    searchDrop.hidden = false;\n"
    "    window.requestAnimationFrame(() => {\n"
    "      searchDrop.classList.add('is-on');\n"
    "      searchInput.focus();\n"
    "    });"
)
s = replace_once(s, old_open, new_open, "open")

old_close = (
    "    searchOpen = false;\n"
    "    searchBar.classList.remove('is-open');\n"
    "    topSearchBtn.hidden = false;\n"
    "    searchInput.hidden = true;\n"
    "    searchGoBtn.hidden = true;\n"
    "    searchCancelBtn.hidden = true;\n"
    "    searchSrcEl.hidden = true;\n"
    "    searchInput.value = '';"
)
new_close = (
    "    searchOpen = false;\n"
    "    searchBar.classList.remove('is-open');\n"
    "    searchDrop.classList.remove('is-on');\n"
    "    searchDrop.hidden = true;\n"
    "    searchInput.value = '';"
)
s = replace_once(s, old_close, new_close, "close")

# 顶部搜索按钮再次点击时收起
old_bind = "  topSearchBtn.addEventListener('click', () => openSearch());"
new_bind = (
    "  topSearchBtn.addEventListener('click', () => {\n"
    "    if (searchOpen) closeSearch();\n"
    "    else openSearch();\n"
    "  });"
)
s = replace_once(s, old_bind, new_bind, "toggle")

io.open(SHELL, "w", encoding="utf-8", newline="").write(s)
print("search dropdown wired")

c = io.open(CSS, "r", encoding="utf-8", newline="").read()
c += """

/* 搜索改为按钮下方的常规下拉面板 */
.space-searchbar {
  width: auto;
  overflow: visible;
  justify-content: center;
}

.space-search-drop {
  position: absolute;
  top: 58px;
  left: 50%;
  width: min(520px, calc(100vw - 120px));
  padding: 12px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(24px) saturate(150%);
  box-shadow: 0 18px 48px rgba(23, 26, 33, 0.16);
  display: flex;
  flex-direction: column;
  gap: 10px;
  opacity: 0;
  transform: translate(-50%, -8px);
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.22, 0.8, 0.28, 1);
  z-index: 8;
}

.space-search-drop.is-on {
  opacity: 1;
  transform: translate(-50%, 0);
}

.space-search-drop[hidden] {
  display: none;
}

.space-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.space-search-row .space-search-input {
  flex: 1;
  height: 40px;
  width: auto;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid rgba(23, 26, 33, 0.08);
  background: rgba(255, 255, 255, 0.9);
  font-size: 14px;
  color: #171a21;
  outline: none;
  animation: none;
}

.space-search-row .space-search-input:focus {
  border-color: rgba(106, 92, 255, 0.45);
  box-shadow: 0 0 0 3px rgba(106, 92, 255, 0.1);
}

.space-search-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.space-search-actions .space-search-go {
  height: 36px;
  padding: 0 20px;
}

.space-search-actions .space-search-cancel {
  height: 36px;
  width: auto;
  padding: 0 14px;
  font-size: 13px;
  color: #5d6470;
  border-radius: 999px;
}
"""
io.open(CSS, "w", encoding="utf-8", newline="").write(c)
print("search dropdown css appended")
