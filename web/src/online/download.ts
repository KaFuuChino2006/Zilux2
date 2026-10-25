/** 在线歌曲下载：宿主把解析出的播放地址整首拉到本地文件；页面只负责发起与查询进度。 */
import { api } from './client';
import type { OnlineTrack, StreamQuality } from './types';

export interface DownloadJob {
  id: string;
  source: string;
  trackId: string;
  title: string;
  artist: string;
  /** 实际请求的音质（standard/high/lossless，平台不支持时自动降级）。 */
  quality: string;
  state: 'running' | 'paused' | 'done' | 'error';
  received: number;
  total: number;
  fileName: string;
  path?: string;
  error?: string;
}

export interface DownloadList {
  directory: string;
  jobs: DownloadJob[];
}

export interface DownloadStartResult {
  directory: string;
  job: DownloadJob;
}

export async function fetchDownloads(): Promise<DownloadList> {
  return api<DownloadList>('/api/downloads');
}

export async function startDownload(track: OnlineTrack, quality?: StreamQuality): Promise<DownloadStartResult> {
  return api<DownloadStartResult>(
    '/api/download',
    undefined,
    20_000,
    'POST',
    {
      source: track.source,
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      ...(quality ? { quality } : {}),
    },
  );
}

export async function revealDownload(id: string): Promise<void> {
  await api('/api/download/reveal', undefined, 8_000, 'POST', { id });
}

/* ---- 队列控制：暂停 / 继续 / 取消 / 清空已完成（宿主 API v1） ---- */

/** 暂停一个进行中的下载任务（宿主保留已下载部分，可继续）。 */
export async function pauseDownload(id: string): Promise<void> {
  await api('/api/download/pause', undefined, 8_000, 'POST', { id });
}

/** 继续一个已暂停的下载任务。 */
export async function resumeDownload(id: string): Promise<void> {
  await api('/api/download/resume', undefined, 8_000, 'POST', { id });
}

/** 取消任务（进行中或已暂停）：宿主停止下载并从队列移除该记录，不删除已落盘文件。 */
export async function cancelDownload(id: string): Promise<void> {
  await api('/api/download/cancel', undefined, 8_000, 'POST', { id });
}

/** 清空已完成/失败的任务记录（只清列表，不动磁盘文件）；返回清掉的数量。 */
export async function clearFinishedDownloads(): Promise<number> {
  const result = await api<{ cleared?: number }>('/api/download/clear', undefined, 8_000, 'POST');
  return typeof result?.cleared === 'number' ? result.cleared : 0;
}
