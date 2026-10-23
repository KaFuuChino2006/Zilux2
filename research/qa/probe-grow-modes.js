(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleepFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const cellOf = (title) => [...document.querySelectorAll('.quick-cell')].find((c) => c.querySelector('.quick-cell-title')?.textContent === title);
  const btnOf = (title, label) => [...(cellOf(title)?.querySelectorAll('.quick-seg-btn') ?? [])].find((b) => b.textContent.trim() === label);
  const results = [];

  const sample = async (label, ms = 800) => {
    const el = document.querySelector('.lyric-line.is-active');
    if (!el) return { label, error: 'no active line' };
    const t0 = performance.now();
    let peak = 0;
    let peakFs = 0;
    let frames = 0;
    while (performance.now() - t0 < ms) {
      await sleepFrame();
      frames += 1;
      const g = parseFloat(el.style.getPropertyValue('--grow') || '0');
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (g > peak) peak = g;
      if (fs > peakFs) peakFs = fs;
    }
    return { label, peakGrow: +peak.toFixed(3), peakFont: +peakFs.toFixed(2), finalGrow: +parseFloat(el.style.getPropertyValue('--grow') || '0').toFixed(3), finalFont: +parseFloat(getComputedStyle(el).fontSize).toFixed(2), frames };
  };

  for (const label of ['柔和', '强烈', '关闭', '弹跳']) {
    const btn = btnOf('动效', label);
    if (!btn) { results.push({ label, error: 'button missing' }); continue; }
    const activeBefore = document.querySelector('.lyric-line.is-active');
    const activeBeforeText = activeBefore?.textContent?.slice(0, 12) ?? '';
    btn.click();
    await wait(30);
    const s = await sample(label, label === '强烈' ? 900 : 700);
    results.push({
      ...s,
      stored: localStorage.getItem('zilux2.lyricGrow'),
      thumbX: cellOf('动效')?.querySelector('.quick-seg-thumb')?.style.transform,
      onBtn: [...cellOf('动效').querySelectorAll('.quick-seg-btn.is-on')].map((b) => b.textContent.trim()),
      lineBefore: activeBeforeText,
      lineAfter: document.querySelector('.lyric-line.is-active')?.textContent?.slice(0, 12) ?? '',
    });
  }
  // 回到默认档位
  const bounce = btnOf('动效', '弹跳');
  if (bounce) { bounce.click(); await wait(60); }
  return results;
})()
