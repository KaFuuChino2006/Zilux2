"""本地歌曲库修正：JSON 命名 camelCase + 可重复选择 + 启动自动恢复。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def read(rel: str) -> tuple[str, str]:
    path = ROOT / rel
    raw = io.open(path, "r", encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw.replace("\r\n", "\n"), nl


def write(rel: str, text: str, nl: str) -> None:
    path = ROOT / rel
    io.open(path, "w", encoding="utf-8", newline="").write(text.replace("\n", nl))


def rep(text: str, old: str, new: str, name: str, count: int = 1) -> str:
    got = text.count(old)
    assert got == count, f"FAIL: {name} (count={got})"
    print(f"OK: {name}")
    return text.replace(old, new)


# ---------------- 宿主：JSON 用小驼峰，页面才认得 ----------------
cs, cs_nl = read(r"src\Zilux2\Local\LocalMusicService.cs")
cs = rep(
    cs,
    '[System.Text.Json.Serialization.JsonSerializable(typeof(LocalLibraryMessage))]',
    '[System.Text.Json.Serialization.JsonSourceGenerationOptions(\n'
    '    PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase,\n'
    '    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]\n'
    '[System.Text.Json.Serialization.JsonSerializable(typeof(LocalLibraryMessage))]',
    "cs-camel-case",
)
write(r"src\Zilux2\Local\LocalMusicService.cs", cs, cs_nl)

# ---------------- 页面 ----------------
ts, ts_nl = read(r"web\src\ui\spaceShell.ts")

ts = rep(
    ts,
    "  let localPickBusy = false;\n  const localCoverCache = new Map<number, string>();",
    "  let localPickBusy = false;\n"
    "  let localRestoreTried = false;\n"
    "  let localAutoRestoring = false;\n"
    "  const localCoverCache = new Map<number, string>();",
    "ts-state",
)

ts = rep(
    ts,
    "  function pickLocalLibrary(): void {\n"
    "    if (localPickBusy) return;\n"
    "    localPickBusy = true;\n"
    "    setStatus('本地歌曲库 · 正在等待选择文件夹…');\n"
    "    host.pickLocalMusic();\n"
    "  }",
    "  function pickLocalLibrary(): void {\n"
    "    if (localPickBusy) return;\n"
    "    localPickBusy = true;\n"
    "    setStatus('本地歌曲库 · 正在等待选择文件夹…');\n"
    "    host.pickLocalMusic();\n"
    "    // 兜底：宿主没回事件（例如被拒绝）时别把按钮永久锁死\n"
    "    window.setTimeout(() => {\n"
    "      localPickBusy = false;\n"
    "    }, 20000);\n"
    "  }",
    "ts-pick-timeout",
)

old_rail = """  function handleLocalRail(): void {
    if (localPickBusy) return;
    if (localTracks.length === 0) {
      const saved = window.localStorage.getItem(LOCAL_FOLDER_KEY);
      if (saved) {
        localPickBusy = true;
        setStatus('本地歌曲库 · 正在载入上次的文件夹…');
        host.restoreLocalMusic(saved);
        return;
      }
      pickLocalLibrary();
      return;
    }
    if (localViewOpen) {
      pickLocalLibrary();
      return;
    }
    showLocalLibrary();
  }"""
new_rail = """  function handleLocalRail(): void {
    if (localPickBusy) return;
    if (localTracks.length === 0) {
      const saved = window.localStorage.getItem(LOCAL_FOLDER_KEY);
      // 自动恢复过 / 已经试过恢复，就别再卡在 restore 上，直接弹选择器
      if (saved && !localRestoreTried) {
        localRestoreTried = true;
        localPickBusy = true;
        setStatus('本地歌曲库 · 正在载入上次的文件夹…');
        host.restoreLocalMusic(saved);
        window.setTimeout(() => {
          localPickBusy = false;
        }, 12000);
        return;
      }
      pickLocalLibrary();
      return;
    }
    if (localViewOpen) {
      pickLocalLibrary();
      return;
    }
    showLocalLibrary();
  }

  /** 进入空间后静默恢复上次的本地歌曲库（不抢磁贴墙，只把列表备好） */
  function maybeRestoreLocalLibrary(): void {
    if (localAutoRestoring || localTracks.length > 0) return;
    const saved = window.localStorage.getItem(LOCAL_FOLDER_KEY);
    if (!saved) return;
    localAutoRestoring = true;
    localRestoreTried = true;
    localPickBusy = true;
    host.restoreLocalMusic(saved);
    window.setTimeout(() => {
      localPickBusy = false;
      localAutoRestoring = false;
    }, 15000);
  }"""
ts = rep(ts, old_rail, new_rail, "ts-rail")

ts = rep(
    ts,
    "    island.show();\n    wakeShellUi();",
    "    island.show();\n    maybeRestoreLocalLibrary();\n    wakeShellUi();",
    "ts-auto-restore",
)

old_sub = """  onLocalLibrary((payload) => {
    localPickBusy = false;
    if (payload.error) {
      window.localStorage.removeItem(LOCAL_FOLDER_KEY);
      showToast(payload.error, 'error');
      setStatus('本地歌曲库 · 载入失败');
      return;
    }
    applyLocalLibrary(payload, true);
  });"""
new_sub = """  onLocalLibrary((payload) => {
    const silent = localAutoRestoring;
    localAutoRestoring = false;
    localPickBusy = false;
    if (payload.error) {
      window.localStorage.removeItem(LOCAL_FOLDER_KEY);
      localRestoreTried = true;
      setStatus('本地歌曲库 · 载入失败');
      if (!silent) showToast(payload.error, 'error');
      return;
    }
    applyLocalLibrary(payload, !silent);
  });"""
ts = rep(ts, old_sub, new_sub, "ts-subscribe")

write(r"web\src\ui\spaceShell.ts", ts, ts_nl)
print("DONE")
