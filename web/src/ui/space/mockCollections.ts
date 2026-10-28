/**
 * 「唱片店」演示数据（R1 原型用）
 *
 * 仅用于预览页与设置里的空间预览入口；R3 会替换为真实的
 * 最近播放 / 我喜欢的音乐 / 推荐歌单数据。
 */

import type { StoreSceneCollection } from './storeScene';

const TEMP_TITLES: ReadonlyArray<readonly [string, string, string]> = [
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

export function mockCollections(): StoreSceneCollection[] {
  return [
    {
      id: 'recent',
      title: '最近播放',
      subtitle: 'R1 占位数据',
      songs: TEMP_TITLES.map(([title, artist, album], index) => ({
        trackKey: `mock-${index}`,
        title,
        artist,
        album,
      })),
    },
  ];
}
