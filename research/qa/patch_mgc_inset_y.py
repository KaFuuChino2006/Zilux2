# -*- coding: utf-8 -*-
"""角标边距拆分为左右 / 上下两个可调项。"""
import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 模板：改名 + 新增上下边距
old = """              <div class="custom-field">
                <div class="custom-label"><span>角标边距</span><b data-mgc-inset-current>34px</b></div>
                <input class="custom-slider" data-mgc-inset type="range" min="12" max="140" step="2" value="34" aria-label="播放信息角标边距" />
                <p class="custom-tip">四角信息离屏幕边缘的距离（px）</p>
              </div>"""
new = """              <div class="custom-field">
                <div class="custom-label"><span>角标左右边距</span><b data-mgc-inset-current>34px</b></div>
                <input class="custom-slider" data-mgc-inset type="range" min="12" max="140" step="2" value="34" aria-label="播放信息角标左右边距" />
                <p class="custom-tip">四角信息离屏幕左右边缘的距离（px）</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>角标上下边距</span><b data-mgc-inset-y-current>78px</b></div>
                <input class="custom-slider" data-mgc-inset-y type="range" min="12" max="220" step="2" value="78" aria-label="播放信息角标上下边距" />
                <p class="custom-tip">四角信息离屏幕上/下边缘的距离（px）；下方自动额外留出播放条空间</p>
              </div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 默认值 / 解析
s = s.replace("    mgcInset: 34,", "    mgcInset: 34,\n    mgcInsetY: 78,", 1)
s = s.replace("        mgcInset?: unknown;", "        mgcInset?: unknown;\n        mgcInsetY?: unknown;", 1)
s = s.replace(
    """        mgcInset: Number.isFinite(Number(parsed.mgcInset))
          ? Math.min(140, Math.max(12, Math.round(Number(parsed.mgcInset))))
          : DEFAULT_CUSTOM.mgcInset,""",
    """        mgcInset: Number.isFinite(Number(parsed.mgcInset))
          ? Math.min(140, Math.max(12, Math.round(Number(parsed.mgcInset))))
          : DEFAULT_CUSTOM.mgcInset,
        mgcInsetY: Number.isFinite(Number(parsed.mgcInsetY))
          ? Math.min(220, Math.max(12, Math.round(Number(parsed.mgcInsetY))))
          : DEFAULT_CUSTOM.mgcInsetY,""",
    1,
)

# 3) 元素引用
old = "  const mgcInsetCurrent = root.querySelector<HTMLElement>('[data-mgc-inset-current]')!;"
assert s.count(old) == 1
s = s.replace(old, old + "\n  const mgcInsetYInput = root.querySelector<HTMLInputElement>('[data-mgc-inset-y]')!;\n  const mgcInsetYCurrent = root.querySelector<HTMLElement>('[data-mgc-inset-y-current]')!;", 1)

# 4) syncCustomUi
old = "    mgcInsetInput.value = String(custom.mgcInset);\n    mgcInsetCurrent.textContent = `${custom.mgcInset}px`;"
assert s.count(old) == 1
s = s.replace(old, old + "\n    mgcInsetYInput.value = String(custom.mgcInsetY);\n    mgcInsetYCurrent.textContent = `${custom.mgcInsetY}px`;", 1)

# 5) applyCustom：写两个 CSS 变量
old = "    root.style.setProperty('--mgc-inset', `${custom.mgcInset}px`);"
assert s.count(old) >= 1
s = s.replace(old, old + "\n    root.style.setProperty('--mgc-inset-y', `${custom.mgcInsetY}px`);", 1)

# 6) 监听
old = """  mgcInsetInput.addEventListener('input', () => {
    custom.mgcInset = Math.min(140, Math.max(12, Math.round(Number(mgcInsetInput.value) || 34)));
    mgcInsetCurrent.textContent = `${custom.mgcInset}px`;
    root.style.setProperty('--mgc-inset', `${custom.mgcInset}px`);
    persistCustom();
  });"""
assert s.count(old) == 1
s = s.replace(old, old + """
  mgcInsetYInput.addEventListener('input', () => {
    custom.mgcInsetY = Math.min(220, Math.max(12, Math.round(Number(mgcInsetYInput.value) || 78)));
    mgcInsetYCurrent.textContent = `${custom.mgcInsetY}px`;
    root.style.setProperty('--mgc-inset-y', `${custom.mgcInsetY}px`);
    persistCustom();
  });""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('vertical corner inset added')

c = r"E:\Zilux2开发\web\src\styles\space.css"
css = io.open(c, 'r', encoding='utf-8', newline='').read()
css = css.replace(".mg-corner-tl { top: 78px; left: var(--mgc-inset, 34px); }",
                  ".mg-corner-tl { top: var(--mgc-inset-y, 78px); left: var(--mgc-inset, 34px); }")
css = css.replace(".mg-corner-tr { top: 78px; right: var(--mgc-inset, 34px); text-align: right; align-items: flex-end; }",
                  ".mg-corner-tr { top: var(--mgc-inset-y, 78px); right: var(--mgc-inset, 34px); text-align: right; align-items: flex-end; }")
css = css.replace(".mg-corner-bl { bottom: calc(var(--mgc-inset, 34px) + 62px); left: var(--mgc-inset, 34px); }",
                  ".mg-corner-bl { bottom: calc(var(--mgc-inset-y, 78px) + 18px); left: var(--mgc-inset, 34px); }")
css = css.replace(".mg-corner-br { bottom: calc(var(--mgc-inset, 34px) + 62px); right: var(--mgc-inset, 34px); text-align: right; align-items: flex-end; }",
                  ".mg-corner-br { bottom: calc(var(--mgc-inset-y, 78px) + 18px); right: var(--mgc-inset, 34px); text-align: right; align-items: flex-end; }")
io.open(c, 'w', encoding='utf-8', newline='').write(css)
print('css vertical inset applied')
