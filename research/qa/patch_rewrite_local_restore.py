# -*- coding: utf-8 -*-
"""新前端：启动自动恢复上次本地文件夹 + 记住宿主回推的文件夹。"""
import io

BASE = r"E:\Zilux2开发\web\src"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


# ---- local.ts：记住文件夹 + 启动恢复 ----
local = BASE + r"\ui\local.ts"
text = load(local)
before = text

old = """  const off = onLocalLibrary((payload) => {
    library = normalize(payload);
    notify();
  });"""
new = """  const off = onLocalLibrary((payload) => {
    library = normalize(payload);
    rememberFolder(payload.folder);
    notify();
  });"""
assert text.count(old) == 1, "local: onLocalLibrary handler"
text = text.replace(old, new)

old = """  const offCancel = onLocalCancel(() => {
    // 用户取消选择：保持现状
  });
"""
new = """  const offCancel = onLocalCancel(() => {
    // 用户取消选择：保持现状
  });
  // 上次选过的文件夹在启动时自动恢复（宿主会立即回推 localLibrary）。
  const folder = rememberedFolder();
  if (folder) restoreLocalFolder(folder);
"""
assert text.count(old) == 1, "local: cancel handler"
text = text.replace(old, new)
assert text != before
save(local, text)
print("local.ts OK")

# ---- app.ts：import 增补 + showLocal 载入分支 ----
app = BASE + r"\ui\app.ts"
text = load(app)
before = text

old = """import {
  initLocalLibrary,
  localLibrary,
  onLocalLibraryChange,
  pickLocalFolder,
  trackOf,
} from './local';"""
new = """import {
  initLocalLibrary,
  localLibrary,
  onLocalLibraryChange,
  pickLocalFolder,
  rememberedFolder,
  trackOf,
} from './local';"""
assert text.count(old) == 1, "app: local import block"
text = text.replace(old, new)

old = """    const lib = localLibrary();
    if (!lib) {
      pickLocalFolder();
      this.wall = {
        kind: 'local',
        title: '本地曲库',
        subtitle: '已打开文件夹选择器…',
        tracks: [],
      };
      this.renderWall();
      return;
    }"""
new = """    const lib = localLibrary();
    if (!lib) {
      if (rememberedFolder()) {
        this.wall = {
          kind: 'local',
          title: '本地曲库',
          subtitle: '正在载入上次的文件夹…',
          tracks: [],
        };
        this.renderWall();
        window.setTimeout(() => {
          if (!localLibrary() && this.wall.kind === 'local') pickLocalFolder();
        }, 2500);
        return;
      }
      pickLocalFolder();
      this.wall = {
        kind: 'local',
        title: '本地曲库',
        subtitle: '已打开文件夹选择器…',
        tracks: [],
      };
      this.renderWall();
      return;
    }"""
assert text.count(old) == 1, "app: showLocal empty branch"
text = text.replace(old, new)
assert text != before
save(app, text)
print("app.ts OK")
