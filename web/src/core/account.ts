/**
 * 账号登录客户端（Account v1，docs/zilux2-account-login.md）。
 *
 * 宿主在回环 HTTP 服务上提供 /api/account、/api/account/login/qr、/api/account/login/status、
 * /api/account/logout（全部要求 ?token=，与在线音乐共用端口与 token）。
 * 无宿主时 ?mock=1 走内置假流程（约 3 秒后登录成功），仅用于界面验收。
 */

import { host } from './bridge';
import { accountSourceIds, sourceLoginMode } from '../online/sources';
import {
  OnlineError,
  isMockOnline,
  onlineInfo,
  onlineReady,
  onOnlineChange,
} from '../online/client';

// 账号来源同样开放：具体平台由宿主 /api/sources 决定。
export type AccountSource = 'netease' | 'qq' | (string & {});

function accountSources(): AccountSource[] {
  return accountSourceIds() as AccountSource[];
}

export interface AccountInfo {
  source: AccountSource;
  loggedIn: boolean;
  nickname?: string;
  /** 已转 data URL，可直接用于 <img src> */
  avatarDataUrl?: string;
  /** true = 有会员权益；false = 无；null = 平台未提供/未知 */
  vip?: boolean | null;
  userId?: string;
  /** 宿主登录检测（第四十六轮）判定 cookie 已失效时为 true；正常账号不写该字段 */
  expired?: boolean;
  /** 失效原因（平台返回码 / 说明），仅 expired 时有值 */
  reason?: string;
}

/** 一次登录检测发现的问题（宿主后台验证或手动「检查登录状态」）。 */
export interface AccountIssue {
  source: AccountSource;
  reason: string;
  /** 发现时间（毫秒时间戳） */
  at: number;
}

export interface AccountState {
  sources: AccountInfo[];
}

export type LoginState = 'waiting' | 'scanned' | 'authorized' | 'expired' | 'refused' | 'error';

export interface LoginSession {
  source: AccountSource;
  mode: 'code' | 'image';
  key: string;
  /** mode === 'code'：二维码内容（网易云由前端用 qrcode 渲染） */
  content?: string;
  /** mode === 'image'：二维码图片（QQ 直接展示） */
  imageDataUrl?: string;
  /** 有效期（秒） */
  expiresIn: number;
}

export interface LoginStatus {
  state: LoginState;
  message?: string;
  /** authorized 时返回账号信息 */
  account?: AccountInfo;
}

type AccountListener = (changed: AccountSource | null, accounts: AccountInfo[]) => void;
type AccountIssueListener = (issue: AccountIssue) => void;

const cache = new Map<AccountSource, AccountInfo>();
const listeners = new Set<AccountListener>();
const issues = new Map<AccountSource, AccountIssue>();
const issueListeners = new Set<AccountIssueListener>();
let initialized = false;
let refreshing: Promise<void> | null = null;
let verifying: Promise<AccountIssue[]> | null = null;
let verifyTimer = 0;

/* ------------------------------------------------------------------ */
/* 对外状态                                                            */
/* ------------------------------------------------------------------ */

/** 读取当前账号态（两个源都会返回，未登录为 loggedIn:false）。 */
export function getAccounts(): AccountInfo[] {
  return accountSources().map((source) => cache.get(source) ?? { source, loggedIn: false });
}

/** 读取单个源的账号态。 */
export function accountOf(source: AccountSource): AccountInfo {
  return cache.get(source) ?? { source, loggedIn: false };
}

