// Zilux2 移植裁剪：只保留 formats 常量与类型（folia 原文件其余是扫描辅助逻辑）
export const LOCAL_LYRIC_FILE_FORMATS = ['lrc', 'vtt', 'ttml', 'qrc', 'yrc', 'krc'] as const;

export type LocalLyricFileFormat = typeof LOCAL_LYRIC_FILE_FORMATS[number];

export const DEFAULT_LOCAL_LYRIC_FORMAT_ORDER: readonly LocalLyricFileFormat[] = LOCAL_LYRIC_FILE_FORMATS;
