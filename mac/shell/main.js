'use strict';

/**
 * Zilux2 mac 壳（Electron 主进程）。
 *
 * 目标：在 macOS（Apple Silicon）上承载 Windows 版同一份 web 前端（web/dist），
 * 并模拟 Windows 宿主（WPF + WebView2 + .NET 引擎）的窗口 / 宿主消息行为：
 *
 *   1. spawn 跨平台 .NET 引擎（同源 HTTP 服务：在线音乐 API + web/dist 静态文件）；
 *      引擎 stdout 打印 `ZILUX2_READY {"port":...,"token":...,"sources":[...]}` 后，
 *      用 http://127.0.0.1:<port>/index.html 加载页面（页面与 API 同源，无 CORS）。
 *   2. 用 preload.js 提供 window.chrome.webview 桥（postMessage / addEventListener），
 *      IPC 通道：页面 -> 宿主 `webview:post`，宿主 -> 页面 `webview:message`。
 *   3. 宿主消息协议与 Windows 版 WebViewHost.cs 对齐（ready / online / settings /
 *      fonts / airplay / window 命令等），协议细节见 mac/shell/README.md。
 *   4. 窗口：macOS 用 hiddenInset + trafficLightPosition；其它平台（Windows 联调）frame:false。
 *      页面自身的窗口按钮（minimize/toggleMaximize/close）通过 window 消息实现。
 *   5. AirPlay 在 mac 测试版移除：注入脚本隐藏「投送」入口，收到 airplay 指令只回 idle。
 *
 * 环境变量（开发 / 打包都支持）：
 *   ZILUX2_ENGINE    引擎可执行文件绝对路径（默认见 resolveEnginePath）
 *   ZILUX2_WEB_ROOT  web 静态根目录（默认见 resolveWebRoot）
 *   ZILUX2_USER_DATA 用户数据目录（settings.json / window.json / shell.log）
 *   ZILUX2_ALLOW_MULTI_INSTANCE=1 允许同机多实例（自动化测试用）
 *   ZILUX2_EXIT_ON_ERROR=1        启动失败时弹完错误窗口直接退出（自动化测试用）
 *   ZILUX2_URL       仅开发/联调：直接加载该 URL，跳过引擎（不 spawn、不推 online）
 *   ZILUX2_MOCK=1    仅开发/联调：页面加 ?mock=1 用内置演示数据（配合 ZILUX2_URL）
 *   ZILUX2_ENGINE 指向 .mjs/.js 时用 Electron 的 node 模式跑（dev/stub-engine.mjs）
 */

const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP_VERSION = '1.0.0';
const ENGINE_READY_PREFIX = 'ZILUX2_READY';
const ENGINE_ERROR_PREFIX = 'ZILUX2_ERROR';
const ENGINE_TIMEOUT_MS = 20_000;
const PAGE_READY_FALLBACK_MS = 8_000;

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const appDir = __dirname;
const repoRoot = path.resolve(appDir, '..', '..');

/** 首次启动失败时是否直接退出（自动化流水线用）。 */
const exitOnError = process.env.ZILUX2_EXIT_ON_ERROR === '1';

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

function firstExisting(candidates, check) {
  for (const candidate of candidates) {
    try {
      if (check ? check(candidate) : fs.existsSync(candidate)) return candidate;
    } catch {
      /* 忽略单个候选路径的探测异常 */
    }
  }
  return null;
}

function engineFileName() {
  return isWin ? 'Zilux2MacEngine.exe' : 'Zilux2MacEngine';
}

/**
 * 引擎路径解析顺序：
 *   1. 环境变量 ZILUX2_ENGINE（开发 + 联调都可用）
 *   2. 打包布局：<resources>/engine/Zilux2MacEngine(.exe)   （electron-builder extraResources）
 *   3. 同目录布局：<app>/engine/Zilux2MacEngine(.exe)        （win-test：resources/app/engine/）
 *   4. 仓库开发布局：<repo>/mac/engine/publish/{win-x64,osx-arm64}/Zilux2MacEngine(.exe)
 */
function resolveEnginePath() {
  const fromEnv = (process.env.ZILUX2_ENGINE || '').trim();
  if (fromEnv) return path.resolve(fromEnv.replace(/^"|"$/g, ''));

  const exe = engineFileName();
  const archDir = isMac ? 'osx-arm64' : 'win-x64';
  const candidates = [
    path.join(process.resourcesPath || '', 'engine', exe),
    path.join(appDir, 'engine', exe),
    path.join(appDir, '..', 'engine', exe),
    path.join(repoRoot, 'mac', 'engine', 'publish', archDir, exe),
  ];
  const found = firstExisting(candidates);
  if (found) return found;
  // 都找不到时返回最可能的路径，让报错信息指向它
  return candidates[1];
}

