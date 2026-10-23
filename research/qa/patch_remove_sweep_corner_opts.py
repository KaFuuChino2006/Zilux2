# -*- coding: utf-8 -*-
"""删除『几何划过』功能 + 播放信息角标：位置可调、修复开关。"""
import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# ---------- 1) 删除『几何划过』面板块 ----------
start_marker = '              <div class="custom-field">\n                <div class="custom-label"><span>几何划过</span>'
end_marker = '              <div class="custom-field">\n                <div class="custom-label"><span>歌词布局</span>'
start = s.index(start_marker)
end = s.index(end_marker, start)
s = s[:start] + s[end:]

# ---------- 2) 删除元素引用 ----------
s = s.replace("  const lyricSweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-sweep]');\n", "", 1)
s = s.replace("  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;\n", "", 1)

# ---------- 3) 默认值 / 解析 / QA / applyCustom ----------
s = s.replace("    lyricSweep: true,\n", "", 1)
s = s.replace("        lyricSweep?: unknown;\n", "", 1)
s = s.replace("        lyricSweep: parsed.lyricSweep !== false,\n", "", 1)
old_qa = """  const qaLyricSweep = params.get('lyricsweep');
  if (qaLyricSweep === '0') custom.lyricSweep = false;
  if (qaLyricSweep === '1') custom.lyricSweep = true;
"""
assert s.count(old_qa) == 1
s = s.replace(old_qa, "", 1)
s = s.replace("    space?.setLyricSweepEnabled(custom.lyricSweep);\n", "", 1)

# ---------- 4) syncCustomUi 与事件监听 ----------
old_sync = """    lyricSweepBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.lyricSweep === 'on') === custom.lyricSweep);
    });
    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';
"""
assert s.count(old_sync) == 1
s = s.replace(old_sync, "", 1)
old_listen = """  lyricSweepBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.lyricSweep = button.dataset.lyricSweep === 'on';
      syncCustomUi();
      space?.setLyricSweepEnabled(custom.lyricSweep);
      persistCustom();
    });
  });
"""
assert s.count(old_listen) == 1
s = s.replace(old_listen, "", 1)

# ---------- 5) 新增「角标边距」滑块（模板，放在播放信息角标块之后） ----------
anchor = """                <p class="custom-tip">每换一句，画面出现随机角度的几何线条装饰并淡出（MG PV 感）</p>
              </div>"""
assert s.count(anchor) == 1
inset_field = """                <p class="custom-tip">开：歌词模式里显示四角播放信息；关：隐藏</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>角标边距</span><b data-mgc-inset-current>34px</b></div>
                <input class="custom-slider" data-mgc-inset type="range" min="12" max="140" step="2" value="34" aria-label="播放信息角标边距" />
                <p class="custom-tip">四角信息离屏幕边缘的距离（px）</p>
              </div>"""
s = s.replace(anchor, inset_field, 1)

