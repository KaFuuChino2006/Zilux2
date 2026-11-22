const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'src/ui/home.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/ui/app.ts'), 'utf8');
const client = fs.readFileSync(path.join(root, 'src/online/client.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8');
const qqProvider = fs.readFileSync(
  path.resolve(root, '../src/Zilux2/Online/Library/QqLibraryProvider.cs'),
  'utf8',
);
const neteaseProvider = fs.readFileSync(
  path.resolve(root, '../src/Zilux2/Online/Library/NeteaseLibraryProvider.cs'),
  'utf8',
);
const service = fs.readFileSync(
  path.resolve(root, '../src/Zilux2/Online/Library/LibraryService.cs'),
  'utf8',
);
const server = fs.readFileSync(
  path.resolve(root, '../src/Zilux2/Online/LocalMusicServer.cs'),
  'utf8',
);
const catalog = fs.readFileSync(
  path.resolve(root, '../src/Zilux2/Online/MusicSourceCatalog.cs'),
  'utf8',
);

// 维护者 2026-11-22：QQ 音乐首页的「猜你喜欢 / 百万收藏 / 新歌推荐」，
// 以及网易云的「私人雷达 / 私人漫游 / 相似歌曲」都要接进来。
test('QQ 侧：猜你喜欢走私人 FM，百万收藏 / 新歌推荐走官方算法歌单', () => {
  assert.match(qqProvider, /music\.radioProxy\.MbTrackRadioSvr/);
  assert.match(qqProvider, /get_radio_track/);
  assert.match(qqProvider, /\["id"\] = 99/);
  assert.match(qqProvider, /OfficialSongListParam\(211111\)/, '百万收藏');
  assert.match(qqProvider, /OfficialSongListParam\(211207\)/, '新歌推荐');
  assert.match(qqProvider, /uniform_get_Dissinfo/);
  // 每日三十首（dirid 202）的既有实现不许被这次改动弄坏
  assert.match(qqProvider, /\["dirid"\] = 202/);
});

test('网易云侧：私人漫游走 /api/v1/radio/get，相似歌曲走 /api/discovery/simiSong，私人雷达仍是固定歌单', () => {
  // /api/personal/fm 已经下线（上游 404），只能用旧入口 /api/v1/radio/get
  assert.match(neteaseProvider, /const string PersonalFmEndpoint = "https:\/\/music\.163\.com\/api\/v1\/radio\/get";/);
  assert.doesNotMatch(neteaseProvider, /"\/api\/personal\/fm"/);
  assert.match(neteaseProvider, /const string SimilarSongEndpoint = "https:\/\/music\.163\.com\/api\/discovery\/simiSong";/);
  assert.match(neteaseProvider, /string\.Equals\(kind, "roam", StringComparison\.Ordinal\)/);
  assert.match(neteaseProvider, /string\.Equals\(kind, "similar", StringComparison\.Ordinal\)/);
  // 私人雷达（固定 id 的个人化歌单）不许被改坏
  assert.match(neteaseProvider, /PrivateRadarPlaylistId = "3136952023"/);
  assert.match(neteaseProvider, /PrivateRadarTitle = "私人雷达"/);
  // 漫游一次只回 3 首，所以必须循环攒够再去重
  assert.match(neteaseProvider, /for \(var round = 0; round < 8 && tracks\.Count < limit; round\+\+\)/);
  assert.match(neteaseProvider, /!seen\.Add\(track\.Id\)/);
  // 相似歌曲上游一次只回 5 首，要拿多个种子摊开
  assert.match(neteaseProvider, /\.Take\(3\)/);
});

test('相似歌曲的种子：前台没传 songId 时用本机最近播放的前几首（逗号拼接，宿主逐个取再去重）', () => {
  assert.match(server, /if \(string\.Equals\(kind, "similar", StringComparison\.OrdinalIgnoreCase\)\)/);
  assert.match(server, /seedId = \(query\["songId"\] \?\? string\.Empty\)\.Trim\(\);/);
  assert.match(server, /_recent\s*\.List\(source, 3\)/);
  assert.match(server, /seedId = seeds\.Length > 0 \? string\.Join\(',', seeds\) : null;/);
  assert.match(server, /library\.GetFeedAsync\(source, kind, limit, token, seedId\)/);
});

test('host 只给对应平台放行这些 kind，其它平台给出明确拒绝', () => {
  assert.match(service, /"guess"/);
  assert.match(service, /"million"/);
  assert.match(service, /"newsong"/);
  assert.match(service, /"roam"/);
  assert.match(service, /"similar"/);
  assert.match(service, /AccountSources\.Qq/);
  assert.match(service, /只支持 QQ 音乐/);
  assert.match(service, /if \(kind is "radar" or "roam" or "similar" && source != AccountSources\.Netease\)/);
  assert.match(service, /私人雷达 \/ 私人漫游 \/ 相似歌曲目前只支持网易云音乐/);
});

test('能力清单同步：网易云带 roam/similar，QQ 带 guess/million/newsong', () => {
  assert.match(catalog, /FeedKinds = \["recent", "daily", "radar", "roam", "similar"\]/);
  assert.match(catalog, /FeedKinds = \["recent", "daily", "guess", "million", "newsong"\]/);
});

test('web 侧 kind 全档贯通到 /api/library/feed，相似歌曲能带 songId', () => {
  assert.match(
    client,
    /export type FeedKind = 'recent' \| 'daily' \| 'radar' \| 'roam' \| 'similar' \| 'guess' \| 'million' \| 'newsong';/,
  );
  assert.match(client, /私人漫游/);
  assert.match(client, /相似歌曲/);
  assert.match(client, /猜你喜欢/);
  assert.match(client, /百万收藏/);
  assert.match(client, /新歌推荐/);
  assert.match(client, /\.\.\.\(songId \? \{ songId \} : \{\}\),/);
});

test('首页：推荐行按平台分组出卡，播放全部不再去别处扩队列', () => {
  assert.match(home, /export type HomeSpecialKind = 'roam' \| 'similar' \| 'guess' \| 'million' \| 'newsong';/);
  assert.match(home, /onSpecial\(kind: HomeSpecialKind\): void;/);
  assert.match(home, /for \(const section of this\.buildSpecialSections\(data\.specials\)\) this\.root\.append\(section\);/);
  assert.match(home, /private buildSpecialSections\(items: HomeSpecial\[\]\): HTMLElement\[\]/);
  assert.match(home, /source === 'netease' \? '网易云推荐' : source === 'qq' \? 'QQ 音乐推荐' : '酷狗推荐'/);
  assert.match(home, /private buildSpecialCard\(item: HomeSpecial\)/);
  assert.match(home, /onPlay\(item\.tracks, 0, 'special', item\.kind\)/);
  assert.match(app, /if \(scope === 'special'\) \{/);
  assert.match(app, /if \(specialKind === 'roam'\) this\.armRoamRefill\(\);/);
});

test('首页取数：只拉已登录平台的推荐行，单块失败不影响其它块，签名跟着换', () => {
  assert.match(app, /const SPECIAL_SOURCE: Record<HomeSpecialKind, OnlineSource> = \{/);
  assert.match(app, /const SPECIAL_LIMIT: Record<HomeSpecialKind, number> = \{/);
  assert.match(app, /kind: 'roam', label: '私人漫游'/);
  assert.match(app, /kind: 'similar', label: '相似歌曲'/);
  assert.match(app, /kind: 'guess', label: '猜你喜欢'/);
  assert.match(app, /kind: 'million', label: '百万收藏'/);
  assert.match(app, /kind: 'newsong', label: '新歌推荐'/);
  assert.match(
    app,
    /data\.specials\.map\(\(item\) => `\$\{item\.source\}:\$\{item\.kind\}:\$\{tracks\(item\.tracks\)\}`\)\.join\('\|'\)/,
  );
  assert.match(app, /console\.warn\('\[app\] special failed'/);
});

test('整页歌单：未登录先弹对应平台的登录，空壳铺好再换成真实内容', () => {
  assert.match(app, /private async showSpecialWall\(kind: HomeSpecialKind\)/);
  assert.match(app, /const source = SPECIAL_SOURCE\[kind\];/);
  assert.match(app, /toast\(`登录\$\{platform\}后才能看\$\{label\}`\);/);
  assert.match(app, /this\.openLogin\(source as AccountSource\)/);
  assert.match(app, /this\.wall = \{ kind: 'feed', title: label, subtitle: `\$\{platform\} · 同步中…`, tracks: \[\], feedSource: source, feedKind: kind \};/);
  assert.match(app, /fetchFeed\(source, kind, SPECIAL_LIMIT\[kind\]\)/);
  assert.match(app, /const SPECIAL_LABEL: Record<HomeSpecialKind, string> = \{/);
});

test('推荐行的卡片复用收藏卡容器，等宽排布', () => {
  assert.match(css, /\.home \.home-collections\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.home \.home-collections > \.home-liked\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(home, /h\('div', \{ class: 'home-collections' \}\)/);
});

test('私人漫游：播放续接器 + 滚到底部自动补一批，相似歌曲可换基准', () => {
  assert.match(app, /feedSource\?: OnlineSource;/);
  assert.match(app, /feedKind\?: FeedKind;/);
  assert.match(app, /feedSeedTitle\?: string;/);
  assert.match(app, /feedSeedId\?: string;/);
  assert.match(app, /private armRoamRefill\(\): void \{/);
  assert.match(app, /setQueueRefill\(async \(\) => \(await fetchFeed\('netease', 'roam', 12\)\)\.tracks\)/);
  assert.match(app, /private armStreamRefill\(\): void \{/);
  assert.match(app, /private async growRoamWall\(\): Promise<void> \{/);
  assert.match(app, /private maybeGrowRoamWall\(\): void \{/);
  assert.match(app, /this\.maybeGrowRoamWall\(\);/);
  assert.match(app, /this\.appendPosters\(grid as HTMLElement, fresh, start, this\.wall\.tracks, 0\)/);
  assert.match(app, /private async rerollSimilarSeed\(\): Promise<void> \{/);
  assert.match(app, /if \(playing && playing\.source === 'netease' && playing\.id !== current\)/);
  assert.match(app, /换一首基准/);
  assert.match(app, /以这首歌为基准找相似/);
  assert.match(app, /if \(kind === 'similar'\) \{\s*await this\.showSimilarWall\(\);\s*return;\s*\}/);
  assert.match(app, /private async showSimilarWall\(seedId\?: string, seedTitle\?: string\): Promise<void> \{/);
  assert.match(app, /base = seedName \? `网易云音乐 · 以「\$\{seedName\}」为基准` : '网易云音乐 · 从你最近听的歌出发'/);
});