/**
 * web 静态根目录解析顺序：
 *   1. 环境变量 ZILUX2_WEB_ROOT
 *   2. 打包布局：<resources>/web        （electron-builder extraResources）
 *   3. 同目录布局：<app>/web             （win-test：resources/app/web/）
 *   4. 仓库开发布局：<repo>/web/dist
 */
function resolveWebRoot() {
  const fromEnv = (process.env.ZILUX2_WEB_ROOT || '').trim();
  if (fromEnv) return path.resolve(fromEnv.replace(/^"|"$/g, ''));

  const isDir = (dir) => fs.existsSync(path.join(dir, 'index.html'));
  const candidates = [
    path.join(process.resourcesPath || '', 'web'),
    path.join(appDir, 'web'),
    path.join(appDir, '..', 'web'),
    path.join(repoRoot, 'web', 'dist'),
  ];
  const found = firstExisting(candidates, isDir);
  if (found) return found;
  return candidates[candidates.length - 1];
}

// 用户数据目录必须在 app ready 之前切换（settings.json / window.json 都放这里）。
const userDataOverride = (process.env.ZILUX2_USER_DATA || '').trim();
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride.replace(/^"|"$/g, '')));
}

const enginePath = resolveEnginePath();
const webRoot = resolveWebRoot();
let userDataDir = null; // app ready 后确定

// ---------------------------------------------------------------------------
// 日志（stdout + <userData>/shell.log）
// ---------------------------------------------------------------------------

let logFilePath = null;

function timestamp() {
  return new Date().toISOString();
}