# ---------- 6) 角标边距：默认值 / 解析 / 引用 / sync / 监听 / 应用 ----------
s = s.replace("    mgLines: true,", "    mgLines: true,\n    mgcInset: 34,", 1)
s = s.replace("        mgLines?: unknown;", "        mgLines?: unknown;\n        mgcInset?: unknown;", 1)
s = s.replace(
    "        mgLines: parsed.mgLines !== false,",
    "        mgLines: parsed.mgLines !== false,\n        mgcInset: Number.isFinite(Number(parsed.mgcInset))\n          ? Math.min(140, Math.max(12, Math.round(Number(parsed.mgcInset))))\n          : DEFAULT_CUSTOM.mgcInset,",
    1,
)
s = s.replace(
    "  const mgLinesCurrent = root.querySelector<HTMLElement>('[data-mg-lines-current]')!;",
    "  const mgLinesCurrent = root.querySelector<HTMLElement>('[data-mg-lines-current]')!;\n  const mgcInsetInput = root.querySelector<HTMLInputElement>('[data-mgc-inset]')!;\n  const mgcInsetCurrent = root.querySelector<HTMLElement>('[data-mgc-inset-current]')!;",
    1,
)
s = s.replace(
    "    mgLinesCurrent.textContent = custom.mgLines ? '开' : '关';",
    "    mgLinesCurrent.textContent = custom.mgLines ? '开' : '关';\n    mgcInsetInput.value = String(custom.mgcInset);\n    mgcInsetCurrent.textContent = `${custom.mgcInset}px`;",
    1,
)
# 应用样式变量（放在 applyCustom 里 mgCorners 同步附近）
old_apply = "    space?.setLyricMg(custom.mgSweep, custom.mgLines);\n    setMgCornersVisible(lyricsOpen);"
if s.count(old_apply) == 1:
    s = s.replace(
        old_apply,
        "    space?.setLyricMg(custom.mgSweep, custom.mgLines);\n    root.style.setProperty('--mgc-inset', `${custom.mgcInset}px`);\n    setMgCornersVisible(lyricsOpen);",
        1,
    )
else:
    old_apply2 = "    space?.setLyricMg(custom.mgSweep, custom.mgLines);"
    assert s.count(old_apply2) >= 1
    s = s.replace(
        old_apply2,
        "    space?.setLyricMg(custom.mgSweep, custom.mgLines);\n    root.style.setProperty('--mgc-inset', `${custom.mgcInset}px`);\n    setMgCornersVisible(lyricsOpen);",
        1,
    )

# 监听：插在 mgLines 监听块之后
old_mg = """  mgLinesBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.mgLines = button.dataset.mgLines === 'on';
      syncCustomUi();
      space?.setLyricMg(custom.mgSweep, custom.mgLines);
      persistCustom();
    });
  });"""
assert s.count(old_mg) == 1
s = s.replace(
    old_mg,
    """  mgLinesBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.mgLines = button.dataset.mgLines === 'on';
      syncCustomUi();
      space?.setLyricMg(custom.mgSweep, custom.mgLines);
      setMgCornersVisible(lyricsOpen);
      persistCustom();
    });
  });
  mgcInsetInput.addEventListener('input', () => {
    custom.mgcInset = Math.min(140, Math.max(12, Math.round(Number(mgcInsetInput.value) || 34)));
    mgcInsetCurrent.textContent = `${custom.mgcInset}px`;
    root.style.setProperty('--mgc-inset', `${custom.mgcInset}px`);
    persistCustom();
  });""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell patched: sweep removed, corner inset + toggle fix')

# ---------- CSS：角标位置用变量 ----------
c = r"E:\Zilux2开发\web\src\styles\space.css"
css = io.open(c, 'r', encoding='utf-8', newline='').read()
css = css.replace(
    ".mg-corner-tl { top: 78px; left: 34px; }",
    ".mg-corner-tl { top: 78px; left: var(--mgc-inset, 34px); }",
)
css = css.replace(
    ".mg-corner-tr { top: 78px; right: 34px; text-align: right; align-items: flex-end; }",
    ".mg-corner-tr { top: 78px; right: var(--mgc-inset, 34px); text-align: right; align-items: flex-end; }",
)
css = css.replace(
    ".mg-corner-bl { bottom: 96px; left: 34px; }",
    ".mg-corner-bl { bottom: calc(var(--mgc-inset, 34px) + 62px); left: var(--mgc-inset, 34px); }",
)
css = css.replace(
    ".mg-corner-br { bottom: 96px; right: 34px; text-align: right; align-items: flex-end; }",
    ".mg-corner-br { bottom: calc(var(--mgc-inset, 34px) + 62px); right: var(--mgc-inset, 34px); text-align: right; align-items: flex-end; }",
)
io.open(c, 'w', encoding='utf-8', newline='').write(css)
print('css patched: corner inset variable')
