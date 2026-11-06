/** 设置 → 存储：宿主磁盘缓存的统计、清理与预算。 */

import { api } from './client';

export interface DiskCacheItem {
  id: string;
  label: string;
  bytes: number;
  files: number;
  clearable: boolean;
  note?: string;
}

export interface DiskCacheUsage {
  root: string;
  limitMb: number;
  minMb: number;
  maxMb: number;
  defaultMb: number;
  totalBytes: number;
  items: DiskCacheItem[];
}

export interface DiskCacheClearResult {
  cleared: string[];
  freedBytes: number;
  failed: number;
  needsRestart: boolean;
  totalBytes: number;
}

export interface DiskCacheLimitResult {
  limitMb: number;
  removed: number;
  freedBytes: number;
  totalBytes: number;
}

export function fetchDiskCache(): Promise<DiskCacheUsage> {
  return api<DiskCacheUsage>('/api/storage/cache', {}, 12_000);
}

export function clearDiskCache(id?: string): Promise<DiskCacheClearResult> {
  return api<DiskCacheClearResult>('/api/storage/cache/clear', {}, 60_000, 'POST', id ? { id } : {});
}

export function setDiskCacheLimit(limitMb: number): Promise<DiskCacheLimitResult> {
  return api<DiskCacheLimitResult>('/api/storage/cache/limit', {}, 60_000, 'POST', { limitMb });
}
