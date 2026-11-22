/**
 * 分轨名称与默认增益（共享定义）。
 *
 * 历史：这里原本还有「抓 30 秒窗口离线放一遍」的 `startStemSolo`，已被
 * `stemLive.ts` 的实时跟播取代（用户要的是边听边拆）。加载/排程逻辑都在
 * `stemLive.ts`，本文件只保留两侧都要用的名字、标签与默认值。
 */

export type StemName = 'vocals' | 'drums' | 'bass' | 'other';

export const STEM_NAMES: StemName[] = ['vocals', 'drums', 'bass', 'other'];

export const STEM_LABELS: Record<StemName, string> = {
  vocals: '人声',
  drums: '鼓',
  bass: '贝斯',
  other: '其他',
};

/** 默认增益（dB）：四轨都 0 = 与母带逐样本一致（残差已归位进 other）。 */
export function defaultStemGains(): Record<StemName, number> {
  return { vocals: 0, drums: 0, bass: 0, other: 0 };
}
