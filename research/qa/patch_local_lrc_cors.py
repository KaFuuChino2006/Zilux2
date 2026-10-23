"""修复本地 LRC 无法 fetch（缺 CORS 头），并撤销对作词/作曲行的过滤。"""
import io
from pathlib import Path

cs = Path(r"E:\Zilux2开发\src\Zilux2\Local\LocalMusicService.cs")
with io.open(cs, "r", encoding="utf-8", newline="") as handle:
    raw = handle.read()
crlf = "\r\n" in raw
text = raw.replace("\r\n", "\n")

old = '        var headers = $"Content-Type: {contentType}\\r\\nAccept-Ranges: bytes\\r\\nCache-Control: no-store";'
new = ('        var headers =\n'
       '            $"Content-Type: {contentType}\\r\\nAccept-Ranges: bytes\\r\\nCache-Control: no-store"\n'
       '            + "\\r\\nAccess-Control-Allow-Origin: *"\n'
       '            + "\\r\\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS"\n'
       '            + "\\r\\nAccess-Control-Allow-Headers: Range, Content-Type"\n'
       '            + "\\r\\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges";')
got = text.count(old)
assert got == 1, f"cs headers count {got}"
text = text.replace(old, new)

with io.open(cs, "w", encoding="utf-8", newline="") as handle:
    handle.write(text.replace("\n", "\r\n") if crlf else text)

ts = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
with io.open(ts, "r", encoding="utf-8", newline="") as handle:
    raw = handle.read()
crlf = "\r\n" in raw
text = raw.replace("\r\n", "\n")

helper_start = text.index("  /** 制作信息行（作词/作曲/编曲/制作人…）")
helper_end = text.index("  /** 把 LRC（+可选翻译/逐字轴）转成 3D 歌词行。 */")
text = text[:helper_start] + text[helper_end:]

for old_filter, new_filter in (
    (
        "      (line) => line.text.trim().length > 0 && !isCreditLine(line.text),\n    );\n",
        "      (line) => line.text.trim().length > 0,\n    );\n",
    ),
    (
        "        (line) => line.text.trim().length > 0 && !isCreditLine(line.text),\n      );\n",
        "        (line) => line.text.trim().length > 0,\n      );\n",
    ),
):
    got = text.count(old_filter)
    assert got == 1, f"ts filter count {got}: {old_filter[:50]!r}"
    text = text.replace(old_filter, new_filter)

with io.open(ts, "w", encoding="utf-8", newline="") as handle:
    handle.write(text.replace("\n", "\r\n") if crlf else text)

print("OK: cors-headers, credit-filter-reverted")
