/**
 * 「音乐地铁图」M1 假数据（确定性，无随机）。
 *
 * 输出 5 条线、78 个去重站点、4 个跨线换乘站，规格见
 * research/tmp/metro-m1/contract.md §6 与方案 §10 M1：
 *   daily    今日推荐线  sunrise  普通  20 站
 *   liked    我喜欢环线  rose     环线  16 站（loop）
 *   recent   最近播放线  sea      普通  18 站
 *   pl-night 夜行电子线  forest   普通  16 站（歌单）
 *   radar    私人雷达线  ghost    虚线  12 站（dashed，规划中）
 *
 * 设计约束：
 *   - 纯数据：不 import 布局/渲染/相机模块，不写 DOM；
 *   - 确定性：同一进程内多次调用结果深度相等（所有 id / source / trackKey 都按出现顺序推导）；
 *   - 换乘站 = 同一个 `station.id` 被两条线的 `stationIds` 共享，歌曲对象也复用（同一首歌、同一个 trackKey）：
 *       daily∩liked、liked∩recent、recent∩pl-night、daily∩radar 各 1 个，
 *       且分别落在各线的不同区间（避免全挤在端点、也避免相邻）；
 *   - 站 id 按「第一次出现」顺序编号 `st-0 … st-77`，`trackKey` 同序编号 `mock:0 … mock:77`；
 *   - 歌名 / 歌手 / 专辑均为虚构，中文、日文、英文混排，模拟一张真实运营歌单的选曲品味。
 */

import type {
  MetroData,
  MetroLine,
  MetroLineSource,
  MetroSong,
  MetroStationSeed,
  MetroTone,
} from './types';

/** `分:秒` → 毫秒：歌单数据用 mm:ss 写更接近真实，也方便目测是否落在 2:20–5:10 区间。 */
function mmss(minute: number, second: number): number {
  return (minute * 60 + second) * 1000;
}

/** 一首歌的种子：`trackKey` / `source` / `id` 由构建阶段按出现顺序统一生成。 */
interface SongSeed {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationMs: number;
}

/**
 * 换乘锚点：第一次出现时建站，之后凡引用同一锚点的线路共享同一站、同一首歌。
 * 四个锚点分别落在各线的不同区间（daily 5/15、liked 4/12、recent 5/12、pl-night 9、radar 3）。
 */
type TransferAnchor = 'daily-liked' | 'liked-recent' | 'recent-night' | 'daily-radar';

/** 换乘站对应的那首歌（只在第一次出现的线路上建站，后续线路直接复用）。 */
const TRANSFER_SONGS: Record<TransferAnchor, SongSeed> = {
  'daily-liked': { title: '路灯下的猫', artist: '小鹿观察日记', album: '街区黄昏', durationMs: mmss(3, 37) },
  'liked-recent': { title: '蓝色海岸线', artist: '海盐柠檬', album: '潮汐记录', durationMs: mmss(3, 56) },
  'recent-night': { title: '电子羊', artist: '像素牧场', album: '电子羊', durationMs: mmss(3, 19) },
  'daily-radar': { title: '在终点站等你', artist: '电波少年', album: '环线以外', durationMs: mmss(4, 36) },
};

/** 一条线上的槽位：一首新歌，或引用前面已经出现过的换乘站。 */
type LineSlot = SongSeed | { readonly link: TransferAnchor };

/** 一条线路的种子（slots 按轨道顺序排列；环线首尾不重复）。 */
interface LineSeed {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly tone: MetroTone;
  readonly loop: boolean;
  readonly dashed: boolean;
  readonly source: MetroLineSource;
  readonly slots: ReadonlyArray<LineSlot>;
}

