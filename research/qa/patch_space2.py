# -*- coding: utf-8 -*-
"""v1.11 spaceShell：小玻璃厚度滑块 + 把两平台自建歌单画到小玻璃里。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
shutil.copyfile(p, p + '.bak-v11')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, ('anchor not unique', old[:60], s.count(old))
    s = s.replace(old, new, count)


# 1) import 个人库
rep(
    "import { createLoginSpace, type LoginCardFace, type LoginSpaceHandle } from '../three/loginSpace';",
    "import { fetchLibraryOverview } from '../library';\nimport { createLoginSpace, type LoginCardFace, type LoginSpaceHandle } from '../three/loginSpace';",
)

# 2) 模板：小玻璃厚度滑块（放在玻璃厚度之后）
rep(
    """            <p class="custom-tip">厚玻璃的侧壁高度，小玻璃片会一起变厚</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>玻璃通透度</span><b data-transmission-value>94%</b></div>""",
    """            <p class="custom-tip">大玻璃板的侧壁高度</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>小玻璃厚度</span><b data-chip-thickness-value>0.14</b></div>
            <input class="custom-slider" data-chip-thickness type="range" min="0.06" max="0.50" step="0.01" value="0.14" aria-label="小玻璃厚度" />
            <p class="custom-tip">每片小玻璃的厚度；鼠标悬停时会轻微放大</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>玻璃通透度</span><b data-transmission-value>94%</b></div>""",
)

# 3) 元素引用
rep(
    """  const thicknessInput = root.querySelector<HTMLInputElement>('[data-thickness]')!;
  const thicknessValue = root.querySelector<HTMLElement>('[data-thickness-value]')!;""",
    """  const thicknessInput = root.querySelector<HTMLInputElement>('[data-thickness]')!;
  const thicknessValue = root.querySelector<HTMLElement>('[data-thickness-value]')!;
  const chipThicknessInput = root.querySelector<HTMLInputElement>('[data-chip-thickness]')!;
  const chipThicknessValue = root.querySelector<HTMLElement>('[data-chip-thickness-value]')!;""",
)

# 4) 默认值 + 读取 + 应用 + UI 同步
rep(
    "  const DEFAULT_CUSTOM = { thickness: 0.62, transmission: 0.94, image: null as string | null };",
    "  const DEFAULT_CUSTOM = { thickness: 0.62, chipThickness: 0.14, transmission: 0.94, image: null as string | null };",
)
rep(
    """      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      return { thickness, transmission, image };""",
    """      const chipThickness =
        typeof parsed.chipThickness === 'number' && Number.isFinite(parsed.chipThickness)
          ? Math.min(0.5, Math.max(0.06, parsed.chipThickness))
          : DEFAULT_CUSTOM.chipThickness;
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      return { thickness, chipThickness, transmission, image };""",
)
rep(
    """  const applyCustom = (): void => {
    space?.setGlassThickness(custom.thickness);""",
    """  const applyCustom = (): void => {
    space?.setGlassThickness(custom.thickness);
    space?.setChipThickness(custom.chipThickness);""",
)
rep(
    """    thicknessInput.value = custom.thickness.toFixed(2);
    thicknessValue.textContent = custom.thickness.toFixed(2);""",
    """    thicknessInput.value = custom.thickness.toFixed(2);
    thicknessValue.textContent = custom.thickness.toFixed(2);
    chipThicknessInput.value = custom.chipThickness.toFixed(2);
    chipThicknessValue.textContent = custom.chipThickness.toFixed(2);""",
)
rep(
    """  thicknessInput.addEventListener('input', () => {""",
    """  chipThicknessInput.addEventListener('input', () => {
    custom.chipThickness = Number.parseFloat(chipThicknessInput.value);
    chipThicknessValue.textContent = custom.chipThickness.toFixed(2);
    applyCustom();
    persistCustom();
  });
  thicknessInput.addEventListener('input', () => {""",
)

# 5) 把两平台自建歌单画进小玻璃
rep(
    """  space.start();
  applyCustom();
  syncCustomUi();
  const offView = space.onView(drawCompass);""",
    """  space.start();
  applyCustom();
  syncCustomUi();
  const offView = space.onView(drawCompass);

  /* 把两个平台「我创建的」歌单放到 6 片小玻璃里（上排网易云、下排 QQ） */
  const loadChipCards = async (): Promise<void> => {
    try {
      const overview = await fetchLibraryOverview();
      const cards: Array<{ title: string; subtitle?: string; cover?: string } | null> = [];
      (['netease', 'qq'] as const).forEach((source) => {
        const state = overview.sources.find((item) => item.source === source);
        const nickname = state?.nickname;
        const own = (state?.playlists ?? []).filter((playlist) => {
          if (playlist.special === 'liked') return false;
          return !playlist.creator || !nickname || playlist.creator === nickname;
        });
        own.slice(0, 3).forEach((playlist) => {
          cards.push({
            title: playlist.title,
            subtitle: `${SOURCE_TITLE[source]} · ${playlist.count} 首`,
            cover: playlist.cover,
          });
        });
        while (cards.length % 3 !== 0) cards.push(null);
      });
      while (cards.length < 6) cards.push(null);
      space?.setChipCards(cards.slice(0, 6));
    } catch (error) {
      console.warn('[space] 读取歌单失败', error);
    }
  };
  void loadChipCards();""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell patched for v1.11')
