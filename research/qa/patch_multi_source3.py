# -*- coding: utf-8 -*-
"""多平台接口（app.ts 动态化，用全局替换避免重复缩进锚点）。"""
import io

PATH = r"E:\Zilux2开发\web\src\ui\app.ts"

with io.open(PATH, "r", encoding="utf-8", newline="") as fh:
    text = fh.read()
E = "\r\n" if "\r\n" in text else "\n"


def sub(old, new, expected, label=""):
    global text
    o, n = old.replace("\n", E), new.replace("\n", E)
    count = text.count(o)
    assert count == expected, f"{label or old[:40]} 期望 {expected} 实际 {count}"
    text = text.replace(o, n)


sub(
    "import { SOURCE_LABEL } from '../online/types';",
    "import { SOURCE_LABEL } from '../online/types';\n"
    "import {\n"
    "  accountSourceIds,\n"
    "  sourceDescriptors,\n"
    "  sourceHasDaily30,\n"
    "  sourceIds,\n"
    "  sourceMeta,\n"
    "} from '../online/sources';",
    1,
    "import sources",
)
sub("(['netease', 'qq'] as OnlineSource[])", "(sourceIds() as OnlineSource[])", 1, "搜索分段")
sub(
    "            { value: 'netease', label: '网易云' },\n            { value: 'qq', label: 'QQ 音乐' },",
    "            ...sourceDescriptors().map((item) => ({ value: item.id, label: item.label })),",
    1,
    "默认平台分段",
)
sub("['netease', 'qq'] as AccountSource[]", "accountSourceIds() as AccountSource[]", 2, "账号循环")
sub("only ? [only] : ['netease', 'qq']", "only ? [only] : (accountSourceIds() as AccountSource[])", 1, "登录卡来源")
sub("text: source === 'qq' ? 'Q' : '网'", "text: sourceMeta(source).short", 2, "平台角标")
sub(
    "    const source: OnlineSource = qqDaily ? 'qq' : (this.preferredSource() ?? 'netease');",
    "    const source: OnlineSource = qqDaily\n"
    "      ? (((sourceIds() as OnlineSource[]).find((item) => sourceHasDaily30(item)) ??\n"
    "          this.preferredSource() ??\n"
    "          'qq') as OnlineSource)\n"
    "      : (this.preferredSource() ?? 'netease');",
    1,
    "每日30首平台",
)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(text)
print("app.ts OK")
