import io

p = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
t = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """  void matchWordLyrics(track, base.lines)
    .then((result) => {
      if (lastDoc?.trackKey !== base.trackKey) return;
      lyricMatchDone = true;
      lyricMatchInfo = result;
      if (result?.lines) {
        lastDoc = { ...base, kind: result.kind === 'lrc' ? base.kind : result.kind, lines: result.lines };
        lyricSource = result.label;
        updateCurrentLyricLine();
      }
      notifyMatch();
    })
    .catch(() => {
      if (lastDoc?.trackKey !== base.trackKey) return;
      lyricMatchDone = true;
      lyricMatchInfo = null;
      notifyMatch();
    });"""

new = """  void matchWordLyrics(track, base.lines)
    .then((result) => {
      if (lastDoc?.trackKey !== base.trackKey) return;
      if (result?.lines || baseHasTranslation) {
        lyricMatchDone = true;
        lyricMatchInfo = result;
        if (result?.lines) {
          lastDoc = { ...base, kind: result.kind === 'lrc' ? base.kind : result.kind, lines: result.lines };
          lyricSource = result.label;
          updateCurrentLyricLine();
        }
        notifyMatch();
        return;
      }
      // 没匹配到逐字（本地 LRC / 在线整行歌词同理）：再向其它平台借一份翻译贴到现有歌词上
      void matchTranslation(track, base.lines)
        .then((translated) => {
          if (lastDoc?.trackKey !== base.trackKey) return;
          lyricMatchDone = true;
          lyricMatchInfo = translated ?? result;
          if (translated && lastDoc) {
            lastDoc = { ...lastDoc, lines: base.lines };
            updateCurrentLyricLine();
          }
          notifyMatch();
        })
        .catch(() => {
          if (lastDoc?.trackKey !== base.trackKey) return;
          lyricMatchDone = true;
          lyricMatchInfo = result;
          notifyMatch();
        });
    })
    .catch(() => {
      if (lastDoc?.trackKey !== base.trackKey) return;
      lyricMatchDone = true;
      lyricMatchInfo = null;
      notifyMatch();
    });"""

assert t.count(old) == 1
t = t.replace(old, new)

# 文案：翻译补齐模式的说明要覆盖「本地 LRC / 整行歌词借翻译」场景
old2 = """  if (lyricMatchInfo.translationOnly) {
    return `翻译取自 ${lyricMatchInfo.translationFromOther ?? '其它平台'}（${percent(lyricMatchInfo.score)}%）`;
  }"""
new2 = """  if (lyricMatchInfo.translationOnly) {
    return `翻译取自 ${lyricMatchInfo.translationFromOther ?? '其它平台'}（${percent(lyricMatchInfo.score)}%）`;
  }"""
assert t.count(old2) == 1

io.open(p, 'w', encoding='utf-8', newline='').write(t)
print('ok')
