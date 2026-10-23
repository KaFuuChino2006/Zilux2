# -*- coding: utf-8 -*-
"""把「歌词出入场动画」与「歌词逐字动画」合并为一个可展开/收起的「歌词动画」分组。"""
import io


def patch(path, pairs, label):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for name, old, new in pairs:
        assert s.count(old) == 1, f"anchor miss [{label}:{name}]: {old[:80]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'patched {label}')


ss = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
css = r"E:\Zilux2开发\web\src\styles\space.css"

old_sections = """          <section class="custom-section">
            <header class="custom-section-head">
              <span class="custom-kicker">歌词</span>
              <div>
                <h3>出入场动画</h3>
                <p>3D 歌词每一句进入、离开的方式</p>
              </div>
            </header>
            <div class="custom-field">
              <div class="custom-label"><span>出入场方式</span><b data-lyric-enter-label>淡入</b></div>
              <div class="custom-seg" data-lyric-enter-seg>
                <button class="custom-seg-btn is-on" data-lyric-enter="fade" type="button">淡入</button>
                <button class="custom-seg-btn" data-lyric-enter="slide" type="button">滑入</button>
                <button class="custom-seg-btn" data-lyric-enter="zoom" type="button">弹入</button>
                <button class="custom-seg-btn" data-lyric-enter="tilt" type="button">翻折</button>
              </div>
              <p class="custom-tip">只在 3D 歌词播放界面生效，仅影响本机</p>
            </div>
          </section>
          <section class="custom-section">
            <header class="custom-section-head">
              <span class="custom-kicker">逐字</span>
              <div>
                <h3>歌词逐字动画</h3>
                <p>逐字点亮、逐字出现与书写效果</p>
              </div>
            </header>
            <div class="custom-field custom-words">
              <div class="custom-label"><span>逐字点亮</span><b data-words-fill-current>开</b></div>
              <div class="custom-seg" data-words-fill-seg>
                <button class="custom-seg-btn is-on" data-words-fill="on" type="button">开</button>
                <button class="custom-seg-btn" data-words-fill="off" type="button">关</button>
              </div>
              <p class="custom-tip">唱到哪个字，哪个字变亮</p>
            </div>
            <div class="custom-field custom-words">
              <div class="custom-label"><span>逐字出现</span><b data-words-appear-current>淡入</b></div>
              <div class="custom-seg" data-words-appear-seg>
                <button class="custom-seg-btn" data-words-appear="off" type="button">无</button>
                <button class="custom-seg-btn is-on" data-words-appear="fade" type="button">淡入</button>
              </div>
              <p class="custom-tip">每个字在自己的时间点单独淡入</p>
            </div>
            <div class="custom-field custom-words">
              <div class="custom-label"><span>拼字动画</span><b data-words-write-current>关</b></div>
              <div class="custom-seg" data-words-write-seg>
                <button class="custom-seg-btn" data-words-write="on" type="button">开</button>
                <button class="custom-seg-btn is-on" data-words-write="off" type="button">关</button>
              </div>
              <p class="custom-tip">把每个字拆成笔画，按笔顺一笔一笔拼起来（首次开启会加载笔顺数据）</p>
            </div>
          </section>"""

new_sections = """          <section class="custom-section custom-collapse" data-lyrics-anim>
            <header class="custom-section-head custom-collapse-head">
              <span class="custom-kicker">歌词</span>
              <div>
                <h3>歌词动画</h3>
                <p data-lyrics-anim-summary>淡入 · 逐字点亮 · 逐字淡入</p>
              </div>
              <button class="custom-collapse-btn" data-lyrics-anim-toggle type="button" aria-expanded="true">收起</button>
            </header>
            <div class="custom-collapse-body" data-lyrics-anim-body>
              <div class="custom-field">
                <div class="custom-label"><span>出入场方式</span><b data-lyric-enter-label>淡入</b></div>
                <div class="custom-seg" data-lyric-enter-seg>
                  <button class="custom-seg-btn is-on" data-lyric-enter="fade" type="button">淡入</button>
                  <button class="custom-seg-btn" data-lyric-enter="slide" type="button">滑入</button>
                  <button class="custom-seg-btn" data-lyric-enter="zoom" type="button">弹入</button>
                  <button class="custom-seg-btn" data-lyric-enter="tilt" type="button">翻折</button>
                </div>
                <p class="custom-tip">3D 歌词每一句进入、离开的方式</p>
              </div>
              <div class="custom-field custom-words">
                <div class="custom-label"><span>逐字点亮</span><b data-words-fill-current>开</b></div>
                <div class="custom-seg" data-words-fill-seg>
                  <button class="custom-seg-btn is-on" data-words-fill="on" type="button">开</button>
                  <button class="custom-seg-btn" data-words-fill="off" type="button">关</button>
                </div>
                <p class="custom-tip">唱到哪个字，哪个字变亮</p>
              </div>
              <div class="custom-field custom-words">
                <div class="custom-label"><span>逐字出现</span><b data-words-appear-current>淡入</b></div>
                <div class="custom-seg" data-words-appear-seg>
                  <button class="custom-seg-btn" data-words-appear="off" type="button">无</button>
                  <button class="custom-seg-btn is-on" data-words-appear="fade" type="button">淡入</button>
                </div>
                <p class="custom-tip">每个字在自己的时间点单独淡入</p>
              </div>
              <div class="custom-field custom-words">
                <div class="custom-label"><span>拼字动画</span><b data-words-write-current>关</b></div>
                <div class="custom-seg" data-words-write-seg>
                  <button class="custom-seg-btn" data-words-write="on" type="button">开</button>
                  <button class="custom-seg-btn is-on" data-words-write="off" type="button">关</button>
                </div>
                <p class="custom-tip">把每个字拆成笔画，按笔顺一笔一笔拼起来（首次开启会加载笔顺数据）</p>
              </div>
            </div>
          </section>"""