/** 线路配置：顺序固定 daily → liked → recent → pl-night → radar，构建时按此顺序发号。 */
const LINE_SEEDS: ReadonlyArray<LineSeed> = [
  {
    id: 'daily',
    name: '今日推荐线',
    subtitle: '每天 6:00 更新 · 为你挑的 20 首',
    tone: 'sunrise',
    loop: false,
    dashed: false,
    source: 'daily',
    slots: [
      { title: '晚风会替我记得', artist: '林岛叶', album: '海边的房间', durationMs: mmss(4, 12) },
      { title: '周五下午四点', artist: '面包与汽水', album: '慢速生活', durationMs: mmss(3, 26) },
      { title: '玻璃汽水', artist: '甜味剂乐队', album: '气泡与海', durationMs: mmss(3, 48) },
      { title: '你像夏天的云', artist: '陈以约', album: '二十二度', durationMs: mmss(4, 3) },
      { title: '橙子汽水车间', artist: '白日梦工厂', album: '甜味剂', durationMs: mmss(2, 58) },
      { link: 'daily-liked' },
      { title: '地铁三号线', artist: '城市漫游者', album: '周五夜车', durationMs: mmss(4, 21) },
      { title: '把夕阳折好', artist: '禾木四重奏', album: '折纸黄昏', durationMs: mmss(3, 9) },
      { title: '慢半拍', artist: '阿洛与狗', album: '慢半拍', durationMs: mmss(2, 47) },
      { title: '便利店之歌', artist: '三十分钟乐队', album: '二十四小时', durationMs: mmss(3, 33) },
      { title: '你会不会也在听', artist: '云中邮差', album: '同一片雨', durationMs: mmss(4, 44) },
      { title: '白噪音晚安', artist: '春日收音机', album: '白噪音', durationMs: mmss(3, 15) },
      { title: '早班车前的雨', artist: '李见山', album: '城市湿度', durationMs: mmss(4, 8) },
      { title: '夏夜巡游', artist: '霓虹邮局', album: '巡游', durationMs: mmss(3, 52) },
      { title: '一颗橘子', artist: '花园信号', album: '酸甜', durationMs: mmss(2, 35) },
      { link: 'daily-radar' },
      { title: '夏の終わりのバス', artist: '青い車窓', album: 'バス停', durationMs: mmss(3, 32) },
      { title: '把房间开到最大声', artist: '陈小满', album: '声量', durationMs: mmss(3, 58) },
      { title: '便利店关东煮', artist: '深夜食堂乐队', album: '深夜菜单', durationMs: mmss(2, 52) },
      { title: '我们沿着河走', artist: '蓝调周末', album: '河岸', durationMs: mmss(5, 2) },
    ],
  },
  {
    id: 'liked',
    name: '我喜欢环线',
    subtitle: '收藏的歌 · 一圈一圈循环',
    tone: 'rose',
    loop: true,
    dashed: false,
    source: 'liked',
    slots: [
      { title: '星星落在你肩上', artist: '白桃罐头', album: '星星罐头', durationMs: mmss(4, 18) },
      { title: '和你一起听的老唱片', artist: '苏晚', album: '老唱片', durationMs: mmss(3, 44) },
      { title: '恋爱气象台', artist: '甜味剂乐队', album: '天气预报', durationMs: mmss(3, 12) },
      { title: '深夜出租车', artist: '城市漫游者', album: '夜班司机', durationMs: mmss(4, 29) },
      { link: 'liked-recent' },
      { title: '房间里的潮汐', artist: '云中邮差', album: '潮汐', durationMs: mmss(4, 5) },
      { title: '你写的信', artist: '林岛叶', album: '慢递', durationMs: mmss(3, 38) },
      { title: '玻璃球里的夏天', artist: '白日梦工厂', album: '玻璃球', durationMs: mmss(3, 17) },
      { title: '五月雨', artist: '春日收音机', album: '五月', durationMs: mmss(4, 1) },
      { title: '只在你耳边唱', artist: '陈以约', album: '耳语', durationMs: mmss(2, 44) },
      { title: '一起去海边吧', artist: '花园信号', album: '周末计划', durationMs: mmss(3, 29) },
      { title: '夜风收藏家', artist: '霓虹邮局', album: '收藏', durationMs: mmss(3, 35) },
      { link: 'daily-liked' },
      {
        title: 'ネオンとコーヒー',
        artist: '喫茶アンダーグラウンド',
        album: '夜更けのメニュー',
        durationMs: mmss(3, 46),
      },
      { title: '我们的秘密基地', artist: '面包与汽水', album: '秘密基地', durationMs: mmss(3, 50) },
      { title: '永远听起来像这样', artist: '蓝调周末', album: '循环播放', durationMs: mmss(4, 57) },
    ],
  },
  {
    id: 'recent',
    name: '最近播放线',
    subtitle: '最近 7 天 · 按播放顺序',
    tone: 'sea',
    loop: false,
    dashed: false,
    source: 'recent',
    slots: [
      { title: '九点半的海', artist: '海盐柠檬', album: '退潮', durationMs: mmss(4, 2) },
      { title: '房间角落的光', artist: '低空飞行', album: '角落', durationMs: mmss(3, 24) },
      { title: '折返跑', artist: '阿洛与狗', album: '折返跑', durationMs: mmss(2, 56) },
      { title: '玻璃电梯', artist: '电波少年', album: '城市垂直', durationMs: mmss(3, 41) },
      { title: '雨停之后', artist: '苏晚', album: '雨停之后', durationMs: mmss(4, 33) },
      { link: 'recent-night' },
      { title: '高速公路上的月亮', artist: '深夜食堂乐队', album: '高速公路', durationMs: mmss(4, 47) },
      { title: '和我去远方', artist: '云中邮差', album: '远方', durationMs: mmss(3, 57) },
      { title: '停止营业的咖啡馆', artist: '小鹿观察日记', album: '打烊之后', durationMs: mmss(3, 31) },
      { title: '日常的噪音', artist: '城市漫游者', album: '日常', durationMs: mmss(4, 11) },
      { title: '夏天的最后一场雨', artist: '花园信号', album: '最后一场雨', durationMs: mmss(3, 46) },
      { title: '凌晨三点的便利店', artist: '面包与汽水', album: '凌晨三点', durationMs: mmss(3, 8) },
      { link: 'liked-recent' },
      { title: '陪你慢慢走', artist: '林岛叶', album: '步行速度', durationMs: mmss(4, 26) },
      { title: '海まで徒歩五分', artist: '潮騒レコード', album: '徒歩五分', durationMs: mmss(4, 6) },
      { title: '退潮以后', artist: '海盐柠檬', album: '退潮以后', durationMs: mmss(4, 39) },
      { title: '你说今天想听什么', artist: '陈以约', album: '点播', durationMs: mmss(3, 14) },
      { title: '城市的背面', artist: '霓虹邮局', album: '背面', durationMs: mmss(5, 6) },
    ],
  },
  {
    id: 'pl-night',
    name: '夜行电子线',
    subtitle: '歌单 · 深夜通勤的电子氛围',
    tone: 'forest',
    loop: false,
    dashed: false,
    source: 'playlist',
    slots: [
      { title: '霓虹隧道', artist: '像素牧场', album: '隧道', durationMs: mmss(4, 14) },
      { title: '午夜列车', artist: '电波少年', album: '午夜列车', durationMs: mmss(5, 2) },
      { title: '频率 98.7', artist: '低空电台', album: '调频', durationMs: mmss(3, 48) },
      { title: '数据流星', artist: '像素牧场', album: '数据流星', durationMs: mmss(4, 36) },
      { title: '凌晨四点的城市', artist: '夜班司机', album: '夜班', durationMs: mmss(3, 27) },
      { title: '电子萤火虫', artist: '发光二极管', album: '萤火', durationMs: mmss(3, 55) },
      { title: '合成器日落', artist: 'Synth Sunset Club', album: 'Neon Ridge', durationMs: mmss(4, 22) },
      { title: '低频心跳', artist: '夜班司机', album: '心跳频率', durationMs: mmss(3, 39) },
      { title: '无人的地下通道', artist: '电波少年', album: '地下', durationMs: mmss(4, 58) },
      { link: 'recent-night' },
      { title: '城市休眠模式', artist: '像素牧场', album: '休眠', durationMs: mmss(4, 7) },
      { title: '霓虹雨', artist: '发光二极管', album: '雨夜信号', durationMs: mmss(3, 43) },
      { title: '高速公路电子', artist: '夜班司机', album: '高速', durationMs: mmss(5, 9) },
      { title: '程序化梦境', artist: 'Synth Sunset Club', album: 'Night Protocol', durationMs: mmss(4, 1) },
      { title: '夜明けのハイウェイ', artist: '夜行バンド', album: '夜明け前', durationMs: mmss(4, 44) },
      { title: '天亮之前关掉城市', artist: '像素牧场', album: '断电', durationMs: mmss(5, 4) },
    ],
  },
  {
    id: 'radar',
    name: '私人雷达线',
    subtitle: '规划中 · 根据口味生成的未知道路',
    tone: 'ghost',
    loop: false,
    dashed: true,
    source: 'radar',
    slots: [
      { title: '不存在的唱片店', artist: '灰盒乐队', album: '灰盒', durationMs: mmss(4, 23) },
      { title: '未发行的小样', artist: '地下录音室', album: '未发行', durationMs: mmss(3, 16) },
      { title: '静电与灰尘', artist: 'Cotton Static', album: 'Grey Room', durationMs: mmss(4, 9) },
      { link: 'daily-radar' },
      { title: '蒙尘的合成器', artist: '灰盒乐队', album: '灰尘', durationMs: mmss(3, 52) },
      { title: '凌晨的实验', artist: '深夜实验室', album: '实验记录', durationMs: mmss(4, 31) },
      { title: '低分辨率夏天', artist: 'Pixel Garden', album: 'Low Summer', durationMs: mmss(3, 28) },
      { title: '磁带反转', artist: '回收站乐队', album: '磁带', durationMs: mmss(4, 12) },
      { title: '透明な午後', artist: 'ガラス越しの庭', album: '透明な午後', durationMs: mmss(4, 28) },
      { title: '电台故障', artist: '信号丢失', album: '干扰', durationMs: mmss(3, 37) },
      { title: '打烊后的黑胶店', artist: '灰盒乐队', album: '黑胶', durationMs: mmss(4, 26) },
      { title: '宇宙尽头的便利店', artist: 'Paper Moon Club', album: '尽头', durationMs: mmss(4, 52) },
    ],
  },
];

