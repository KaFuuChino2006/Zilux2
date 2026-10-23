import io

path = r'E:\Zilux2开发\web\src\ui\app.ts'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
nl = '\r\n' if '\r\n' in text else '\n'


def sub(name, old, new, count=1):
    global text
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == count, '%s: expected %d, got %d' % (name, count, got)
    text = text.replace(old, new)


# 1) 侧栏删掉「每日推荐」（首页今日推荐就是它）
sub(
    'rail daily entry',
    "      { key: 'daily', label: '每日推荐', iconName: 'calendar', onClick: () => void this.showDailyWall() },\n",
    '',
)

# 2) 首页今日推荐改成多平台合并
sub(
    'loadHomeData daily',
    """    let recent: OnlineTrack[] = [];
    let daily: OnlineTrack[] = [];
    if (preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent failed', err);
      }
      try {
        daily = (await fetchFeed(preferred, 'daily', 14)).tracks;
      } catch (err) {
        console.warn('[app] home daily failed', err);
      }
    }""",
    """    let recent: OnlineTrack[] = [];
    if (preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent failed', err);
      }
    }
    let daily: OnlineTrack[] = [];
    let dailyLabel = preferred ? SOURCE_LABEL[preferred] : '';
    try {
      const merged = await this.fetchDailyMerged(12);
      if (merged.tracks.length > 0) {
        daily = merged.tracks;
        dailyLabel = merged.label;
      }
    } catch (err) {
      console.warn('[app] home daily failed', err);
    }""",
)

sub(
    'loadHomeData dailySource',
    "      dailySource: preferred ?? 'netease',",
    "      dailySource: dailyLabel,",
)

# 3) 多平台今日推荐：合并 + 交替排序
sub(
    'daily merged helpers',
    "  private async showRecentWall(): Promise<void> {",
    """  /** 把多个平台的今日推荐按轮次交错合并（同一平台不会连续刷屏）。 */
  private interleaveDaily(lists: OnlineTrack[][]): OnlineTrack[] {
    const merged: OnlineTrack[] = [];
    const seen = new Set<string>();
    const longest = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < longest; index += 1) {
      for (const list of lists) {
        const item = list[index];
        if (!item) continue;
        const key = `${item.source}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    return merged;
  }

  /** 取所有已登录平台的今日推荐并合并；返回轨道 + 展示用的平台名。 */
  private async fetchDailyMerged(limitPerSource: number): Promise<{ tracks: OnlineTrack[]; label: string; sources: string[] }> {
    const known = sourceIds();
    const sources = getAccounts()
      .filter((item) => item.loggedIn && known.includes(item.source))
      .map((item) => item.source);
    if (sources.length === 0) return { tracks: [], label: '', sources: [] };
    const lists = await Promise.all(
      sources.map(async (source) => {
        try {
          return (await fetchFeed(source, 'daily', limitPerSource)).tracks;
        } catch (err) {
          console.warn('[app] daily source failed', source, err);
          return [] as OnlineTrack[];
        }
      }),
    );
    const labels = sources
      .filter((source, index) => lists[index].length > 0)
      .map((source) => sourceMeta(source)?.label ?? SOURCE_LABEL[source] ?? source);
    return {
      tracks: this.interleaveDaily(lists),
      label: labels.length > 0 ? labels.join(' + ') : '',
      sources: sources.filter((source, index) => lists[index].length > 0),
    };
  }

  private async showRecentWall(): Promise<void> {""",
)

# 4) 每日推荐页：默认走多平台合并；每日 30 首仍是单平台
sub(
    'showDailyWall body',
    """  private async showDailyWall(qqDaily = false): Promise<void> {
    const source: OnlineSource = qqDaily
      ? (((sourceIds() as OnlineSource[]).find((item) => sourceHasDaily30(item)) ??
          this.preferredSource() ??
          'qq') as OnlineSource)
      : (this.preferredSource() ?? 'netease');
    if (!getAccounts().some((item) => item.loggedIn && item.source === source)) {
      toast(`登录${SOURCE_LABEL[source]}后才能看`);
      this.openLogin(source as AccountSource);
      return;
    }
    const title = qqDaily ? '每日 30 首' : '每日推荐';
    this.feedRailKey = qqDaily ? 'daily30' : 'daily';
    this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };
    this.renderWall();
    try {
      const feed = await fetchFeed(source, 'daily', qqDaily ? 30 : 60);
      this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`, tracks: feed.tracks };
      this.renderWall();
    } catch (err) {
      console.warn('[app] daily failed', err);
      toast('每日推荐读取失败', 'error');
    }
  }""",
    """  private async showDailyWall(qqDaily = false): Promise<void> {
    const title = qqDaily ? '每日 30 首' : '今日推荐';
    this.feedRailKey = qqDaily ? 'daily30' : '';

    if (qqDaily) {
      const source: OnlineSource = ((sourceIds() as OnlineSource[]).find((item) => sourceHasDaily30(item)) ??
        this.preferredSource() ??
        'qq') as OnlineSource;
      if (!getAccounts().some((item) => item.loggedIn && item.source === source)) {
        toast(`登录${SOURCE_LABEL[source]}后才能看`);
        this.openLogin(source as AccountSource);
        return;
      }
      this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };
      this.renderWall();
      try {
        const feed = await fetchFeed(source, 'daily', 30);
        this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`, tracks: feed.tracks };
        this.renderWall();
      } catch (err) {
        console.warn('[app] daily failed', err);
        toast('每日推荐读取失败', 'error');
      }
      return;
    }

    // 多平台合并的今日推荐
    const merged = await this.fetchDailyMerged(60);
    if (merged.tracks.length === 0) {
      toast('登录后才有今日推荐');
      this.openLogin();
      return;
    }
    this.wall = {
      kind: 'feed',
      title,
      subtitle: `${merged.label || '多平台'} · ${merged.tracks.length} 首`,
      tracks: merged.tracks,
    };
    this.renderWall();
  }""",
)

with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('app.ts: rail daily removed + multi-platform daily merged')
