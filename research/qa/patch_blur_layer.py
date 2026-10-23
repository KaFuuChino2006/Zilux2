# -*- coding: utf-8 -*-
"""m09386：点击磁贴时周围封面渐进模糊（DOM 模糊层）、位置不变；被点封面在中央放大卡；相机只轻微拉近。"""
import io

# ---------- spaceShell.ts ----------
p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label, src=None):
    global s
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    s = s.replace(old, new, 1)


# 1) 模板：详情面板包一层中央卡
rep(
    """    <aside class="tile-detail" data-tile-detail hidden>
      <div class="tile-detail-cover">
        <img data-tile-cover alt="" />
      </div>
      <div class="tile-detail-body">
        <h3 data-tile-title>—</h3>
        <p data-tile-artist>—</p>
        <p class="tile-detail-meta" data-tile-meta>—</p>
        <p class="tile-detail-tip">再次点击封面播放 · 双击播放 · Esc 关闭</p>
      </div>
    </aside>""",
    """    <aside class="tile-detail" data-tile-detail hidden>
      <div class="tile-detail-card">
        <div class="tile-detail-cover">
          <img data-tile-cover alt="" />
        </div>
        <div class="tile-detail-body">
          <h3 data-tile-title>—</h3>
          <p data-tile-artist>—</p>
          <p class="tile-detail-meta" data-tile-meta>—</p>
          <p class="tile-detail-tip">再次点击封面播放 · 双击播放 · Esc 关闭</p>
        </div>
      </div>
    </aside>""",
    'template card',
)

# 2) 元素引用
rep(
    """  let tileTracks: OnlineTrack[] = [];
  let detailIndex = -1;""",
    """  let tileTracks: OnlineTrack[] = [];
  let detailIndex = -1;
  const tileDetailEl = root.querySelector<HTMLElement>('[data-tile-detail]')!;
  const tileCoverEl = root.querySelector<HTMLImageElement>('[data-tile-cover]')!;
  const tileTitleEl = root.querySelector<HTMLElement>('[data-tile-title]')!;
  const tileArtistEl = root.querySelector<HTMLElement>('[data-tile-artist]')!;
  const tileMetaEl = root.querySelector<HTMLElement>('[data-tile-meta]')!;
  let tileDetailHideTimer = 0;""",
    'refs',
)

# 3) hideTileDetail
rep(
    """  function hideTileDetail(): void {
    if (detailIndex < 0) return;
    detailIndex = -1;
    space?.unfocusTile();
    setStatus('点击封面看详情 · 双击播放');
  }""",
    """  function hideTileDetail(): void {
    if (detailIndex < 0) return;
    detailIndex = -1;
    tileDetailEl.classList.remove('is-open');
    window.clearTimeout(tileDetailHideTimer);
    tileDetailHideTimer = window.setTimeout(() => {
      if (!tileDetailEl.classList.contains('is-open')) tileDetailEl.hidden = true;
    }, 320);
    space?.unfocusTile();
    setStatus('点击封面看详情 · 双击播放');
  }""",
    'hide',
)

# 4) showTileDetail
rep(
    """  function showTileDetail(index: number): void {
    const track = tileTracks[index];
    if (!track || !space) return;
    detailIndex = index;
    // 直接让被点的磁贴在 3D 里放大显示详情（相机自动飞过去）
    space.focusTile(index, {""",
    """  function showTileDetail(index: number): void {
    const track = tileTracks[index];
    if (!track || !space) return;
    detailIndex = index;
    // 周围封面由页面层渐进模糊（位置不变），被点封面以中央放大卡呈现
    if (track.cover) {
      tileCoverEl.src = track.cover;
      tileCoverEl.style.display = '';
    } else {
      tileCoverEl.removeAttribute('src');
      tileCoverEl.style.display = 'none';
    }
    tileTitleEl.textContent = track.title || '未命名';
    tileArtistEl.textContent = track.artist || '未知歌手';
    tileMetaEl.textContent =
      [track.album, track.durationMs ? formatClock(track.durationMs / 1000) : '']
        .filter(Boolean)
        .join(' · ') || '—';
    window.clearTimeout(tileDetailHideTimer);
    tileDetailEl.hidden = false;
    requestAnimationFrame(() => tileDetailEl.classList.add('is-open'));
    space.focusTile(index, {""",
    'show',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell patched')

# ---------- space.css ----------
p2 = r'E:\Zilux2开发\web\src\styles\space.css'
c = io.open(p2, 'r', encoding='utf-8', newline='').read()

start = c.index('/* ---------- 磁贴歌曲详情面板（v2.4） ---------- */')
end = c.index('/* 磁贴翻页箭头（左右两侧玻璃圆钮，仅空间/磁贴视图显示） */')
new_css = """/* ---------- 磁贴点击：周围渐进模糊 + 中央放大卡（v2.18） ---------- */
.tile-detail {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgba(249, 250, 253, 0.2);
  -webkit-backdrop-filter: blur(0px);
  backdrop-filter: blur(0px);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.3s var(--ease),
    -webkit-backdrop-filter 0.3s var(--ease),
    backdrop-filter 0.3s var(--ease);
}
.tile-detail.is-open {
  opacity: 1;
  -webkit-backdrop-filter: blur(16px) saturate(120%);
  backdrop-filter: blur(16px) saturate(120%);
}
.tile-detail[hidden] {
  display: none;
}
.tile-detail-card {
  width: min(50vh, 440px);
  padding: 13px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 28px 80px rgba(30, 38, 72, 0.24);
  opacity: 0;
  transform: scale(0.92);
  transition:
    transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1),
    opacity 0.3s var(--ease);
}
.tile-detail.is-open .tile-detail-card {
  opacity: 1;
  transform: scale(1);
}
.tile-detail-cover {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 20px;
  overflow: hidden;
  background: rgba(240, 243, 250, 0.9);
}
.tile-detail-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tile-detail-body {
  padding: 12px 6px 4px;
}
.tile-detail-body h3 {
  margin: 0 2px 6px;
  font-size: 21px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.3;
}
.tile-detail-body p {
  margin: 0 2px 4px;
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.4;
}
.tile-detail-meta {
  opacity: 0.85;
}
.tile-detail-tip {
  margin-top: 8px !important;
  font-size: 12px !important;
  color: var(--text-mute) !important;
}

"""
c = c[:start] + new_css + c[end:]
io.open(p2, 'w', encoding='utf-8', newline='').write(c)
print('space.css patched')
