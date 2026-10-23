# -*- coding: utf-8 -*-
"""多平台接口：宿主 GET /api/sources 驱动页面（登录卡/搜索分段/默认音源），前端不再写死平台列表。"""
import io

WEB = r"E:\Zilux2开发\web"
SRC = WEB + r"\src"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def apply(path, label, edits):
    text = load(path)
    E = "\r\n" if "\r\n" in text else "\n"
    for old, new in edits:
        o = old.replace("\n", E)
        n = new.replace("\n", E)
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:56]}"
        text = text.replace(o, n)
    save(path, text)
    print(label, "OK")


# ---------------- types.ts：放宽来源类型 + 复用动态 SOURCE_LABEL ----------------
apply(
    SRC + r"\online\types.ts",
    "types.ts",
    [
        ("export type OnlineSource = 'netease' | 'qq' | 'local';",
         "// 来源 id 开放为 string（新增平台只登记，不改类型）：常见平台仍有字面量提示。\nexport type OnlineSource = 'netease' | 'qq' | 'local' | (string & {});"),
        ("""export const SOURCE_LABEL: Record<OnlineSource, string> = {
  netease: '网易云',
  qq: 'QQ 音乐',
  local: '本地',
};""",
         "// 显示名由 online/sources.ts 在宿主返回平台清单后动态填充（含本地音乐）。\nexport { SOURCE_LABEL } from './sources';"),
    ],
)

# ---------------- client.ts：拿到 online 消息后拉 /api/sources ----------------
apply(
    SRC + r"\online\client.ts",
    "client.ts",
    [
        ("import type { OnlineInfo, OnlineLyric, OnlineSearchResult, OnlineSource, OnlineTrack } from './types';",
         "import type { OnlineInfo, OnlineLyric, OnlineSearchResult, OnlineSource, OnlineTrack } from './types';\nimport { initSourceDescriptors, type SourceDescriptor } from './sources';"),
        ("""export function onlineInfo(): OnlineInfo | null {
  return info;
}""",
         """export function onlineInfo(): OnlineInfo | null {
  return info;
}

/** 拉取平台能力清单（宿主 GET /api/sources）；失败时沿用内置兜底。 */
function loadSourceDescriptors(): void {
  if (!info || info.port <= 0) return;
  api<{ sources: SourceDescriptor[] }>('/api/sources')
    .then((res) => {
      if (res && Array.isArray(res.sources)) initSourceDescriptors(res.sources);
    })
    .catch((err: unknown) => console.warn('[online] sources metadata failed', err));
}"""),
        ("""    host.log('info', `[online] host ready port=${info.port} sources=${info.sources.join('+')}`);
    listeners.forEach((cb) => cb());""",
         """    host.log('info', `[online] host ready port=${info.port} sources=${info.sources.join('+')}`);
    loadSourceDescriptors();
    listeners.forEach((cb) => cb());"""),
    ],
)

# ---------------- account.ts：平台顺序/登录方式走登记表 ----------------
apply(
    SRC + r"\core\account.ts",
    "account.ts",
    [
        ("export type AccountSource = 'netease' | 'qq';",
         "// 账号来源同样开放：具体平台由宿主 /api/sources 决定。\nexport type AccountSource = 'netease' | 'qq' | (string & {});"),
        ("const SOURCE_ORDER: AccountSource[] = ['netease', 'qq'];",
         "import { accountSourceIds, sourceLoginMode } from '../online/sources';\n\nfunction accountSources(): AccountSource[] {\n  return accountSourceIds() as AccountSource[];\n}"),
        ("  return SOURCE_ORDER.map((source) => cache.get(source) ?? { source, loggedIn: false });",
         "  return accountSources().map((source) => cache.get(source) ?? { source, loggedIn: false });"),
        ("  for (const source of SOURCE_ORDER) {",
         "  for (const source of accountSources()) {"),
        ("    for (const source of SOURCE_ORDER) {",
         "    for (const source of accountSources()) {"),
        ("  const mode = source === 'netease' ? 'code' : 'image';",
         "  const mode = sourceLoginMode(source);"),
        ("  input.source === 'qq' ? 'qq' : input.source === 'netease' ? 'netease' : null;",
         "  typeof input.source === 'string' && input.source ? (input.source.toLowerCase() as AccountSource) : null;"),
    ],
)

# ---------------- library.ts：接受任意已登记来源 ----------------
apply(
    SRC + r"\core\library.ts",
    "library.ts",
    [
        ("function asSource(value: unknown): MusicSource | null {\n  return value === 'netease' || value === 'qq' ? value : null;\n}",
         "function asSource(value: unknown): MusicSource | null {\n  return typeof value === 'string' && value.length > 0 ? value : null;\n}"),
    ],
)

# ---------------- settings.ts：默认平台放开 ----------------
apply(
    SRC + r"\core\settings.ts",
    "settings.ts",
    [
        ("export type OnlineSourceId = 'netease' | 'qq';",
         "export type OnlineSourceId = 'netease' | 'qq' | (string & {});"),
        ("const SOURCES: readonly OnlineSourceId[] = ['netease', 'qq'];",
         "// 默认平台只做「非空字符串」校验，具体平台由宿主清单决定，新增平台不用改这里。\nconst SOURCES: readonly OnlineSourceId[] = [];"),
        ("      defaultSource: asEnum(playback.defaultSource, SOURCES, DEFAULT_SETTINGS.playback.defaultSource),",
         "      defaultSource:\n        typeof playback.defaultSource === 'string' && playback.defaultSource\n          ? playback.defaultSource\n          : DEFAULT_SETTINGS.playback.defaultSource,"),
    ],
)

# ---------------- app.ts：平台列表/登录方式/角标动态化 ----------------
apply(
    SRC + r"\ui\app.ts",
    "app.ts",
    [
        ("import { SOURCE_LABEL } from '../online/types';",
         "import { SOURCE_LABEL } from '../online/types';\nimport {\n  accountSourceIds,\n  sourceDescriptors,\n  sourceHasDaily30,\n  sourceIds,\n  sourceMeta,\n} from '../online/sources';"),
        ("""      (['netease', 'qq'] as OnlineSource[]).forEach((item) => {""",
         """      (sourceIds() as OnlineSource[]).forEach((item) => {"""),
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
        ("""                : h('div', { class: 'source-dot ' + source, text: source === 'qq' ? 'Q' : '网' }),""",
         """                : h('div', { class: 'source-dot ' + source, text: sourceMeta(source).short }),"""),
        ("""        h('div', { class: `source-dot ${source}`, text: source === 'qq' ? 'Q' : '网' }),""",
         """        h('div', { class: `source-dot ${source}`, text: sourceMeta(source).short }),"""),
        ("    const source: OnlineSource = qqDaily ? 'qq' : (this.preferredSource() ?? 'netease');",
         "    const source: OnlineSource = qqDaily\n      ? (((sourceIds() as OnlineSource[]).find((item) => sourceHasDaily30(item)) ?? this.preferredSource()) as OnlineSource)\n      : (this.preferredSource() ?? 'netease');"),
    ],
)
