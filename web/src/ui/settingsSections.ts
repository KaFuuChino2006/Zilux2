import { h } from './dom';

export interface SettingsSectionDef {
  id: string;
  label: string;
  titles: string[];
}

interface SectionState {
  nav: HTMLElement;
  buttons: Map<string, HTMLButtonElement>;
  sections: Map<string, HTMLElement>;
  defs: SettingsSectionDef[];
}

const states = new WeakMap<HTMLElement, SectionState>();

/**
 * 把参数面板里平铺的 .ts-group 按标题收进若干分段。
 * 复用 .ts-seg 的白色滑块与 app.ts 的弹入动画；导航只建一次，
 * 面板重绘时只重建分段容器，避免滑块 observer 丢失。
 */
export function installSettingsSections(groupsHost: HTMLElement, defs: SettingsSectionDef[]): void {
  const column = groupsHost.parentElement;
  if (!column || !defs.length) return;

  let state = states.get(column);
  if (!state) {
    const nav = h('div', {class: 'ts-seg ts-section-nav', role: 'tablist', 'aria-label': '设置分类'});
    column.insertBefore(nav, groupsHost);
    state = {nav, buttons: new Map(), sections: new Map(), defs: []};
    states.set(column, state);
  }
  state.defs = defs;

  // 导航按钮保持同一批 DOM，重绘时只更新文字与绑定，MutationObserver 仍能驱动滑块。
  for (const def of defs) {
    let button = state.buttons.get(def.id);
    if (!button) {
      button = h('button', {class: 'ts-seg-btn ts-section-btn', type: 'button', role: 'tab'});
      button.onclick = () => activate(state!, def.id, true);
      state.buttons.set(def.id, button);
      state.nav.append(button);
    }
    button.textContent = def.label;
    button.dataset.section = def.id;
  }
  for (const [id, button] of state.buttons) {
    if (defs.some(def => def.id === id)) continue;
    button.remove();
    state.buttons.delete(id);
  }

  const byTitle = new Map<string, HTMLElement>();
  for (const group of Array.from(groupsHost.querySelectorAll<HTMLElement>('.ts-group'))) {
    const title = group.querySelector('.ts-group-title')?.textContent?.trim() ?? '';
    if (title) byTitle.set(title, group);
  }

  const sections = new Map<string, HTMLElement>();
  for (const def of defs) {
    const section = h('div', {class: 'ts-section', 'data-section': def.id, role: 'tabpanel'});
    for (const title of def.titles) {
      const group = byTitle.get(title);
      if (group) {
        section.append(group);
        byTitle.delete(title);
      }
    }
    sections.set(def.id, section);
  }
  // 以后新增但还没归类的分组放到第一段，避免设置项从界面上消失。
  const first = sections.get(defs[0]!.id);
  if (first) first.append(...byTitle.values());
  groupsHost.replaceChildren(...sections.values());
  state.sections = sections;

  const wanted = column.dataset.settingsSection;
  const active = wanted && sections.has(wanted) ? wanted : defs[0]!.id;
  activate(state, active, false);
  // 面板初次挂载时还没有布局，下一帧再校正一次滚动位置。
  requestAnimationFrame(() => {
    if (state!.sections === sections) activate(state!, active, false);
  });
}

function activate(state: SectionState, id: string, scroll: boolean): void {
  for (const [key, section] of state.sections) section.classList.toggle('is-on', key === id);
  for (const [key, button] of state.buttons) {
    button.classList.toggle('is-on', key === id);
    button.setAttribute('aria-selected', key === id ? 'true' : 'false');
  }
  const column = state.nav.parentElement;
  if (!column) return;
  column.dataset.settingsSection = id;
  if (scroll) column.scrollTop = 0;
}
