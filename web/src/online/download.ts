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
  state: 'running' | 'done' | 'error';
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