function logLine(level, message) {
  const line = `[${timestamp()}] [${level}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line + '\n', 'utf8');
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }
}

const hostLog = {
  info: (message) => logLine('info', message),
  warn: (message) => logLine('warn', message),
  error: (message) => logLine('error', message),
};

// ---------------------------------------------------------------------------
// 设置（Settings v1）：字段与 web/src/core/settings.ts 的 Settings / DEFAULT_SETTINGS 完全一致
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  version: 1,
  general: { splash: true, startMaximized: false },
  appearance: {
    theme: 'frost',
    reduceMotion: false,
    glow: true,
    heroAutoRotate: true,
    lyricsSize: 'medium',
  },
  playback: {
    defaultSource: 'netease',
    searchLimit: 20,
    lyricsAutoOpen: true,
    idleLyrics: true,
    audioReactive: true,
    volume: 0.72,
    quality: 'high',
  },
};

const THEMES = ['frost'];
const LYRICS_SIZES = ['small', 'medium', 'large'];
const SEARCH_LIMITS = [10, 20, 30];
const STREAM_QUALITIES = ['standard', 'high', 'lossless'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function asLimit(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  return SEARCH_LIMITS.includes(numeric) ? numeric : DEFAULT_SETTINGS.playback.searchLimit;
}

function asVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.playback.volume;
  }
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/** 与 web/src/core/settings.ts 的 normalizeSettings 等价：深合并 + 白名单 + 非法值回落默认值。 */
function normalizeSettings(raw) {
  const root = asObject(raw);
  const general = asObject(root.general);
  const appearance = asObject(root.appearance);
  const playback = asObject(root.playback);
  const defaults = DEFAULT_SETTINGS;

  return {
    version: 1,
    general: {
      splash: asBool(general.splash, defaults.general.splash),
      startMaximized: asBool(general.startMaximized, defaults.general.startMaximized),
    },
    appearance: {
      theme: asEnum(appearance.theme, THEMES, defaults.appearance.theme),
      reduceMotion: asBool(appearance.reduceMotion, defaults.appearance.reduceMotion),
      glow: asBool(appearance.glow, defaults.appearance.glow),
      heroAutoRotate: asBool(appearance.heroAutoRotate, defaults.appearance.heroAutoRotate),
      lyricsSize: asEnum(appearance.lyricsSize, LYRICS_SIZES, defaults.appearance.lyricsSize),
    },
    playback: {
      defaultSource:
        typeof playback.defaultSource === 'string' && playback.defaultSource
          ? playback.defaultSource
          : defaults.playback.defaultSource,
      searchLimit: asLimit(playback.searchLimit),
      lyricsAutoOpen: asBool(playback.lyricsAutoOpen, defaults.playback.lyricsAutoOpen),
      idleLyrics: asBool(playback.idleLyrics, defaults.playback.idleLyrics),
      audioReactive: asBool(playback.audioReactive, defaults.playback.audioReactive),
      volume: asVolume(playback.volume),
      quality: asEnum(playback.quality, STREAM_QUALITIES, defaults.playback.quality),
    },
  };
}

let settingsState = clone(DEFAULT_SETTINGS);
let settingsPath = null;
let settingsSaveTimer = null;
let settingsDirty = false;

function loadSettings() {
  settingsPath = path.join(userDataDir, 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      settingsState = normalizeSettings(JSON.parse(raw));
      hostLog.info(`[settings] loaded path=${settingsPath}`);
      return;
    }
  } catch (error) {
    hostLog.warn(`[settings] load failed, use defaults: ${error.message}`);
  }
  settingsState = clone(DEFAULT_SETTINGS);
  hostLog.info(`[settings] defaults path=${settingsPath}`);
}

function saveSettingsNow() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  if (!settingsDirty || !settingsPath) return;
  settingsDirty = false;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settingsState, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, settingsPath);
  } catch (error) {
    hostLog.error(`[settings] save failed: ${error.message}`);
  }
}

function saveSettingsSoon() {
  settingsDirty = true;
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveSettingsNow();
  }, 300);
}

function applySettingsPatch(patch) {
  const p = asObject(patch);
  const merged = {
    version: 1,
    general: { ...settingsState.general, ...asObject(p.general) },
    appearance: { ...settingsState.appearance, ...asObject(p.appearance) },
    playback: { ...settingsState.playback, ...asObject(p.playback) },
  };
  settingsState = normalizeSettings(merged);
  saveSettingsSoon();
  hostLog.info(`[settings] patch keys=${Object.keys(p).join(',') || '<none>'}`);
  return settingsState;
}

function resetSettings() {
  settingsState = clone(DEFAULT_SETTINGS);
  saveSettingsSoon();
  hostLog.info('[settings] reset');
  return settingsState;
}

function settingsSnapshotMessage() {
  const state = clone(settingsState);
  return {
    v: 1,
    type: 'host',
    event: 'settings',
    version: 1,
    // WebViewHost.cs（HostSettingsMessage）用顶层 `state`；web/src/core/settings.ts 也只读 msg.state。
    state,
    // 兼容契约文档里 payload.settings 的写法，页面会忽略多余字段。
    payload: { settings: clone(state) },
  };
}

// ---------------------------------------------------------------------------
// 窗口状态持久化（<userData>/window.json）
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW = { width: 1440, height: 900, x: null, y: null, maximized: false };
let windowStatePath = null;
let windowState = { ...DEFAULT_WINDOW };
let windowSaveTimer = null;
let windowReady = false;

function loadWindowState() {
  windowStatePath = path.join(userDataDir, 'window.json');
  try {
    if (fs.existsSync(windowStatePath)) {
      const raw = asObject(JSON.parse(fs.readFileSync(windowStatePath, 'utf8')));
      windowState = {
        width: Number.isFinite(raw.width) ? Math.max(1100, Math.round(raw.width)) : DEFAULT_WINDOW.width,
        height: Number.isFinite(raw.height) ? Math.max(720, Math.round(raw.height)) : DEFAULT_WINDOW.height,
        x: Number.isFinite(raw.x) ? Math.round(raw.x) : null,
        y: Number.isFinite(raw.y) ? Math.round(raw.y) : null,
        maximized: raw.maximized === true,
      };
    }
  } catch (error) {
    hostLog.warn(`[window] state load failed, use defaults: ${error.message}`);
    windowState = { ...DEFAULT_WINDOW };
  }
  // 坐标必须在某个显示器可见范围内，否则丢弃（换过显示器的场景）
  if (windowState.x != null && windowState.y != null) {
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return (
        windowState.x >= area.x - 32 &&
        windowState.y >= area.y - 32 &&
        windowState.x < area.x + area.width - 160 &&
        windowState.y < area.y + area.height - 120
      );
    });
    if (!visible) {
      windowState.x = null;
      windowState.y = null;
    }
  }
  hostLog.info(`[window] state path=${windowStatePath}`);
}

function saveWindowStateNow() {
  if (!windowStatePath || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const payload = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: mainWindow.isMaximized(),
    };
    fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
    fs.writeFileSync(windowStatePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (error) {
    hostLog.warn(`[window] state save failed: ${error.message}`);
  }
}

function scheduleSaveWindowState() {
  if (!windowReady) return;
  if (windowSaveTimer) clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = null;
    saveWindowStateNow();
  }, 400);
}

// ---------------------------------------------------------------------------
// 引擎进程
// ---------------------------------------------------------------------------

let mainWindow = null;
let engineProcess = null;
let engineInfo = null; // { port, token, sources }
let engineErrorLine = '';
let isQuitting = false;
let pageReady = false;
let lastMediaLogAt = 0;

function toLines(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
    // 防止引擎一直不换行把内存撑爆
    if (buffer.length > 65536) buffer = buffer.slice(-4096);
  };
}

function killEngine() {
  const child = engineProcess;
  engineProcess = null;
  engineInfo = null;
  if (!child) return;
  hostLog.info(`[engine] stopping pid=${child.pid}`);
  // 引擎的 stdin 读到 EOF/quit 会优雅退出：先写 quit，再兜底 kill。
  try {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write('quit\n');
      child.stdin.end();
    }
  } catch (error) {
    hostLog.warn(`[engine] stdin quit failed: ${error.message}`);
  }
  const forceKill = () => {
    try {
      if (isWin && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
        }, 1500).unref?.();
      }
    } catch (error) {
      hostLog.warn(`[engine] stop failed: ${error.message}`);
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) return;
  setTimeout(forceKill, 3000).unref?.();
}

/**
 * spawn 引擎并等待 READY 行。
 * @returns {Promise<{port:number, token:string, sources:string[]}>}
 */
function startEngine() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(enginePath)) {
      reject(
        new Error(
          `找不到引擎可执行文件：${enginePath}\n\n` +
            '开发机请设置环境变量 ZILUX2_ENGINE 指向 Zilux2MacEngine(.exe)，' +
            '或运行 mac/engine 的发布脚本生成 mac/engine/publish/<rid>/Zilux2MacEngine*。',
        ),
      );
      return;
    }
    if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
      reject(new Error(`web 静态目录里没有 index.html：${webRoot}\n请设置环境变量 ZILUX2_WEB_ROOT。`));
      return;
    }

    // 开发用：指向 .mjs/.js 的「引擎」时用 Electron 自带的 node 模式跑（mac/shell/dev/stub-engine.mjs）。
    const isScriptEngine = /\.(mjs|js|cjs)$/i.test(enginePath);
    const command = isScriptEngine ? process.execPath : enginePath;
    const args = isScriptEngine ? [enginePath, '--web-root', webRoot] : ['--web-root', webRoot];
    const env = isScriptEngine
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : { ...process.env };
    // 真引擎是 .NET 可执行文件：不让它继承 ELECTRON_RUN_AS_NODE（本机环境可能带这个变量）。
    if (!isScriptEngine) delete env.ELECTRON_RUN_AS_NODE;
    hostLog.info(`[engine] spawn ${command} ${args.join(' ')}${isScriptEngine ? ' (node mode)' : ''}`);
    let child;
    try {
      child = spawn(command, args, {
        cwd: path.dirname(enginePath),
        // stdin 必须保持打开：引擎把 stdin EOF 当作退出指令（关闭管道 = 让引擎优雅退出）。
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch (error) {
      reject(new Error(`引擎启动失败：${error.message}`));
      return;
    }
    child.stdin?.on('error', () => {
      /* 引擎退出后写 stdin 会 EPIPE，忽略 */
    });
    engineProcess = child;

    let settled = false;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        killEngine();
        reject(error);
      } else {
        engineInfo = info;
        hostLog.info(
          `[engine] ready port=${info.port} tokenLen=${info.token.length} sources=${info.sources.join(',')}`,
        );
        resolve(info);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`引擎启动超时（${ENGINE_TIMEOUT_MS / 1000}s）：没有收到 ${ENGINE_READY_PREFIX} 行`));
    }, ENGINE_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on(
      'data',
      toLines((line) => {
        if (line.startsWith(ENGINE_READY_PREFIX)) {
          const jsonText = line.slice(ENGINE_READY_PREFIX.length).trim();
          try {
            const parsed = JSON.parse(jsonText);
            const port = Number(parsed.port);
            const token = typeof parsed.token === 'string' ? parsed.token : '';
            const sources = Array.isArray(parsed.sources)
              ? parsed.sources.filter((item) => typeof item === 'string')
              : [];
            if (!Number.isFinite(port) || port <= 0) {
              finish(new Error(`引擎 READY 行端口非法：${jsonText}`));
              return;
            }
            finish(null, { port, token, sources });
          } catch (error) {
            finish(new Error(`引擎 READY 行 JSON 解析失败：${error.message} / ${jsonText}`));
          }
          return;
        }
        hostLog.info(`[engine] ${line}`);
      }),
    );

    child.stderr?.setEncoding('utf8');
    child.stderr?.on(
      'data',
      toLines((line) => {
        if (line.startsWith(ENGINE_ERROR_PREFIX)) {
          const jsonText = line.slice(ENGINE_ERROR_PREFIX.length).trim();
          engineErrorLine = jsonText;
          hostLog.error(`[engine:error] ${jsonText}`);
          return;
        }
        hostLog.error(`[engine:stderr] ${line}`);
      }),
    );

    child.on('error', (error) => {
      finish(new Error(`引擎进程错误：${error.message}`));
    });

    child.on('exit', (code, signal) => {
      const wasReady = !!engineInfo;
      engineProcess = null;
      if (!settled) {
        finish(
          new Error(
            `引擎在就绪前退出 code=${code} signal=${signal ?? ''}` +
              (engineErrorLine ? `\n引擎错误：${engineErrorLine}` : ''),
          ),
        );
        return;
      }
      engineInfo = null;
      hostLog.warn(`[engine] exited code=${code} signal=${signal ?? ''}`);
      if (!isQuitting && wasReady && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox('Zilux2 引擎已退出', `在线音乐引擎异常退出（code=${code}），重启应用后重试。`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 宿主 → 页面消息
// ---------------------------------------------------------------------------

function sendToPage(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.webContents.send('webview:message', message);
    return true;
  } catch (error) {
    hostLog.warn(`[host] send failed: ${error.message}`);
    return false;
  }
}

const FONT_FAMILIES = [
  // macOS 常见中文字体
  'PingFang SC',
  'Hiragino Sans GB',
  'Heiti SC',
  'Songti SC',
  'Kaiti SC',
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'Source Han Sans SC',
  'Source Han Serif SC',
  'Zilux2 Sans SC',
  // 跨平台兜底 / Windows 联调机常见
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'SimHei',
  'SimSun',
  // 西文字体
  'SF Pro Display',
  'SF Pro Text',
  'Helvetica Neue',
  'Helvetica',
  'Avenir Next',
  'Futura',
  'Georgia',
  'Times New Roman',
  'Arial',
  'Menlo',
  'Monaco',
];

function postReady() {
  pageReady = true;
  sendToPage({
    v: 1,
    type: 'host',
    event: 'ready',
    version: APP_VERSION,
    maximized: !!mainWindow && mainWindow.isMaximized(),
  });
  postOnlineInfo();
  postSettingsSnapshot();
  postFonts();
  postAirPlayStatus();
}

function postOnlineInfo() {
  if (!engineInfo) {
    hostLog.warn('[online] endpoint unavailable, page gets no online sources');
    return;
  }
  sendToPage({
    v: 1,
    type: 'host',
    event: 'online',
    payload: {
      port: engineInfo.port,
      token: engineInfo.token,
      sources: engineInfo.sources,
    },
  });
  hostLog.info(
    `[online] endpoint sent to page port=${engineInfo.port} tokenLen=${engineInfo.token.length} ` +
      `sources=${engineInfo.sources.join(',')}`,
  );
}

function postSettingsSnapshot() {
  sendToPage(settingsSnapshotMessage());
}

function postFonts() {
  sendToPage({ v: 1, type: 'host', event: 'fonts', payload: { families: FONT_FAMILIES.slice() } });
  hostLog.info(`[fonts] sent ${FONT_FAMILIES.length} families`);
}

/** mac 测试版没有 AirPlay：只回 idle，页面 UI 入口由注入脚本隐藏。 */
function postAirPlayStatus() {
  sendToPage({
    v: 1,
    type: 'host',
    event: 'airplay',
    payload: {
      state: 'idle',
      devices: [],
      active: null,
      actives: [],
      code: null,
      error: null,
      latencyMs: 300,
    },
  });
}

function handleWindowCommand(message) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const action = typeof message.action === 'string' ? message.action : '';
  switch (action) {
    case 'chromeColor': {
      const color = typeof message.color === 'string' ? message.color : '';
      if (/^#[0-9a-fA-F]{6}$/.test(color)) {
        hostLog.info(`[window] chromeColor ${color}`);
        try {
          win.setBackgroundColor(color);
        } catch (error) {
          hostLog.warn(`[window] chromeColor failed: ${error.message}`);
        }
      } else {
        hostLog.warn(`[window] chromeColor ignored: ${color || '<missing>'}`);
      }
      break;
    }
    case 'minimize':
      hostLog.info('[window] minimize');
      win.minimize();
      break;
    case 'toggleMaximize':
      hostLog.info('[window] toggleMaximize');
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'close':
      hostLog.info('[window] close');
      win.close();
      break;
    default:
      hostLog.warn(`[window] action ignored: ${action || '<missing>'}`);
      break;
  }
}

function handleSettingsMessage(message) {
  const action = typeof message.action === 'string' ? message.action : '';
  switch (action) {
    case 'request':
      hostLog.info('[settings] request');
      postSettingsSnapshot();
      break;
    case 'patch':
      if (message.patch && typeof message.patch === 'object' && !Array.isArray(message.patch)) {
        applySettingsPatch(message.patch);
      } else {
        hostLog.warn('[settings] patch ignored (missing patch object)');
      }
      postSettingsSnapshot();
      break;
    case 'reset':
      resetSettings();
      postSettingsSnapshot();
      break;
    default:
      hostLog.warn(`[settings] unknown action=${action || '<missing>'}`);
      break;
  }
}

function handlePageMessage(rawMessage) {
  let message = rawMessage;
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message);
    } catch {
      hostLog.warn('[host] ignored non-JSON message string');
      return;
    }
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    hostLog.warn('[host] ignored message: not an object');
    return;
  }
  const version = message.v;
  if (version !== undefined && version !== 1) {
    hostLog.warn(`[host] ignored message: unsupported protocol version v=${String(version)}`);
    return;
  }

  const type = typeof message.type === 'string' ? message.type : '';
  switch (type) {
    case 'ready':
      hostLog.info('page.ready');
      postReady();
      break;
    case 'settings':
      handleSettingsMessage(message);
      break;
    case 'window':
      handleWindowCommand(message);
      break;
    case 'drag':
      // Electron 里窗口拖动由注入的 -webkit-app-region:drag 交给系统处理，无需宿主参与。
      hostLog.info('page.drag: handled by -webkit-app-region (no-op)');
      break;
    case 'resize':
      // 非 mac 平台（Windows 联调）窗口无法通过 JS 交回系统缩放循环；mac 用原生窗口边框缩放。
      hostLog.info(`page.resize edge=${String(message.edge)} (no-op)`);
      break;
    case 'media': {
      // Windows SMTC 专用；mac 测试版暂不接系统 Now Playing。
      // 但把状态写进 shell.log：QA 用它作为 <audio> 实际播放/进度前进的证据（≤1 条/秒）。
      const now = Date.now();
      if (now - lastMediaLogAt >= 1000) {
        lastMediaLogAt = now;
        const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
        const position = Number(payload.positionMs);
        const duration = Number(payload.durationMs);
        const playing = payload.playing === true;
        const title = typeof payload.title === 'string' ? payload.title : '';
        const mediaState = typeof payload.state === 'string' ? payload.state : '';
        hostLog.info(
          `[media] playing=${playing} state=${mediaState || '-'} ` +
            `positionMs=${Number.isFinite(position) ? Math.round(position) : '-'} ` +
            `durationMs=${Number.isFinite(duration) ? Math.round(duration) : '-'} title=${title}`,
        );
      }
      break;
    }
    case 'audio':
      // 宿主侧 PCM 特征 / AirPlay 音频采集都是 Windows 能力；mac 版 no-op。
      break;
    case 'airplay':
      // mac 测试版无 AirPlay：隐藏入口 + 永远回 idle，避免面板空转。
      postAirPlayStatus();
      break;
    case 'fonts':
      postFonts();
      break;
    case 'local':
      // 本地曲库扫描是 Windows 宿主能力；回 localCancel 让页面按钮解锁，不卡加载态。
      hostLog.info(`[local] action=${String(message.action)} -> localCancel`);
      sendToPage({ v: 1, type: 'host', event: 'localCancel' });
      break;
    case 'log': {
      const level = typeof message.level === 'string' ? message.level : 'info';
      const text = typeof message.message === 'string' ? message.message.slice(0, 2048) : '';
      hostLog.info(`web:${level} ${text}`);
      break;
    }
    default:
      hostLog.info(`[host] ignored unknown message type=${type || '<missing>'}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// 页面注入补丁（CSP 允许内联 <style>；不修改 web/ 源码）
// ---------------------------------------------------------------------------

/**
 * 在页面里执行：加拖动区域 CSS + 隐藏 AirPlay「投送」入口。
 * 注意：本函数会被 toString() 序列化后注入页面，不能引用主进程作用域变量。
 */
function injectPagePatch() {
  try {
    if (window.__ZILUX2_MAC_PATCH__) return 'already';
    window.__ZILUX2_MAC_PATCH__ = true;

    const style = document.createElement('style');
    style.id = 'zilux2-mac-patch';
    style.textContent = [
      '/* Zilux2 Electron 壳：无边框窗口拖动区域（页面自身用 host.drag() 是 Windows 专用路径） */',
      'header, .topbar, .titlebar { -webkit-app-region: drag; }',
      'button, input, textarea, select, a, [role="button"],',
      '.win-btns, .win-btn, .account-wrap, .account-btn, .topbar-center, .topbar-right, .top-peek,',
      '.search-wrap, .search-dock, .search-field, .search-input, .rail, .rail-btn, .pill, .sheet,',
      '.playerbar, .playerbar-wrap, .upnext, .quick, .account-panel, .lyrics-view, .edge-resize,',
      '.airplay-view, .modal, .overlay { -webkit-app-region: no-drag; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);

    // AirPlay 入口隐藏：rail 按钮 / 设置页 tab / 设置区块标题都按 label==='投送' 匹配。
    const HIDDEN_LABELS = new Set(['投送', 'AirPlay', 'airplay']);
    const hideAirPlay = (element) => {
      if (!element || element.nodeType !== 1) return;
      if (element.getAttribute('data-zilux2-airplay-hidden')) return;
      const ariaLabel = (element.getAttribute('aria-label') || '').trim();
      const text = (element.textContent || '').trim();
      const isAirPlayView = element.matches && element.matches('.airplay-view');
      if (isAirPlayView || HIDDEN_LABELS.has(ariaLabel) || HIDDEN_LABELS.has(text)) {
        element.setAttribute('data-zilux2-airplay-hidden', '1');
        element.style.display = 'none';
      }
    };
    const scan = (root) => {
      if (!root || root.nodeType !== 1) return;
      hideAirPlay(root);
      if (!root.querySelectorAll) return;
      const found = root.querySelectorAll(
        'button[aria-label], button, [aria-label], .airplay-view, .rail-btn, .quick-tab',
      );
      for (const element of found) hideAirPlay(element);
    };

    const start = () => {
      scan(document.body || document.documentElement);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node && node.nodeType === 1) scan(node);
          }
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
    return 'ok';
  } catch (error) {
    return `error: ${String(error)}`;
  }
}

function injectPatchesIntoPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(`(${injectPagePatch.toString()})();`, true)
    .then((result) => {
      if (result !== 'ok' && result !== 'already') {
        hostLog.warn(`[patch] inject result=${String(result)}`);
      }
    })
    .catch((error) => {
      hostLog.warn(`[patch] inject failed: ${error.message}`);
    });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createMainWindow() {
  const bounds = {
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x != null && windowState.y != null ? { x: windowState.x, y: windowState.y } : {}),
  };

  const options = {
    ...bounds,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b0c10',
    title: 'Zilux2',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(appDir, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };

  if (isMac) {
    options.titleBarStyle = 'hiddenInset';
    options.trafficLightPosition = { x: 16, y: 16 };
  } else {
    options.frame = false;
  }

  const win = new BrowserWindow(options);
  mainWindow = win;

  win.once('ready-to-show', () => {
    // 最大化启动：设置里的 startMaximized（与 Windows 版设置同义）优先，其次窗口状态记忆。
    if (settingsState.general.startMaximized || windowState.maximized) win.maximize();
    win.show();
    windowReady = true;
    hostLog.info('[window] shown');
  });

  win.on('resize', scheduleSaveWindowState);
  win.on('move', scheduleSaveWindowState);
  win.on('maximize', () => {
    scheduleSaveWindowState();
    sendToPage({ v: 1, type: 'host', event: 'window', action: 'maximized', maximized: true });
  });
  win.on('unmaximize', () => {
    scheduleSaveWindowState();
    sendToPage({ v: 1, type: 'host', event: 'window', action: 'maximized', maximized: false });
  });
  win.on('closed', () => {
    windowReady = false;
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    hostLog.warn(`new_window blocked: ${url}`);
    return { action: 'deny' };
  });

  const allowedOrigin = () => (engineInfo ? `http://127.0.0.1:${engineInfo.port}` : '');
  win.webContents.on('will-navigate', (event, url) => {
    const origin = allowedOrigin();
    if (origin && url.startsWith(origin)) return;
    event.preventDefault();
    hostLog.warn(`navigation blocked: ${url}`);
  });

  win.webContents.on('dom-ready', () => {
    injectPatchesIntoPage();
  });

  // 页面 console 转发到宿主日志（排查用：Electron 的 console-message 签名跨版本兼容处理）
  // Electron >= 28: (event, details{level,message,lineNumber,sourceId})；旧版: (event, level, message, line, sourceId)
  win.webContents.on('console-message', (_event, levelOrDetails, message, line, sourceId) => {
    let level;
    let text;
    let source;
    let lineNumber;
    if (levelOrDetails && typeof levelOrDetails === 'object') {
      level = levelOrDetails.level;
      text = levelOrDetails.message;
      source = levelOrDetails.sourceId;
      lineNumber = levelOrDetails.lineNumber;
    } else {
      level = levelOrDetails;
      text = message;
      source = sourceId;
      lineNumber = line;
    }
    const names = ['verbose', 'info', 'warning', 'error'];
    const name = typeof level === 'number' ? names[level] || 'log' : String(level || 'log');
    const suffix = source ? ` (${String(source)}:${String(lineNumber)})` : '';
    if (name === 'error') hostLog.error(`[page:console:${name}] ${text}${suffix}`);
    else if (name === 'warning' || name === 'warn') hostLog.warn(`[page:console:warn] ${text}${suffix}`);
    else hostLog.info(`[page:console:${name}] ${text}`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    hostLog.error(`[page] load failed code=${errorCode} ${errorDescription} url=${validatedURL}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    hostLog.error(`[page] renderer gone: ${JSON.stringify(details)}`);
  });

  return win;
}

function showFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  hostLog.error(`[boot] fatal: ${message}`);
  try {
    dialog.showErrorBox('Zilux2 启动失败', message);
  } catch {
    /* 对话框不可用时忽略 */
  }

  if (exitOnError) {
    setTimeout(() => app.quit(), 300);
    return;
  }

  const win = new BrowserWindow({
    width: 760,
    height: 460,
    backgroundColor: '#0b0c10',
    title: 'Zilux2 启动失败',
    webPreferences: { sandbox: false, contextIsolation: true },
  });
  const escapeHtml = (text) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Zilux2 启动失败</title>
<style>
  html,body{height:100%;margin:0;background:#0b0c10;color:#e8e6e1;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei UI",sans-serif;}
  main{box-sizing:border-box;padding:28px 32px;height:100%;display:flex;flex-direction:column;gap:14px;}
  h1{margin:0;font-size:18px;font-weight:600;letter-spacing:.02em;}
  pre{margin:0;flex:1;overflow:auto;padding:16px;border-radius:10px;background:#15171d;color:#f0b3b3;white-space:pre-wrap;word-break:break-all;font:12px/1.7 ui-monospace,Menlo,Consolas,monospace;}
  p{margin:0;color:#858a95;font-size:12px;}
  button{align-self:flex-start;padding:8px 18px;border:0;border-radius:8px;background:#f3f1ea;color:#14161a;font:13px/1 inherit;cursor:pointer;}
</style></head>
<body><main>
  <h1>Zilux2 启动失败</h1>
  <pre>${escapeHtml(message)}</pre>
  <p>引擎 / web 资源路径可用环境变量 ZILUX2_ENGINE、ZILUX2_WEB_ROOT 覆盖。详见 mac/shell/README.md。</p>
  <button onclick="window.close()">关闭</button>
</main></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// ---------------------------------------------------------------------------
// 启动 / 退出
// ---------------------------------------------------------------------------

// 后台/自动化场景也允许 <audio> 播放（避免 autoplay 策略拦截）。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const allowMultiInstance = process.env.ZILUX2_ALLOW_MULTI_INSTANCE === '1';
if (!allowMultiInstance && !app.requestSingleInstanceLock()) {
  hostLog.warn('[boot] another instance is running, quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    userDataDir = app.getPath('userData');
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch {
      /* 目录已存在 */
    }
    logFilePath = path.join(userDataDir, 'shell.log');
    // 日志简单轮转：超过 2MB 就把上一份挪到 shell.log.1，避免测试版长期运行把日志写爆。
    try {
      if (fs.statSync(logFilePath).size > 2 * 1024 * 1024) {
        fs.rmSync(`${logFilePath}.1`, { force: true });
        fs.renameSync(logFilePath, `${logFilePath}.1`);
      }
    } catch {
      /* 还没有日志文件 */
    }
    hostLog.info(`[boot] Zilux2 mac shell ${APP_VERSION} electron=${process.versions.electron} ` +
      `platform=${process.platform}/${process.arch}`);
    hostLog.info(`[boot] enginePath=${enginePath}`);
    hostLog.info(`[boot] webRoot=${webRoot}`);
    hostLog.info(`[boot] userData=${userDataDir}`);

    loadWindowState();
    loadSettings();

    // 开发/联调逃生通道：直接加载给定 URL（例如本地 static server + ?mock=1），跳过引擎。
    const urlOverride = (process.env.ZILUX2_URL || '').trim();
    let pageUrl;
    if (urlOverride) {
      pageUrl = urlOverride;
      hostLog.info(`[boot] ZILUX2_URL override -> ${pageUrl}（跳过引擎）`);
      if (process.env.ZILUX2_MOCK === '1' && !/[?&]mock=1/.test(pageUrl)) {
        pageUrl += (pageUrl.includes('?') ? '&' : '?') + 'mock=1';
      }
    } else {
      let info;
      try {
        info = await startEngine();
      } catch (error) {
        showFatalError(error);
        return;
      }
      pageUrl = `http://127.0.0.1:${info.port}/index.html`;
      if (process.env.ZILUX2_MOCK === '1') {
        pageUrl += '?mock=1';
        hostLog.info('[boot] ZILUX2_MOCK=1 -> 页面使用内置演示数据');
      }
    }

    createMainWindow();
    if (!mainWindow) return;
    hostLog.info(`[page] load ${pageUrl}`);
    mainWindow.loadURL(pageUrl).catch((error) => {
      showFatalError(new Error(`页面加载失败：${error.message}\n${pageUrl}`));
    });

    // 页面一直没发 ready 时打一条日志，方便排查桥没挂上
    setTimeout(() => {
      if (!pageReady) hostLog.warn(`[page] no ready message after ${PAGE_READY_FALLBACK_MS}ms`);
    }, PAGE_READY_FALLBACK_MS).unref?.();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  saveSettingsNow();
  if (windowReady) saveWindowStateNow();
  killEngine();
});

app.on('will-quit', () => {
  killEngine();
});

process.on('uncaughtException', (error) => {
  hostLog.error(`[boot] uncaughtException: ${error && error.stack ? error.stack : String(error)}`);
});
process.on('unhandledRejection', (reason) => {
  hostLog.error(`[boot] unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`);
});

// 页面 -> 宿主 IPC：只接受主窗口页面发来的消息
ipcMain.on('webview:post', (event, message) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    hostLog.warn('[host] dropped webview:post from unknown sender');
    return;
  }
  handlePageMessage(message);
});