/** 订阅账号态变化；changed 为 null 表示批量刷新（例如启动时首次加载）。 */
export function onAccountChange(cb: AccountListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 最近一次登录检测发现的失效平台（按平台去重，重新登录/验证有效后自动清除）。 */
export function recentAccountIssues(): AccountIssue[] {
  return [...issues.values()];
}

/** 订阅「检测到登录失效」事件（宿主后台检测或手动检查都会触发）。 */
export function onAccountIssue(cb: AccountIssueListener): () => void {
  issueListeners.add(cb);
  return () => issueListeners.delete(cb);
}

/**
 * 登录状态检测（第四十六轮）：让宿主用已保存的 cookie 问平台是否还有效。
 * 失效的平台会记一条 issue 并回调订阅者，账号缓存同步为未登录。
 */
export async function verifyAccounts(): Promise<AccountIssue[]> {
  if (isMockOnline() || !onlineReady()) return [];
  if (verifying) return verifying;
  const task = (async (): Promise<AccountIssue[]> => {
    const found: AccountIssue[] = [];
    try {
      const resp = await request<{
        sources?: Array<Partial<AccountInfo> & { status?: string; reason?: string }>;
      }>('/api/account/verify', {}, 'GET', 25_000);
      let changed = false;
      for (const item of resp.sources ?? []) {
        const info = normalize(item);
        if (!info) continue;
        if (item.status === 'expired') {
          const issue = recordIssue(info.source, info.reason ?? '登录已失效，请重新登录');
          found.push(issue);
          cache.set(info.source, { ...info, loggedIn: false });
          changed = true;
        } else if (item.status === 'valid') {
          clearIssue(info.source);
          cache.set(info.source, info);
          changed = true;
        }
      }
      if (changed) notify(null);
    } catch (err) {
      host.log('warn', `[account] verify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return found;
  })();
  verifying = task;
  try {
    return await task;
  } finally {
    verifying = null;
  }
}

function recordIssue(source: AccountSource, reason: string): AccountIssue {
  const issue: AccountIssue = { source, reason, at: Date.now() };
  issues.set(source, issue);
  issueListeners.forEach((cb) => {
    try {
      cb(issue);
    } catch (err) {
      console.warn('[account] issue listener failed', err);
    }
  });
  return issue;
}

function clearIssue(source: AccountSource): void {
  issues.delete(source);
}

/** 启动后延迟做一次登录检测（宿主后台也会每 5 分钟查一次）。 */
function scheduleVerify(): void {
  if (verifyTimer) return;
  verifyTimer = window.setTimeout(() => {
    verifyTimer = 0;
    void verifyAccounts();
  }, 4_000);
}

/* ------------------------------------------------------------------ */
/* 初始化与刷新                                                        */
/* ------------------------------------------------------------------ */

export function initAccount(): void {
  if (initialized) return;
  initialized = true;

  // 宿主主动推送的账号态变化（例如在其它窗口完成登录/登出）
  host.onMessage((msg) => {
    if (msg.type !== 'host' || msg.event !== 'account') return;
    applyPush(msg.payload);
  });

  if (isMockOnline()) return;

  onOnlineChange(() => {
    if (onlineReady()) {
      void refreshAccounts().then(() => scheduleVerify());
    }
  });
  if (onlineReady()) {
    void refreshAccounts().then(() => scheduleVerify());
  }
}

/** 用 /api/account 形态的数据整体覆盖本地缓存（缺失的源置为未登录）。 */
function applySources(items: Partial<AccountInfo>[] | undefined): void {
  const next = new Map<AccountSource, AccountInfo>();
  for (const item of items ?? []) {
    const info = normalize(item);
    if (info) next.set(info.source, info);
  }
  for (const source of accountSources()) {
    if (!next.has(source)) next.set(source, { source, loggedIn: false });
  }
  cache.clear();
  next.forEach((value, key) => cache.set(key, value));
}

/** 拉取 /api/account 覆盖本地缓存。未连接宿主/演示模式时静默返回。 */
export async function refreshAccounts(): Promise<void> {
  if (isMockOnline() || !onlineReady()) return;
  // 已有请求在飞时直接等它，而不是立刻 return：否则启动动画里的账号检测会拿到空的缓存，
  // 把「已登录」误判成「未登录」，于是载入完还是落在登录选择页。
  if (refreshing) return refreshing;
  const task = (async (): Promise<void> => {
    try {
      const resp = await request<{ sources?: Partial<AccountInfo>[] }>('/api/account', {}, 'GET');
      applySources(resp.sources);
      notify(null);
    } catch (err) {
      host.log('warn', `[account] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  refreshing = task;
  try {
    await task;
  } finally {
    refreshing = null;
  }
}

/** 宿主推送：兼容 {sources:[...]} 与单条 {source,...} 两种形态。 */
function applyPush(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as { sources?: unknown };
  if (Array.isArray(record.sources)) {
    const next = new Map<AccountSource, AccountInfo>();
    for (const item of record.sources) {
      const info = normalize(item as Partial<AccountInfo>);
      if (!info) continue;
      next.set(info.source, info);
      if (info.expired) {
        recordIssue(info.source, info.reason ?? '登录已失效，请重新登录');
      } else if (info.loggedIn) {
        clearIssue(info.source);
      }
    }
    for (const source of accountSources()) {
      if (!next.has(source)) next.set(source, { source, loggedIn: false });
    }
    cache.clear();
    next.forEach((value, key) => cache.set(key, value));
    notify(null);
    return;
  }
  const single = normalize(payload as Partial<AccountInfo>);
  if (!single) return;
  cache.set(single.source, single);
  if (single.expired) {
    recordIssue(single.source, single.reason ?? '登录已失效，请重新登录');
  } else if (single.loggedIn) {
    clearIssue(single.source);
  }
  notify(single.source);
}

/* ------------------------------------------------------------------ */
/* 扫码登录 API                                                        */
/* ------------------------------------------------------------------ */

export async function requestQr(source: AccountSource): Promise<LoginSession> {
  if (isMockOnline()) return mockRequestQr(source);
  const resp = await request<Partial<LoginSession>>(
    '/api/account/login/qr',
    { source },
    'POST',
  );
  const mode = resp.mode === 'image' ? 'image' : 'code';
  const expiresIn =
    typeof resp.expiresIn === 'number' && resp.expiresIn > 0
      ? resp.expiresIn
      : mode === 'image'
        ? 180
        : 300;
  const session: LoginSession = {
    source,
    mode,
    key: typeof resp.key === 'string' ? resp.key : '',
    expiresIn,
  };
  if (typeof resp.content === 'string') session.content = resp.content;
  if (typeof resp.imageDataUrl === 'string') session.imageDataUrl = resp.imageDataUrl;
  if (!session.key) throw new OnlineError('bad-response', '登录会话创建失败（缺少 key）');
  if (mode === 'code' && !session.content) {
    throw new OnlineError('bad-response', '登录会话创建失败（缺少二维码内容）');
  }
  if (mode === 'image' && !session.imageDataUrl) {
    throw new OnlineError('bad-response', '登录会话创建失败（缺少二维码图片）');
  }
  return session;
}

export async function pollLogin(source: AccountSource, key: string): Promise<LoginStatus> {
  if (isMockOnline()) return mockPollLogin(source, key);
  const resp = await request<Partial<LoginStatus>>(
    '/api/account/login/status',
    { source, key },
    'GET',
  );
  const state = parseLoginState(resp.state);
  const status: LoginStatus = { state };
  if (typeof resp.message === 'string' && resp.message) status.message = resp.message;
  if (resp.account) {
    const account = normalize({ ...resp.account, source });
    if (account) {
      status.account = account;
      cache.set(source, account);
      notify(source);
    }
  }
  if (state === 'authorized') {
    if (!status.account && !cache.get(source)?.loggedIn) {
      // 宿主只回 state 时先标记为已登录，再异步补齐昵称/头像
      cache.set(source, { source, loggedIn: true });
      notify(source);
    }
    void refreshAccounts();
  }
  return status;
}

export async function logout(source: AccountSource): Promise<void> {
  if (isMockOnline()) {
    mockSessions.clear();
    cache.set(source, { source, loggedIn: false });
    notify(source);
    return;
  }
  await request<{ ok?: boolean }>('/api/account/logout', { source }, 'POST');
  cache.set(source, { source, loggedIn: false });
  notify(source);
  void refreshAccounts();
}

/**
 * 浏览器 Cookie 手动导入（扫码风控失败时的兜底，docs/zilux2-account-login.md §9）。
 *
 * 宿主 `POST /api/account/import?token=` 的 body 为 `{ source, cookie }`，成功返回与
 * `/api/account` 同构的数据；校验失败返回 `invalid-cookie`。Cookie 值只在请求体中传输，
 * 前端不打印、不回显。mock 模式下延时约 0.7 秒后直接模拟成功，便于界面验收。
 */
export async function importCookie(
  source: AccountSource,
  cookie: string,
): Promise<AccountState> {
  const trimmed = cookie.trim();
  if (!trimmed) {
    throw new OnlineError('invalid-cookie', '请先粘贴该平台的 Cookie');
  }
  if (isMockOnline()) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 650));
    const account: AccountInfo = {
      source,
      loggedIn: true,
      nickname: MOCK_NICKNAME[source],
      avatarDataUrl: mockAvatar(source),
      vip: source === 'netease',
      userId: source === 'netease' ? '90123456' : '10001',
    };
    cache.set(source, account);
    notify(source);
    return { sources: getAccounts() };
  }
  const resp = await request<{ sources?: Partial<AccountInfo>[] }>(
    '/api/account/import',
    { source },
    'POST',
    20_000,
    { source, cookie: trimmed },
  );
  applySources(resp.sources);
  notify(null);
  return { sources: getAccounts() };
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

const LOGIN_STATES: LoginState[] = ['waiting', 'scanned', 'authorized', 'expired', 'refused', 'error'];

function parseLoginState(value: unknown): LoginState {
  return typeof value === 'string' && (LOGIN_STATES as string[]).includes(value)
    ? (value as LoginState)
    : 'error';
}

function normalize(input: Partial<AccountInfo> | undefined): AccountInfo | null {
  if (!input || typeof input !== 'object') return null;
  const source: AccountSource | null =
    typeof input.source === 'string' && input.source ? (input.source.toLowerCase() as AccountSource) : null;
  if (!source) return null;
  const info: AccountInfo = { source, loggedIn: input.loggedIn === true };
  if (typeof input.nickname === 'string' && input.nickname.trim()) info.nickname = input.nickname;
  if (typeof input.avatarDataUrl === 'string' && input.avatarDataUrl.startsWith('data:image/')) {
    info.avatarDataUrl = input.avatarDataUrl;
  }
  info.vip = input.vip === true ? true : input.vip === false ? false : null;
  if (typeof input.userId === 'string' && input.userId) info.userId = input.userId;
  if (input.expired === true) info.expired = true;
  if (typeof input.reason === 'string' && input.reason.trim()) info.reason = input.reason;
  return info;
}

function notify(changed: AccountSource | null): void {
  const accounts = getAccounts();
  listeners.forEach((cb) => {
    try {
      cb(changed, accounts);
    } catch (err) {
      console.warn('[account] listener failed', err);
    }
  });
}

/** 与 online/client.ts 的 api 同款：回环 HTTP + token + 中文错误。 */
async function request<T>(
  path: string,
  params: Record<string, string>,
  method: 'GET' | 'POST',
  timeoutMs = 12_000,
  body?: unknown,
): Promise<T> {
  const info = onlineInfo();
  if (!info) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({ ...params, token: info.token });
  const url = `http://127.0.0.1:${info.port}${path}?${query.toString()}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = { method, signal: controller.signal, cache: 'no-store' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  try {
    const resp = await fetch(url, init);
    const type = resp.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      if (!resp.ok) throw new OnlineError(`http-${resp.status}`, `网络请求失败（${resp.status}）`);
      throw new OnlineError('bad-response', '上游返回了无法解析的内容');
    }
    const body = (await resp.json()) as T & { error?: string; message?: string };
    if (!resp.ok) {
      throw new OnlineError(
        body.error ?? `http-${resp.status}`,
        body.message ?? `请求失败（${resp.status}）`,
      );
    }
    return body as T;
  } catch (err) {
    if (err instanceof OnlineError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new OnlineError('timeout', '请求超时，请稍后重试');
    }
    throw new OnlineError('network', '无法连接在线源，请确认宿主已启动');
  } finally {
    window.clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* mock：仅 ?mock=1（无宿主本地预览）时启用，约 3 秒后登录成功           */
/* ------------------------------------------------------------------ */

const MOCK_AUTHORIZE_MS = 2_800;
const MOCK_SCANNED_MS = 1_100;

interface MockSession {
  source: AccountSource;
  start: number;
  expiresIn: number;
}

const mockSessions = new Map<string, MockSession>();

const MOCK_NICKNAME: Record<AccountSource, string> = {
  netease: '夜航星（演示）',
  qq: '星河漫游者（演示）',
};

function mockRequestQr(source: AccountSource): Promise<LoginSession> {
  const key = `mock-${source}-${Date.now().toString(36)}`;
  // 演示模式只支持扫码两种形态；cookie 登录（酷狗）走设置里的导入，不进这种 mock。
  const mode = sourceLoginMode(source) === 'code' ? 'code' : 'image';
  mockSessions.set(key, {
    source,
    start: Date.now(),
    expiresIn: mode === 'image' ? 180 : 300,
  });
  const session: LoginSession = { source, mode, key, expiresIn: 300 };
  if (mode === 'code') {
    session.content = `https://music.163.com/login?codekey=${key}`;
  } else {
    session.imageDataUrl = mockQrImage(source);
  }
  return Promise.resolve(session);
}

function mockPollLogin(source: AccountSource, key: string): Promise<LoginStatus> {
  const session = mockSessions.get(key);
  if (!session || session.source !== source) {
    return Promise.resolve({ state: 'expired', message: '二维码已过期' });
  }
  const elapsed = Date.now() - session.start;
  if (elapsed >= session.expiresIn * 1000) {
    mockSessions.delete(key);
    return Promise.resolve({ state: 'expired', message: '二维码已过期' });
  }
  if (elapsed >= MOCK_AUTHORIZE_MS) {
    const account: AccountInfo = {
      source,
      loggedIn: true,
      nickname: MOCK_NICKNAME[source],
      avatarDataUrl: mockAvatar(source),
      vip: source === 'netease',
      userId: source === 'netease' ? '90123456' : '10001',
    };
    cache.set(source, account);
    notify(source);
    return Promise.resolve({ state: 'authorized', message: '登录成功', account });
  }
  if (elapsed >= MOCK_SCANNED_MS) {
    return Promise.resolve({ state: 'scanned', message: '已扫码，请在手机上确认' });
  }
  return Promise.resolve({ state: 'waiting', message: '等待扫码' });
}

/** 演示用「二维码」：伪随机黑白块 + 三个定位角，仅用于视觉验收。 */
function mockQrImage(seed: string): string {
  const size = 240;
  const cell = 10;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const rand = (): number => {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return (hash >>> 0) / 0xffffffff;
  };
  ctx.fillStyle = '#1a1f2b';
  const margin = 2;
  const cells = Math.floor(size / cell) - margin * 2;
  const isFinder = (col: number, row: number): boolean => {
    const inSquare = (x: number, y: number): boolean =>
      col >= x && col < x + 7 && row >= y && row < y + 7;
    return inSquare(0, 0) || inSquare(cells - 7, 0) || inSquare(0, cells - 7);
  };
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      if (isFinder(col, row)) continue;
      if (rand() > 0.54) {
        ctx.fillRect((col + margin) * cell, (row + margin) * cell, cell, cell);
      }
    }
  }
  const finder = (col: number, row: number): void => {
    const x = (col + margin) * cell;
    const y = (row + margin) * cell;
    ctx.fillStyle = '#1a1f2b';
    ctx.fillRect(x, y, cell * 7, cell * 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + cell, y + cell, cell * 5, cell * 5);
    ctx.fillStyle = '#1a1f2b';
    ctx.fillRect(x + cell * 2, y + cell * 2, cell * 3, cell * 3);
  };
  finder(0, 0);
  finder(cells - 7, 0);
  finder(0, cells - 7);
  return canvas.toDataURL('image/png');
}

/** 演示用头像：渐变底 + 首字。 */
function mockAvatar(source: AccountSource): string {
  const size = 112;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const colors: [string, string] =
    source === 'netease' ? ['#ff6b6b', '#c2185b'] : ['#5df2ff', '#8b7bff'];
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '600 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(source === 'netease' ? '云' : 'Q', size / 2, size / 2 + 2);
  return canvas.toDataURL('image/png');
}
