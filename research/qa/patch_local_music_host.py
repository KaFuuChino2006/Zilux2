import io
from pathlib import Path

PATH = Path(r"E:\Zilux2开发\src\Zilux2\WebViewHost.cs")
raw = io.open(PATH, "r", encoding="utf-8", newline="").read()
crlf = "\r\n" in raw
text = raw.replace("\r\n", "\n")


def rep(old: str, new: str, label: str, count: int = 1) -> None:
    global text
    got = text.count(old)
    assert got == count, f"FAIL: {label} (count={got}, want={count})"
    text = text.replace(old, new)
    print("OK:", label)


rep(
    "using Zilux2.Media;\n",
    "using Zilux2.Local;\nusing Zilux2.Media;\n",
    "using-local",
)

rep(
    "    private readonly AirPlayService? _airplay;\n",
    "    private readonly AirPlayService? _airplay;\n    private readonly LocalMusicService _localMusic;\n",
    "field-local",
)

rep(
    """        _audio = audio;
        _media = media;
        _airplay = airplay;
        if (_media is not null)
""",
    """        _audio = audio;
        _media = media;
        _airplay = airplay;
        _localMusic = new LocalMusicService(window, () => _webView.CoreWebView2, PostJson);
        if (_media is not null)
""",
    "ctor-local",
)

rep(
    """                case "fonts":
                    HandleFontsMessage();
                    break;
""",
    """                case "fonts":
                    HandleFontsMessage();
                    break;

                case "local":
                    _localMusic.Handle(root);
                    break;
""",
    "dispatch-local",
)

assert text != raw
out = text.replace("\n", "\r\n") if crlf else text
io.open(PATH, "w", encoding="utf-8", newline="").write(out)
print("WROTE:", PATH)
