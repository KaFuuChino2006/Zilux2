#!/usr/bin/env python3
"""Generate the Zilux2 app icon (PNG for reference + ICNS for the macOS bundle).

macOS accepts PNG-compressed ICNS elements (types ic07/ic08/ic09/ic10), which is
what this script writes, so no macOS tooling (iconutil) is needed.

Usage:
    python mac/packaging/make_icon.py            # writes zilux2.icns + zilux2-icon.png
"""

from __future__ import annotations

import io
import os
import struct

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ICNS_PATH = os.path.join(HERE, "zilux2.icns")
PNG_PATH = os.path.join(HERE, "zilux2-icon.png")

# size -> icns element type (all PNG-compressed)
ICNS_SIZES = [
    (16, b"icp4"),
    (32, b"icp5"),
    (64, b"icp6"),
    (128, b"ic07"),
    (256, b"ic08"),
    (512, b"ic09"),
    (1024, b"ic10"),
]

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\Arial.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def render(size: int) -> Image.Image:
    scale = 4  # draw big, downsample for clean edges
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

    # rounded-square plate with a mint gradient (matches the room effect palette)
    plate = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (canvas, canvas))
    draw_gradient = ImageDraw.Draw(gradient)
    top = (156, 233, 210)
    bottom = (79, 190, 160)
    for y in range(canvas):
        ratio = y / max(1, canvas - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw_gradient.line([(0, y), (canvas, y)], fill=color + (255,))
    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, canvas - 1, canvas - 1], radius=int(canvas * 0.225), fill=255
    )
    plate.paste(gradient, (0, 0), mask)
    image.alpha_composite(plate)

    # soft highlight in the upper-left, like the room background
    glow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [-int(canvas * 0.35), -int(canvas * 0.45), int(canvas * 0.85), int(canvas * 0.55)],
        fill=(255, 255, 255, 60),
    )
    image.alpha_composite(glow)

    # the "Z" wordmark
    draw = ImageDraw.Draw(image)
    font = load_font(int(canvas * 0.62))
    text = "Z"
    box = draw.textbbox((0, 0), text, font=font)
    text_w = box[2] - box[0]
    text_h = box[3] - box[1]
    x = (canvas - text_w) / 2 - box[0]
    y = (canvas - text_h) / 2 - box[1] - int(canvas * 0.02)
    draw.text((x, y), text, font=font, fill=(255, 250, 244, 255))

    # thin white underline, echoing the rug on the floor
    line_y = int(canvas * 0.775)
    half_w = int(canvas * 0.16)
    draw.rounded_rectangle(
        [canvas // 2 - half_w, line_y, canvas // 2 + half_w, line_y + max(2, int(canvas * 0.022))],
        radius=int(canvas * 0.012),
        fill=(255, 250, 244, 190),
    )

    return image.resize((size, size), Image.LANCZOS)


def build_icns() -> bytes:
    chunks = b""
    for size, kind in ICNS_SIZES:
        buffer = io.BytesIO()
        render(size).save(buffer, format="PNG")
        payload = buffer.getvalue()
        chunks += kind + struct.pack(">I", len(payload) + 8) + payload
    return b"icns" + struct.pack(">I", len(chunks) + 8) + chunks


def main() -> int:
    render(1024).save(PNG_PATH, format="PNG")
    icns = build_icns()
    with open(ICNS_PATH, "wb") as handle:
        handle.write(icns)
    print(f"[icon] wrote {PNG_PATH} and {ICNS_PATH} ({len(icns)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
