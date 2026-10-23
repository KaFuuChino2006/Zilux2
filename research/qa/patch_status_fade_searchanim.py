# -*- coding: utf-8 -*-
"""底部提示条自动渐隐 + 搜索栏宽度展开动画。"""
import io

SHELL = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"


def replace_once(text, old, new, label):
    assert text.count(old) == 1, (label, text.count(old))
    return text.replace(old, new, 1)


s = io.open(SHELL, "r", encoding="utf-8", newline="").read()

old_set = (
    "  function setStatus(text: string): void {\n"
    "    statusEl.textContent = text;\n"
    "  }"
)
new_set = (
    "  let statusFadeTimer = 0;\n"
    "  function setStatus(text: string): void {\n"
    "    statusEl.textContent = text;\n"
    "    statusEl.classList.remove('is-dim');\n"
    "    window.clearTimeout(statusFadeTimer);\n"
    "    statusFadeTimer = window.setTimeout(() => statusEl.classList.add('is-dim'), 2800);\n"
    "  }"
)
s = replace_once(s, old_set, new_set, "setStatus")
io.open(SHELL, "w", encoding="utf-8", newline="").write(s)
print("status auto fade wired")

c = io.open(CSS, "r", encoding="utf-8", newline="").read()

# 底部提示条渐隐
old_foot_anchor = ".space-foot {\n"
assert c.count(old_foot_anchor) == 1
c = c.replace(
    old_foot_anchor,
    ".space-foot {\n  transition: opacity 0.55s ease, transform 0.55s ease;\n",
    1,
)
# 追加 is-dim 状态（放在文件末尾，避免与既有规则顺序冲突）
c += """

/* 底部提示文案：几秒后自动渐隐，下一次 setStatus 时重新出现 */
.space-foot.is-dim {
  opacity: 0;
  transform: translate(-50%, 6px);
}

/* 搜索栏点击展开：宽度过渡（内容淡入见 space-search-in 动画） */
.space-searchbar {
  width: 138px;
  justify-content: flex-start;
  overflow: hidden;
  transition: width 0.3s cubic-bezier(0.22, 0.8, 0.28, 1), background 0.18s ease,
    box-shadow 0.18s ease;
}

.space-searchbar.is-open {
  width: min(598px, calc(100vw - 240px));
}
"""
io.open(CSS, "w", encoding="utf-8", newline="").write(c)
print("search bar width animation css")
