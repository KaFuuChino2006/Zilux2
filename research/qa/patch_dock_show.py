import io
import sys

ROOT = r"E:\Zilux2开发\web\src\ui"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def rep(text, old, new, label, count=1):
    hits = text.count(old)
    if hits != count:
        print("FAIL: %s (count=%d, expect=%d)" % (label, hits, count))
        sys.exit(1)
    print("OK: " + label)
    return text.replace(old, new)


# ---------------------------------------------------------------- islandPlayer.ts
path = ROOT + r"\islandPlayer.ts"
text = load(path)
nl = "\r\n" if "\r\n" in text else "\n"
print("islandPlayer newline:", repr(nl))

text = rep(
    text,
    nl.join([
        "  prev(): void;",
        "  hide(): void;",
    ]),
    nl.join([
        "  prev(): void;",
        "  /** 进入空间后立即露出播放条（即使还没开始播放，展开后显示「未播放」与 00:00） */",
        "  show(): void;",
        "  hide(): void;",
    ]),
    "iface-show",
)

text = rep(
    text,
    nl.join([
        "    hide() {",
        "      root.classList.remove('is-visible');",
    ]),
    nl.join([
        "    show() {",
        "      root.hidden = false;",
        "      window.requestAnimationFrame(() => root.classList.add('is-visible'));",
        "    },",
        "    hide() {",
        "      root.classList.remove('is-visible');",
    ]),
    "impl-show",
)

save(path, text)

# ---------------------------------------------------------------- spaceShell.ts
path = ROOT + r"\spaceShell.ts"
text = load(path)
nl = "\r\n" if "\r\n" in text else "\n"
print("spaceShell newline:", repr(nl))

text = rep(
    text,
    nl.join([
        "    void loadLikedTiles();",
        "    wakeShellUi();",
    ]),
    nl.join([
        "    void loadLikedTiles();",
        "    island.show();",
        "    wakeShellUi();",
    ]),
    "enter-space-show",
)

text = rep(
    text,
    nl.join([
        "    space?.setEntered(false);",
        "    host.setChromeColor(CHROME_LOGIN);",
    ]),
    nl.join([
        "    space?.setEntered(false);",
        "    island.hide();",
        "    host.setChromeColor(CHROME_LOGIN);",
    ]),
    "leave-space-hide",
)

save(path, text)

print("ALL DONE")
