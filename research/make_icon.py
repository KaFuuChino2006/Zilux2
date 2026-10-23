"""
生成 Zilux2 应用图标（app.ico）：深色圆角方块 + 紫青渐变 Z 字标。
用 bundled python 运行：python research/make_icon.py
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "Zilux2", "app.ico")
S = 1024  # 先画大图再降采样，保证 16px 也清晰


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b))
    return img


# ---- 背板：圆角方块 + 深色渐变 ----
bg = gradient(S, (16, 14, 30), (5, 6, 11)).convert("RGBA")
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(bg, (0, 0), mask)

# 内描边
edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(edge).rounded_rectangle(
    [1, 1, S - 2, S - 2], radius=int(S * 0.235), outline=(255, 255, 255, 46), width=6
)
icon = Image.alpha_composite(icon, edge)

# ---- Z 字标（紫→青渐变 + 柔光）----
font_path = r"C:\Windows\Fonts\segoeuib.ttf"
if not os.path.exists(font_path):
    font_path = r"C:\Windows\Fonts\arialbd.ttf"
font = ImageFont.truetype(font_path, int(S * 0.52))

glyph = "Z"
bbox = ImageDraw.Draw(Image.new("RGBA", (S, S))).textbbox((0, 0), glyph, font=font)
gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
gx, gy = (S - gw) // 2 - bbox[0], (S - gh) // 2 - bbox[1]

text_mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(text_mask).text((gx, gy), glyph, font=font, fill=255)

# 渐变填充
zgrad = gradient(S, (176, 156, 255), (94, 240, 255)).convert("RGBA")
zlayer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
zfill = Image.new("RGBA", (S, S), (0, 0, 0, 0))
zfill.paste(zgrad, (0, 0), text_mask)
zfill.putalpha(text_mask)
zlayer = Image.alpha_composite(zlayer, zfill)

# 柔光
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
glow.paste(Image.new("RGBA", (S, S), (150, 120, 255, 130)), (0, 0), text_mask)
glow = glow.filter(ImageFilter.GaussianBlur(int(S * 0.045)))
icon = Image.alpha_composite(icon, glow)
icon = Image.alpha_composite(icon, zlayer)

# 底部高光（提升立体感）
halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(halo).ellipse(
    [-S * 0.15, S * 0.62, S * 1.15, S * 1.35], fill=(120, 90, 255, 40)
)
halo = halo.filter(ImageFilter.GaussianBlur(int(S * 0.08)))
halo.putalpha(Image.composite(halo.getchannel("A"), Image.new("L", (S, S), 0), mask))
icon = Image.alpha_composite(icon, halo)

# ---- 输出多尺寸 ico ----
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
icon.save(OUT, format="ICO", sizes=sizes)
print("saved:", os.path.abspath(OUT))
