# -*- coding: utf-8 -*-
"""本地库：用户取消文件夹选择时通知页面解锁（否则点文件夹像没反应）。"""
import io


def patch(path, steps):
    raw = io.open(path, encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n")
    for name, old, new, count in steps:
        got = text.count(old)
        assert got == count, f"{name}: count={got} expected {count}"
        text = text.replace(old, new)
        print(f"OK: {name}")
    io.open(path, "w", encoding="utf-8", newline="").write(
        text.replace("\n", "\r\n") if crlf else text
    )


ROOT = r"E:\Zilux2开发"
CS = ROOT + r"\src\Zilux2\Local\LocalMusicService.cs"
BR = ROOT + r"\web\src\bridge.ts"
SS = ROOT + r"\web\src\ui\spaceShell.ts"

cs_steps = [
    (
        "cs-post-cancel",
        """    private void PostError(string? folder, string message)
    {
        HostLog.Warn($"[local] {message}");
        PostTracks(folder ?? string.Empty, new List<LocalTrackDto>(), null, message);
    }
""",
        """    private void PostError(string? folder, string message)
    {
        HostLog.Warn($"[local] {message}");
        PostTracks(folder ?? string.Empty, new List<LocalTrackDto>(), null, message);
    }

    /// <summary>通知页面：用户取消了文件夹选择，可以解锁按钮了。</summary>
    private void PostCancel()
    {
        var message = new LocalLibraryMessage
        {
            Event = "localCancel",
            Payload = new LocalLibraryPayload(),
        };
        _post(JsonSerializer.Serialize(message, LocalLibraryJsonContext.Default.LocalLibraryMessage));
    }
""",
        1,
    ),
    (
        "cs-cancel-post",
        '                HostLog.Info("[local] folder pick cancelled");\n                return;\n',
        '                HostLog.Info("[local] folder pick cancelled");\n                PostCancel();\n                return;\n',
        1,
    ),
]

br_steps = [
    (
        "br-cancel-api",
        "const localLibraryHandlers = new Set<(payload: LocalLibraryPayload) => void>();\nlet localLibraryBound = false;\n",
        "const localLibraryHandlers = new Set<(payload: LocalLibraryPayload) => void>();\nconst localCancelHandlers = new Set<() => void>();\nlet localLibraryBound = false;\n",
        1,
    ),
    (
        "br-cancel-dispatch",
        "    host.onMessage((message) => {\n      if (message.type !== 'host' || message.event !== 'localLibrary') return;\n",
        "    host.onMessage((message) => {\n      if (message.type === 'host' && message.event === 'localCancel') {\n        localCancelHandlers.forEach((listener) => {\n          try {\n            listener();\n          } catch (err) {\n            console.warn('[bridge] localCancel handler failed', err);\n          }\n        });\n        return;\n      }\n      if (message.type !== 'host' || message.event !== 'localLibrary') return;\n",
        1,
    ),
    (
        "br-cancel-export",
        "/** 订阅宿主扫描完成的本地歌曲库（选择文件夹或按记录恢复后推送）。 */\n",
        """/** 订阅「用户取消了文件夹选择」事件，用来解锁页面按钮。 */
export function onLocalCancel(handler: () => void): () => void {
  localCancelHandlers.add(handler);
  onLocalLibrary(() => undefined);
  return () => {
    localCancelHandlers.delete(handler);
  };
}

/** 订阅宿主扫描完成的本地歌曲库（选择文件夹或按记录恢复后推送）。 */
""",
        1,
    ),
]

ss_steps = [
    (
        "ss-import-cancel",
        "import { host, onLocalLibrary, onMediaControl, reportMedia, type LocalLibraryPayload } from '../bridge';\n",
        "import { host, onLocalCancel, onLocalLibrary, onMediaControl, reportMedia, type LocalLibraryPayload } from '../bridge';\n",
        1,
    ),
    (
        "ss-subscribe-cancel",
        "  onLocalLibrary((payload) => {\n",
        "  onLocalCancel(() => {\n    host.log('info', '[local] pick cancelled');\n    localPickBusy = false;\n    setStatus('本地歌曲库 · 已取消选择文件夹');\n  });\n\n  onLocalLibrary((payload) => {\n",
        1,
    ),
]

patch(CS, cs_steps)
patch(BR, br_steps)
patch(SS, ss_steps)
print("DONE")