patch(ss, [
    ('template merge', old_sections, new_sections),
    (
        'default custom',
        "    lyricMode: 'stage' as 'stage' | 'pv',\n  };",
        "    lyricMode: 'stage' as 'stage' | 'pv',\n    lyricAnimOpen: true,\n  };",
    ),
    (
        'load custom',
        "        lyricMode: parsed.lyricMode === 'pv' ? 'pv' : 'stage',",
        "        lyricMode: parsed.lyricMode === 'pv' ? 'pv' : 'stage',\n        lyricAnimOpen: parsed.lyricAnimOpen !== false,",
    ),
    (
        'refs',
        "  const lyricEnterLabel = root.querySelector<HTMLElement>('[data-lyric-enter-label]')!;",
        """  const lyricEnterLabel = root.querySelector<HTMLElement>('[data-lyric-enter-label]')!;
  const lyricsAnimBody = root.querySelector<HTMLElement>('[data-lyrics-anim-body]')!;
  const lyricsAnimToggle = root.querySelector<HTMLButtonElement>('[data-lyrics-anim-toggle]')!;
  const lyricsAnimSummary = root.querySelector<HTMLElement>('[data-lyrics-anim-summary]')!;""",
    ),
    (
        'sync custom',
        "    wordsWriteCurrent.textContent = custom.wordsWrite ? '开' : '关';",
        """    wordsWriteCurrent.textContent = custom.wordsWrite ? '开' : '关';
    lyricsAnimBody.hidden = !custom.lyricAnimOpen;
    lyricsAnimToggle.textContent = custom.lyricAnimOpen ? '收起' : '展开';
    lyricsAnimToggle.setAttribute('aria-expanded', custom.lyricAnimOpen ? 'true' : 'false');
    lyricsAnimSummary.textContent = [
      LYRIC_ENTER_LABELS[custom.lyricEnter],
      custom.wordsFill ? '逐字点亮' : '整句点亮',
      custom.wordsAppear === 'fade' ? '逐字淡入' : '无逐字浮现',
      custom.wordsWrite ? '拼字书写' : '常规字形',
    ].join(' · ');""",
    ),
    (
        'toggle listener',
        "  lyricEnterBtns.forEach((button) => {\n    button.addEventListener('click', () => {",
        """  lyricsAnimToggle.addEventListener('click', () => {
    custom.lyricAnimOpen = !custom.lyricAnimOpen;
    persistCustom();
    syncCustomUi();
  });
  lyricEnterBtns.forEach((button) => {
    button.addEventListener('click', () => {""",
    ),
], 'spaceShell')

s = io.open(css, 'r', encoding='utf-8', newline='').read()
s += """
/* 歌词动画分组：可展开/收起 */
.custom-collapse-head {
  align-items: flex-start;
  justify-content: space-between;
}
.custom-collapse-head > div {
  flex: 1;
}
.custom-collapse-btn {
  flex: none;
  margin-left: auto;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid rgba(120, 132, 160, 0.28);
  background: rgba(255, 255, 255, 0.72);
  color: var(--text-mute);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
}
.custom-collapse-btn:hover {
  background: rgba(106, 92, 255, 0.1);
  border-color: rgba(106, 92, 255, 0.35);
  color: var(--text);
}
.custom-collapse-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}
.custom-collapse-body[hidden] {
  display: none;
}
"""
io.open(css, 'w', encoding='utf-8', newline='').write(s)
print('css collapse')
