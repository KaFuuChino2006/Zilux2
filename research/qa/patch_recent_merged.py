import io

server_path = r'E:\Zilux2开发\src\Zilux2\Online\LocalMusicServer.cs'
client_path = r'E:\Zilux2开发\web\src\online\client.ts'
app_path = r'E:\Zilux2开发\web\src\ui\app.ts'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def sub(text, name, old, new):
    nl = '\r\n' if '\r\n' in text else '\n'
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == 1, '%s: expected 1, got %d' % (name, got)
    return text.replace(old, new)


# ---------- 宿主：/api/library/recent/merged ----------
server = load(server_path)
server = sub(
    server,
    'route merged recent',
    '                "/api/library/feed" => isGet ? await HandleLibraryFeedAsync(context, CancellationToken.None).ConfigureAwait(false) : MethodNotAllowed(context),',
    '                "/api/library/feed" => isGet ? await HandleLibraryFeedAsync(context, CancellationToken.None).ConfigureAwait(false) : MethodNotAllowed(context),\n'
    '                "/api/library/recent/merged" => isGet ? await HandleRecentMergedAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),',
)
server = sub(
    server,
    'handler merged recent',
    "    private async Task<int> HandleLibraryLikeAsync(HttpListenerContext context)",
    """    /// <summary>
    /// 多平台「最近播放」融合：先放本软件自己的播放顺序，再按轮次并入各平台的最近播放，
    /// 所以别的设备在网易云 / QQ 音乐里刚播的歌也会按平台顺序插进来。
    /// </summary>
    private async Task<int> HandleRecentMergedAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var limit = 40;
        if (context.Request.QueryString["limit"] is { Length: > 0 } limitRaw &&
            (!int.TryParse(limitRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 60))
        {
            return WriteError(context, 400, "bad-request", "limit 参数非法");
        }

        var streams = new List<List<OnlineTrack>>
        {
            _recent.List(null, limit),
        };

        var library = _library;
        if (library is not null)
        {
            foreach (var source in _sources)
            {
                if (!LibraryService.IsKnownSource(source))
                {
                    continue;
                }

                try
                {
                    var feed = await library.GetFeedAsync(source, "recent", limit, _shutdown.Token).ConfigureAwait(false);
                    streams.Add(feed.Tracks
                        .Select(track => track with { Cover = BuildCoverUrl(track.Source, track.CoverKey) })
                        .ToList());
                }
                catch (Exception exception)
                {
                    // QQ 没有开放最近播放接口，缺一个平台不影响整体
                    OnlineHttp.Warn($"recent merged skipped source={source}: {OnlineHttp.Describe(exception)}");
                }
            }
        }

        var merged = new List<OnlineTrack>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var longest = streams.Count == 0 ? 0 : streams.Max(stream => stream.Count);
        for (var index = 0; index < longest && merged.Count < limit; index += 1)
        {
            foreach (var stream in streams)
            {
                if (index >= stream.Count)
                {
                    continue;
                }

                var track = stream[index];
                if (!seen.Add(track.Source + "|" + track.Id))
                {
                    continue;
                }

                merged.Add(track);
                if (merged.Count >= limit)
                {
                    break;
                }
            }
        }

        WriteJson(context, 200, JsonSerializer.Serialize(new { tracks = merged }));
        return 200;
    }

    private async Task<int> HandleLibraryLikeAsync(HttpListenerContext context)""",
)
save(server_path, server)
print('server merged recent endpoint')

# ---------- web client ----------
client = load(client_path)
client = sub(
    client,
    'client fetchRecentMerged',
    "export async function fetchLyric(source: OnlineSource, id: string): Promise<OnlineLyric> {",
    """/** 多平台融合的最近播放（本软件播放顺序 + 各平台最近播放）。 */
export async function fetchRecentMerged(limit = 40): Promise<OnlineTrack[]> {
  const data = await api<{ tracks: OnlineTrack[] }>('/api/library/recent/merged', { limit: String(limit) });
  return Array.isArray(data.tracks) ? data.tracks : [];
}

export async function fetchLyric(source: OnlineSource, id: string): Promise<OnlineLyric> {""",
)
save(client_path, client)
print('client fetchRecentMerged')

# ---------- app.ts ----------
app = load(app_path)
app = sub(
    app,
    'import fetchRecentMerged',
    """  fetchFeed,
  fetchHotPlaylists,
  onlineReady,""",
    """  fetchFeed,
  fetchHotPlaylists,
  fetchRecentMerged,
  onlineReady,""",
)
app = sub(
    app,
    'loadHomeData recent',
    """    let recent: OnlineTrack[] = [];
    if (preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent failed', err);
      }
    }""",
    """    let recent: OnlineTrack[] = [];
    try {
      recent = (await fetchRecentMerged(24)).slice(0, 14);
    } catch (err) {
      console.warn('[app] home recent failed', err);
    }
    if (recent.length === 0 && preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent fallback failed', err);
      }
    }""",
)
app = sub(
    app,
    'showRecentWall merged',
    """  private async showRecentWall(): Promise<void> {
    const source = this.preferredSource();
    if (!source) {
      toast('登录后才有最近播放');
      this.openLogin();
      return;
    }
    this.wall = { kind: 'recent', title: '最近播放', subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };
    this.renderWall();
    try {
      const feed = await fetchFeed(source, 'recent', 100);
      this.wall = {
        kind: 'recent',
        title: '最近播放',
        subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`,
        tracks: feed.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] recent wall failed', err);
      toast('最近播放读取失败', 'error');""",
    """  private async showRecentWall(): Promise<void> {
    this.wall = { kind: 'recent', title: '最近播放', subtitle: '多平台融合 · 同步中…', tracks: [] };
    this.renderWall();
    try {
      const merged = await fetchRecentMerged(60);
      if (merged.length > 0) {
        this.wall = {
          kind: 'recent',
          title: '最近播放',
          subtitle: `多平台融合 · ${merged.length} 首`,
          tracks: merged,
        };
        this.renderWall();
        return;
      }
      const source = this.preferredSource();
      if (!source) {
        toast('登录后才有最近播放');
        this.openLogin();
        return;
      }
      const feed = await fetchFeed(source, 'recent', 100);
      this.wall = {
        kind: 'recent',
        title: '最近播放',
        subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`,
        tracks: feed.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] recent wall failed', err);
      toast('最近播放读取失败', 'error');""",
)
save(app_path, app)
print('app.ts merged recent wired')
