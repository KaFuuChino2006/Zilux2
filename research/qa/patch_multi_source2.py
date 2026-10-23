# -*- coding: utf-8 -*-
"""多平台接口（续）：account/library/settings/app 动态化。"""
import io

SRC = r"E:\Zilux2开发\web\src"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def apply(path, label, edits, global_subs=None):
    text = load(path)
    E = "\r\n" if "\r\n" in text else "\n"
    for old, new in edits:
        o, n = old.replace("\n", E), new.replace("\n", E)
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:56]}"
        text = text.replace(o, n)
    for old, new in global_subs or []:
        assert old in text, f"{label}: global {old[:40]}"
        text = text.replace(old, new)
    save(path, text)
    print(label, "OK")


# ---------------- account.ts ----------------
apply(
    SRC + r"\core\account.ts",
    "account.ts",
    [
        ("export type AccountSource = 'netease' | 'qq';",
         "// 账号来源同样开放：具体平台由宿主 /api/sources 决定。\nexport type AccountSource = 'netease' | 'qq' | (string & {});"),
        ("import { host } from './bridge';",
         "import { host } from './bridge';\nimport { accountSourceIds, sourceLoginMode } from '../online/sources';"),
        ("const SOURCE_ORDER: AccountSource[] = ['netease', 'qq'];",
         "function accountSources(): AccountSource[] {\n  return accountSourceIds() as AccountSource[];\n}"),
        ("  const mode = source === 'netease' ? 'code' : 'image';",
         "  const mode = sourceLoginMode(source);"),
        ("  input.source === 'qq' ? 'qq' : input.source === 'netease' ? 'netease' : null;",
         "  typeof input.source === 'string' && input.source ? (input.source.toLowerCase() as AccountSource) : null;"),
    ],
    global_subs=[("SOURCE_ORDER", "accountSources()")],
)

# ---------------- library.ts ----------------
apply(
    SRC + r"\core\library.ts",
    "library.ts",
    [
        ("function asSource(value: unknown): MusicSource | null {\n  return value === 'netease' || value === 'qq' ? value : null;\n}",
         "function asSource(value: unknown): MusicSource | null {\n  return typeof value === 'string' && value.length > 0 ? value : null;\n}"),
    ],
)

# ---------------- settings.ts ----------------
apply(
    SRC + r"\core\settings.ts",
    "settings.ts",
    [
        ("export type OnlineSourceId = 'netease' | 'qq';",
         "export type OnlineSourceId = 'netease' | 'qq' | (string & {});"),
        ("const SOURCES: readonly OnlineSourceId[] = ['netease', 'qq'];",
         "// 默认平台只校验非空字符串；具体可用平台由宿主 /api/sources 决定。\nconst SOURCES: readonly OnlineSourceId[] = [];"),
        ("      defaultSource: asEnum(playback.defaultSource, SOURCES, DEFAULT_SETTINGS.playback.defaultSource),",
         "      defaultSource:\n        typeof playback.defaultSource === 'string' && playback.defaultSource\n          ? playback.defaultSource\n          : DEFAULT_SETTINGS.playback.defaultSource,"),
    ],
)

# ---------------- app.ts ----------------
apply(
    SRC + r"\ui\app.ts",
    "app.ts",
    [
        ("import { SOURCE_LABEL } from '../online/types';",
         "import { SOURCE_LABEL } from '../online/types';\nimport {\n  accountSourceIds,\n  sourceDescriptors,\n  sourceHasDaily30,\n  sourceIds,\n  sourceMeta,\n} from '../online/sources';"),
        ("      (['netease', 'qq'] as OnlineSource[]).forEach((item) => {",
         "      (sourceIds() as OnlineSource[]).forEach((item) => {"),
        ("""          [
            { value: 'netease', label: '网易云' },
            { value: 'qq', label: 'QQ 音乐' },
          ],""",
         """          sourceDescriptors().map((item) => ({ value: item.id, label: item.label })),"""),
        ("      for (const source of ['netease', 'qq'] as AccountSource[]) {",
         "      for (const source of accountSourceIds() as AccountSource[]) {"),
        ("    for (const source of ['netease', 'qq'] as AccountSource[]) {",
         "    for (const source of accountSourceIds() as AccountSource[]) {"),
        ("    const sources: AccountSource[] = only ? [only] : ['netease', 'qq'];",
         "    const sources: AccountSource[] = only ? [only] : (accountSourceIds() as AccountSource[]);"),
        ("                : h('div', { class: 'source-dot ' + source, text: source === 'qq' ? 'Q' : '网' }),",
         "                : h('div', { class: 'source-dot ' + source, text: sourceMeta(source).short }),"),
        ("        h('div', { class: `source-dot ${source}`, text: source === 'qq' ? 'Q' : '网' }),",
         "        h('div', { class: `source-dot ${source}`, text: sourceMeta(source).short }),"),
        ("    const source: OnlineSource = qqDaily ? 'qq' : (this.preferredSource() ?? 'netease');",
         "    const source: OnlineSource = qqDaily\n      ? (((sourceIds() as OnlineSource[]).find((item) => sourceHasDaily30(item)) ??\n          this.preferredSource() ??\n          'qq') as OnlineSource)\n      : (this.preferredSource() ?? 'netease');"),
    ],
)