/** 已收藏站点（`线路 id:站序`）：共 8 个、分散在各线，视觉上刷星标。 */
const LIKED_SPOTS: ReadonlySet<string> = new Set([
  'daily:2',
  'daily:9',
  'liked:1',
  'liked:14',
  'recent:3',
  'recent:15',
  'pl-night:6',
  'radar:7',
]);

/** 停运灰站（无版权下架）：recent 线给 1 个，视觉验证 `closed` 状态用。 */
const CLOSED_SPOT = 'recent:9';

/** 由种子生成完整 `MetroSong`：`netease`/`qq` 按出现顺序交错，id 为对应平台的数字串。 */
function makeSong(seed: SongSeed, index: number): MetroSong {
  const source = index % 2 === 0 ? 'netease' : 'qq';
  return {
    trackKey: `mock:${index}`,
    title: seed.title,
    artist: seed.artist,
    album: seed.album,
    durationMs: seed.durationMs,
    source,
    id: source === 'netease' ? String(1900000000 + index * 9173) : String(102000000 + index * 7919),
  };
}

/** M1 假数据：5 条线、60–80 站、4 个换乘站；确定性（不随机），每次调用返回全新且等价的数据。 */
export function mockMetroData(): MetroData {
  const stations: Record<string, MetroStationSeed> = {};
  const lines: MetroLine[] = [];
  /** 换乘锚点 → 第一次建站时的 station.id。 */
  const anchorStations = new Map<TransferAnchor, string>();
  let stationSeq = 0;
  let songSeq = 0;

  /** 新建站点并登记歌曲；station.id 与 trackKey 的编号同序递增（st-n ↔ mock:n）。 */
  const addStation = (seed: SongSeed): string => {
    const id = `st-${stationSeq}`;
    stations[id] = {
      id,
      song: makeSong(seed, songSeq),
      lineIds: [],
      indexInLine: {},
      type: 'single',
    };
    stationSeq += 1;
    songSeq += 1;
    return id;
  };

  for (const seed of LINE_SEEDS) {
    const stationIds: string[] = [];
    for (const slot of seed.slots) {
      if ('link' in slot) {
        let stationId = anchorStations.get(slot.link);
        if (stationId === undefined) {
          // 换乘站第一次出现：正常建站；后续线路引用同一 id（同站同歌）。
          stationId = addStation(TRANSFER_SONGS[slot.link]);
          anchorStations.set(slot.link, stationId);
        }
        stationIds.push(stationId);
      } else {
        stationIds.push(addStation(slot));
      }
    }
    lines.push({
      id: seed.id,
      name: seed.name,
      subtitle: seed.subtitle,
      tone: seed.tone,
      loop: seed.loop,
      dashed: seed.dashed,
      stationIds,
      source: seed.source,
    });
  }

  // 第二遍：补 lineIds / indexInLine（type 依赖「被几条线引用」，必须等全部线路建完）。
  for (const line of lines) {
    line.stationIds.forEach((stationId, index) => {
      const station = stations[stationId];
      station.lineIds.push(line.id);
      station.indexInLine[line.id] = index;
    });
  }

  // 第三遍：站点类型与装饰状态（收藏 / 停运）。
  for (const line of lines) {
    const lastIndex = line.stationIds.length - 1;
    line.stationIds.forEach((stationId, index) => {
      const station = stations[stationId];
      const spot = `${line.id}:${index}`;
      if (station.lineIds.length >= 2) station.type = 'transfer';
      else station.type = index === 0 || index === lastIndex ? 'terminus' : 'single';
      if (LIKED_SPOTS.has(spot)) station.liked = true;
      if (spot === CLOSED_SPOT) station.closed = true;
    });
  }

  return { lines, stations };
}
