# -*- coding: utf-8 -*-
"""spaceShell：磁贴左右翻页箭头（点击翻页，磁贴翻转动画由 floatScene 负责）+ 页码状态。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 箭头图标常量
old = """/* 宿主窗口边条（6px）跟随页面主色的两个值：登录页 / 空间页 */"""
new = """const PAGE_PREV =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M12.4 4.6 7 10l5.4 5.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAGE_NEXT =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M7.6 4.6 13 10l-5.4 5.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* 宿主窗口边条（6px）跟随页面主色的两个值：登录页 / 空间页 */"""
assert s.count(old) == 1, 'chrome anchor missing'
s = s.replace(old, new, 1)

# 2) 模板插入翻页按钮（space-foot 前）
old = """    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>"""
new = """    <button class="space-page space-page-prev" data-page="-1" type="button" aria-label="上一页">
      ${PAGE_PREV}
    </button>
    <button class="space-page space-page-next" data-page="1" type="button" aria-label="下一页">
      ${PAGE_NEXT}
    </button>
    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>"""
assert s.count(old) == 1, 'space-foot anchor missing'
s = s.replace(old, new, 1)

# 3) 事件逻辑：插在 island 创建之前
old = """  let resizeTimer = 0;"""
new = """  function turnTiles(direction: number): void {
    if (!space) return;
    const ok = space.turnPage(direction);
    if (!ok) {
      showToast(direction > 0 ? '已经是最后一页' : '已经是第一页', 'info');
      return;
    }
    const info = space.pageInfo();
    setStatus(`我喜欢的音乐 · 第 ${info.page}/${info.total} 页 · 点击封面看详情`);
  }

  root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      turnTiles(Number(button.dataset.page));
    });
  });

  let resizeTimer = 0;"""
assert s.count(old) == 1, 'resize anchor missing'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('page arrows added')

# 4) CSS 追加
css_path = r'E:\Zilux2开发\web\src\styles\space.css'
css = io.open(css_path, 'r', encoding='utf-8', newline='').read()
if '.space-page' not in css:
    css += """
/* 磁贴翻页箭头（左右两侧玻璃圆钮，仅空间/磁贴视图显示） */
.space-page {
  position: fixed;
  top: 50%;
  width: 46px;
  height: 46px;
  border-radius: var(--r-pill);
  display: none;
  align-items: center;
  justify-content: center;
  color: #3b4459;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 8px 22px rgba(38, 50, 94, 0.14);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  transform: translateY(-50%);
  transition: background 160ms ease, transform 160ms ease, box-shadow 160ms ease;
  z-index: 5;
  cursor: pointer;
  padding: 0;
}
.space-page:hover {
  background: rgba(255, 255, 255, 0.92);
  transform: translateY(-50%) scale(1.06);
  box-shadow: 0 10px 26px rgba(38, 50, 94, 0.2);
}
.space-page:active {
  transform: translateY(-50%) scale(0.96);
}
.space-page-prev {
  left: 84px;
}
.space-page-next {
  right: 84px;
}
.is-entered .space-page {
  display: flex;
}
@media (max-width: 1100px) {
  .space-page-prev {
    left: 74px;
  }
  .space-page-next {
    right: 74px;
  }
}
"""
    io.open(css_path, 'w', encoding='utf-8', newline='').write(css)
    print('page arrow css added')
else:
    print('css already has .space-page')
