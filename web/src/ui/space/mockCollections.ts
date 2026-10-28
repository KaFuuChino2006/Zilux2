/**
 * 「唱片店」演示数据（R3）
 *
 * 正式接入前用来验证两区结构：后墙 5 个分类 + 右墙大唱片架翻页。
 * R5 会替换成真实的今日推荐 / 我喜欢的音乐 / 最近播放 / 歌单数据。
 */

import type { StoreSceneCollection } from './storeScene';

const BASE_TRACKS: ReadonlyArray<readonly [string, string, string]> = [
  ['夜色落在唱片上', 'Zilux2 试听', '午夜唱片'],
  ['old songs keep turning', 'muque', 'bestie'],
  ['暖光沿着纹路慢慢走', '演示歌手', '黑胶练习曲'],
  ['夜航星', '不才', '夜航星'],
  ['霓虹甜心', '夏日入侵企画', '我想了太多'],
  ['如果你也听说', '张惠妹', 'Star'],
  ['南方的秋天', '宿羽阳', '十一种孤独'],
  ['慢慢喜欢你', '莫文蔚', '我们在中场相遇'],
  ['まちがいさがし', '菅田将暉', 'まちがいさがし'],
  ['打上花火', 'DAOKO × 米津玄師', '打上花火'],
  ['雨のち晴れ', 'Vaundy', 'strobo'],
  ['Midnight Pretenders', 'Tomoko Aran', 'Fuyu-Kukan'],
];

const VARIANT_LABELS = ['', ' · Live', ' · Acoustic', ' · Demo'];

const MENU: ReadonlyArray<{ id: string; title: string; subtitle: string; accent: string }> = [
  { id: 'daily', title: '今日推荐', subtitle: '每天 6:00 更新', accent: '#c9a068' },
  { id: 'liked', title: '我喜欢的音乐', subtitle: '收藏的唱片', accent: '#8fb3a6' },
  { id: 'recent', title: '最近播放', subtitle: '最近在听的', accent: '#9a7fb0' },
  { id: 'playlists', title: '我的歌单', subtitle: '全部歌单', accent: '#7f9bb5' },
  { id: 'radar', title: '私人雷达', subtitle: '为你推荐', accent: '#b58b7a' },
];

const SONG_COUNT_PER_COLLECTION = 30;

function songsFor(collectionIndex: number): StoreSceneCollection['songs'] {
  const songs: StoreSceneCollection['songs'] = [];
  for (let i = 0; i < SONG_COUNT_PER_COLLECTION; i += 1) {
    const [title, artist, album] = BASE_TRACKS[i % BASE_TRACKS.length];
    const round = Math.floor(i / BASE_TRACKS.length) % VARIANT_LABELS.length;
    songs.push({
      trackKey: `mock-${collectionIndex}-${i}`,
      title: `${title}${VARIANT_LABELS[round]}`,
      artist,
      album,
      color: ['#8a5a34', '#7a4a34', '#5a6a4a', '#45586a', '#6a4a5e', '#8a6a3a'][(i + collectionIndex) % 6],
    });
  }
  return songs;
}

export function mockCollections(): StoreSceneCollection[] {
  return MENU.map((menu, index) => ({
    id: menu.id,
    title: menu.title,
    subtitle: menu.subtitle,
    songs: songsFor(index),
  }));
}
