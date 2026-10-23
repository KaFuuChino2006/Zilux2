# -*- coding: utf-8 -*-
"""聚焦细节：相机视线对准被拉近的磁贴 z（居中），详情纹理改为满铺封面 + 底部渐变信息条（去掉白底白框）。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 2) 详情纹理：满铺封面 + 底部渐变 + 歌名/歌手/专辑，不要白底白框
start = s.index('  function drawDetailTile(): void {')
end = s.index('\n  }\n', start) + len('\n  }\n')
old_fn = s[start:end]
new_fn = """  function drawDetailTile(): void {
    const ctx = detailCanvas.getContext('2d');
    if (!ctx) return;
    const S = detailCanvas.width;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    roundRectPath(ctx, 1.5, 1.5, S - 3, S - 3, S * 0.045);
    ctx.clip();
    // 封面满铺
    if (detailImage) {
      const img = detailImage;
      const scale = Math.max(S / img.width, S / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
    } else {
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, 'rgba(203,214,246,0.95)');
      g.addColorStop(1, 'rgba(246,232,255,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
    // 底部渐变保证歌名可读
    const shade = ctx.createLinearGradient(0, S * 0.5, 0, S);
    shade.addColorStop(0, 'rgba(6, 8, 14, 0)');
    shade.addColorStop(1, 'rgba(6, 8, 14, 0.72)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, S * 0.5, S, S * 0.5);
    const info = detailInfo;
    const baseY = S * 0.9;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (info) {
      ctx.fillStyle = 'rgba(255,255,255,0.97)';
      ctx.font = '600 ' + S * 0.072 + 'px ' + FONT;
      const lines = wrapLines(ctx, info.title || '未命名', S * 0.86, 2);
      lines.forEach((line, i) => {
        ctx.fillText(line, S * 0.06, baseY - (lines.length - 1 - i) * S * 0.082);
      });
      if (info.artist) {
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.font = '500 ' + S * 0.036 + 'px ' + FONT;
        ctx.fillText(info.artist.slice(0, 24), S * 0.06, baseY - lines.length * S * 0.082 - S * 0.006);
      }
      const meta = [info.album, info.duration].filter(Boolean).join(' · ');
      if (meta) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '500 ' + S * 0.03 + 'px ' + FONT;
        ctx.fillText(meta.slice(0, 32), S * 0.06, baseY - lines.length * S * 0.082 - S * 0.052);
      }
    }
    ctx.restore();
  }
"""
s = s[:start] + new_fn + s[end:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('detail tile full-bleed + lookTarget z')
