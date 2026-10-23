'use strict';

/**
 * Zilux2 mac 壳 preload：模拟 Windows 宿主的 `window.chrome.webview` 桥。
 *
 * 页面（web/src/core/bridge.ts）只用到三个成员：
 *   - postMessage(message): 页面 -> 宿主
 *   - addEventListener('message', fn): 宿主 -> 页面，回调收到 { data }
 *   - removeEventListener('message', fn)
 *
 * 这里把它们转成 Electron IPC：
 *   postMessage  -> ipcRenderer.send('webview:post', message)
 *   宿主消息      <- ipcRenderer.on('webview:message', (_e, data) => fn({ data }))
 *
 * 因为 BrowserWindow 用 contextIsolation:false，window 就是页面的 window，
 * 直接挂到 window.chrome.webview 上即可被页面读到。
 */

const { ipcRenderer } = require('electron');

function install() {
  const listeners = new Set();

  ipcRenderer.on('webview:message', (_event, data) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener({ data });
      } catch (error) {
        // 页面监听器自己报错不应该影响其它监听器
        console.error('[preload] webview message listener failed', error);
      }
    }
  });

  const chromeObject = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};
  const webview = {
    postMessage(message) {
      ipcRenderer.send('webview:post', message);
    },
    addEventListener(type, listener) {
      if (type !== 'message' || typeof listener !== 'function') return;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type !== 'message') return;
      listeners.delete(listener);
    },
  };

  chromeObject.webview = webview;
  window.chrome = chromeObject;

  // WebView2 还提供 hostObjects / addHostObjectToScript 等，本壳不实现；页面未使用。
}

try {
  install();
} catch (error) {
  console.error('[preload] install failed', error);
}
