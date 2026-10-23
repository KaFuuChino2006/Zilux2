(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const cell = () => [...document.querySelectorAll('.quick-cell')].find((c) => c.querySelector('.quick-cell-title')?.textContent === '动效');
  const btn = (label) => [...cell().querySelectorAll('.quick-seg-btn')].find((b) => b.textContent.trim() === label);
  const out = [];
  for (const label of ['关闭', '柔和', '弹跳', '强烈']) {
    btn(label).click();
    await wait(20);
    const el = document.querySelector('.lyric-line.is-active');
    let peak = 0;
    let peakFs = 0;
    let baseFs = parseFloat(getComputedStyle(el).fontSize);
    const t0 = performance.now();
    while (performance.now() - t0 < 480) {
      await frame();
      const g = parseFloat(el.style.getPropertyValue('--grow') || '0');
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (g > peak) peak = g;
      if (fs > peakFs) peakFs = fs;
    }
    out.push({ label, stored: localStorage.getItem('zilux2.lyricGrow'), on: [...cell().querySelectorAll('.quick-seg-btn.is-on')].map((b) => b.textContent.trim()).join(','), peakGrow: +peak.toFixed(3), peakFont: +peakFs.toFixed(2), endFont: +parseFloat(getComputedStyle(el).fontSize).toFixed(2) });
    await wait(120);
  }
  btn('弹跳').click();
  await wait(60);
  return out;
})()
