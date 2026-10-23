/**
 * Zilux2 QA 套件 —— smoke 冒烟
 *
 * 目的：确认「应用基座 + 主要页面」在这台真机上整体可用，并确认全程没有
 * console error / 未捕获异常。任何后续套件失败时，先看 smoke 是否全绿。
 *
 * 覆盖：首页 → 搜索（边打边搜 + Enter 出结果墙）→ 发现 → 我喜欢的音乐 →
 *       最近播放 → 我的歌单 → 设置 → 歌词页；最后汇总 console 错误 + 截图数。
 *
 * 运行：node research/qa/suite/smoke.mjs
 * 截图：research/shots/suite-YYYYMMDD/smoke-*.png
 */
import { runSuite, sleep } from './lib/cdp.mjs';
import {
  SEL,
  RAIL,
  clickRail,
  closeOverlays,
  goHome,
  openSearch,
  wallState,
  toastText,
  openLyricsView,
  closeLyricsView,
} from './lib/ui.mjs';
import { SEARCH_KEYWORD } from './lib/fixtures.mjs';

await runSuite('smoke', '冒烟：应用基座 + 主要页面 + 控制台零错误', async (suite) => {
  const cdp = suite.cdp;
  let searchRows = 0;

  await suite.step('页面身份：URL / 标题 / 侧栏齐全', async () => {
    const info = await cdp.eval(`(() => ({
      url: location.href,
      title: document.title,
      ready: document.readyState,
      rails: Array.from(document.querySelectorAll('.rail-btn')).map((n) => n.getAttribute('title')),
      quick: !!document.querySelector('.pb-quick'),
      playerbar: !!document.querySelector('.playerbar'),
    }))()`);
    suite.assert(String(info.url).startsWith('https://zilux2.local'), `页面 URL 不是 https://zilux2.local 开头：${info.url}`);
    suite.assert(info.rails.length >= 8, `侧栏按钮数量异常：${info.rails.length}（${JSON.stringify(info.rails)}）`);
    for (const title of ['首页', '发现', '本地曲库', '设置']) {
      // 本地曲库 title 会带曲目数（「本地曲库 · 13 首」），用前缀匹配
      suite.assert(
        info.rails.some((rail) => String(rail || '').startsWith(title)),
        `侧栏缺少「${title}」按钮，现有：${JSON.stringify(info.rails)}`,
      );
    }
    suite.assert(info.playerbar, '播放条 .playerbar 不存在');
    return `title=${info.title} | ${String(info.url).split('?')[0]} | ready=${info.ready} | rails=${info.rails.length}`;
  });

  await suite.step('首页渲染', async () => {
    await goHome(cdp);
    await cdp.waitFor(`document.querySelectorAll('.home-host .ui-page.home *').length > 20`, {
      desc: '首页内容节点 > 20',
      timeoutMs: 15000,
    });
    const state = await cdp.eval(`(() => ({
      visible: !!document.querySelector('.home-host:not(.is-hidden) .ui-page.home'),
      wallHidden: !!document.querySelector('.wall') && document.querySelector('.wall').classList.contains('is-hidden'),
      textLen: (document.querySelector('.home-host') && document.querySelector('.home-host').innerText || '').length,
    }))()`);
    suite.assert(state.visible, '首页 .home-host .ui-page.home 未显示');
    suite.assert(state.wallHidden, '首页模式下 .wall 应带 is-hidden（隐藏右侧墙面）');
    suite.assert(state.textLen > 50, `首页正文过短（${state.textLen} 字符），可能是空态/渲染失败`);
    await suite.shot('home');
    return `正文 ${state.textLen} 字符`;
  });

  await suite.step(`搜索「${SEARCH_KEYWORD}」：竞态回归（input 后立即 Enter，12s 内出结果墙）`, async () => {
    const state = await openSearch(cdp, SEARCH_KEYWORD);
    searchRows = state.rows;
    suite.assert(state.title === `搜索「${SEARCH_KEYWORD}」`, `结果墙标题不符：${state.title}`);
    suite.assert(state.sub.length > 0, '结果墙 subtitle 为空');
    suite.assert(state.rows > 0, '结果墙行数为 0');
    await suite.shot('search');
    return `title=${state.title} | sub=${state.sub} | rows=${state.rows} | ${state.elapsedMs}ms`;
  });

  await suite.step('搜索结果行 / 下载按钮', async () => {
    if (searchRows === 0) {
      suite.skip('搜索结果行 / 下载按钮', '搜索没有返回结果（外部网络或音乐源不可用，环境问题）');
      return;
    }
    const detail = await cdp.eval(`(() => ({
      rows: document.querySelectorAll('.wall .track-row').length,
      firstTitle: (document.querySelector('.wall .track-row .track-title, .wall .track-row .track-info') || {}).textContent || '',
      downloadBtns: document.querySelectorAll('.wall .track-row .track-download').length,
    }))()`);
    suite.assert(detail.downloadBtns > 0, `搜索结果 ${detail.rows} 行但没有任何 .track-download 按钮`);
    return `rows=${detail.rows} downloadBtns=${detail.downloadBtns} first=${String(detail.firstTitle).trim().slice(0, 40)}`;
  });

  await suite.step('发现页', async () => {
    await clickRail(cdp, RAIL.discover);
    // .disc 先挂壳后异步填榜单，等节点数稳定后再断言
    const rows = await cdp.waitFor(
      `(() => { const n = document.querySelectorAll('.wall .disc *').length; return n > 30 ? n : null; })()`,
      { desc: '发现页 .wall .disc 榜单节点 > 30', timeoutMs: 25000, intervalMs: 400 },
    );
    await suite.shot('discover');
    return `节点 ${rows}`;
  });

  await suite.step('我喜欢的音乐', async () => {
    await clickRail(cdp, RAIL.liked);
    await cdp.waitFor(
      `(() => {
        const t = (document.querySelector('.wall-title') && document.querySelector('.wall-title').textContent || '').trim();
        const s = (document.querySelector('.wall-sub') && document.querySelector('.wall-sub').textContent || '').trim();
        return t === '我喜欢的音乐' ? { t, s } : null;
      })()`,
      { desc: '「我喜欢的音乐」墙面标题', timeoutMs: 20000, intervalMs: 400 },
    );
    const state = await wallState(cdp);
    await suite.shot('liked');
    return `sub=${state.sub} | rows=${state.rows}`;
  });

  await suite.step('最近播放', async () => {
    await clickRail(cdp, RAIL.recent);
    await cdp.waitFor(
      `(() => {
        const t = (document.querySelector('.wall-title') && document.querySelector('.wall-title').textContent || '').trim();
        return t ? t : null;
      })()`,
      { desc: '「最近播放」墙面标题', timeoutMs: 15000, intervalMs: 300 },
    );
    const state = await wallState(cdp);
    return `title=${state.title} | sub=${state.sub} | rows=${state.rows}`;
  });

  await suite.step('我的歌单（弹层或登录引导）', async () => {
    await clickRail(cdp, RAIL.playlists);
    await cdp.waitFor(`!!document.querySelector('.sheet') || !!document.querySelector('.login')`, {
      desc: '歌单弹层 .sheet 或登录引导 .login',
      timeoutMs: 12000,
      intervalMs: 250,
    });
    const detail = await cdp.eval(`(() => ({
      sheetTitle: (document.querySelector('.sheet .sheet-title') || {}).textContent || '',
      loginTitle: (document.querySelector('.login .login-title') || {}).textContent || '',
      isSheet: !!document.querySelector('.sheet'),
    }))()`);
    await suite.shot('playlists');
    const which = detail.isSheet ? `sheet=${String(detail.sheetTitle).trim()}` : `login=${String(detail.loginTitle).trim()}`;
    await closeOverlays(cdp);
    return which;
  });

  await suite.step('设置页（分区/下载/更新）', async () => {
    await clickRail(cdp, RAIL.settings);
    await cdp.waitFor(`!!document.querySelector('.settings-layout')`, { desc: '设置页 .settings-layout', timeoutMs: 15000 });
    const detail = await cdp.eval(`(() => ({
      navs: Array.from(document.querySelectorAll('.settings-nav-btn')).map((n) => (n.textContent || '').trim()),
      sections: Array.from(document.querySelectorAll('.settings-content .section-title')).map((n) => (n.textContent || '').trim()),
      panes: document.querySelectorAll('.settings-content .settings-pane').length,
    }))()`);
    suite.assert(detail.navs.length >= 6, `设置分区过少：${JSON.stringify(detail.navs)}`);
    suite.assert(detail.navs.includes('下载'), `设置缺少「下载」分区：${JSON.stringify(detail.navs)}`);
    suite.assert(detail.navs.includes('更新'), `设置缺少「更新」分区：${JSON.stringify(detail.navs)}`);
    await suite.shot('settings');
    return `navs=${detail.navs.join('/')} | sections=${detail.sections.length}`;
  });

  await suite.step('歌词页开/关', async () => {
    await closeOverlays(cdp);
    await openLyricsView(cdp);
    const detail = await cdp.eval(`(() => ({
      title: (document.querySelector('.lyrics-view .lyrics-title') || {}).textContent || '',
      lines: document.querySelectorAll('.lyrics-view .lyrics-lines *').length,
      roomStage: !!document.querySelector('.lyrics-view .room-stage, .lyrics-view canvas'),
    }))()`);
    await suite.shot('lyrics');
    await closeLyricsView(cdp);
    const closed = !(await cdp.eval(`!!document.querySelector('.lyrics-view')`));
    suite.assert(closed, '歌词页关闭失败（.lyrics-view 仍在 DOM）');
    return `title=${String(detail.title).trim() || '（未在播放）'} | 节点=${detail.lines} | roomStage=${detail.roomStage}`;
  });

  await suite.step('控制台零错误', async () => {
    // 给异步渲染（封面/接口回包）一点收尾时间
    await sleep(800);
    const errors = cdp.takeConsoleErrors();
    if (errors.length > 0) {
      const detail = errors
        .slice(0, 6)
        .map((err, i) => `${i + 1}. [${err.kind}] ${err.text.slice(0, 300)}`)
        .join('\n');
      throw new Error(`捕获到 ${errors.length} 条 console 错误 / 未捕获异常：\n${detail}`);
    }
    return '无 console error / 未捕获异常';
  });

  await suite.step('截图清单', async () => {
    suite.assert(suite.shots.length >= 5, `截图数量不足 5 张（实际 ${suite.shots.length}）`);
    return `${suite.shots.length} 张：${suite.shots.map((f) => f.split(/[\\/]/).pop()).join(' / ')}`;
  });

  // 收尾：回到首页，保证后续套件从干净状态开始
  await cdp.eval(`(() => { try { document.querySelector('.rail-btn[title^="首页"]')?.click(); } catch (e) {} return true; })()`).catch(() => {});
  const toast = await toastText(cdp).catch(() => '');
  if (toast) suite.note(`收尾时页面 toast：${toast}`);
});
