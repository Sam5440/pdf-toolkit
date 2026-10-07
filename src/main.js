// 应用主入口：布局、路由、主题、历史/设置入口
import './styles/tokens.css';
import './styles/components.css';
import './styles/workspace.css';

import { TOOLS, GROUPS, getTool } from './tools/registry.js';
import { esc, fmtTime2, fmtBytes } from './core/format.js';
import { toast, openModal, confirmDialog, button, field, favStar, checkbox, select, numberInput, textInput } from './components/ui.js';
import { initShadcn } from './components/shadcn.js';
import { openCommandPalette, commandPaletteButton, githubButton } from './components/search.js';
import { APP_NAME, APP_VERSION, APP_VERSION_FULL, APP_REPO, APP_REPO_ISSUES, APP_LICENSE, BUILD_COMMIT } from './core/version.js';
import { iconNode } from './components/icons.js';
import { getSettings, setSetting } from './core/settings.js';
import { pickFiles } from './core/files.js';
import { listHistory, getHistory, deleteHistory, clearHistory, historyUsedBytes } from './core/history.js';
import { probeFonts } from './core/fonts.js';
import { setLimitsFromSettings } from './core/limits.js';
import { isMoreGroup, getFavorites, resetFavorites, defaultFavoriteIds } from './core/favorites.js';
import { getRecent, pushRecent, removeRecent, clearRecent } from './core/recent.js';
import { DEFAULT_NAMING_TEMPLATE, getNamingTemplate } from './core/naming.js';
import { trayRail, trayToggleButton } from './components/tray.js';
import { hydrateTray, resetTrayStorage } from './core/tray.js';
import { getLogs, logsToText, clearLogs, onLogChange, log } from './core/logs.js';
import {
  addUserFont, listUserFonts, removeUserFont,
  getRemoteUrls, setRemoteUrls, syncRemoteFonts, FONT_ACCEPT,
} from './core/userfonts.js';
import { assetCacheEntries, clearAssetCache, storageEstimate } from './core/asset-cache.js';
import { engineList, onEngines, probeEngine, setEngineStatus } from './core/wasm-registry.js';
import { setupEngineRegistry } from './core/wasm-probes.js';

const app = document.getElementById('app');

let fontAvailability = {};
// 首页「更多工具」内联展开状态：模块级 = 应用会话内记忆，整页刷新后复位收起
let homeMoreOpen = false;

function applyTheme() {
  const s = getSettings();
  const dark = s.theme === 'dark' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.accent = s.accent || 'neutral';
  if (s.dopamine) root.dataset.dopamine = s.dopamine;
  else delete root.dataset.dopamine;
  if (s.radius && s.radius !== 'default') root.dataset.radius = s.radius;
  else delete root.dataset.radius;
  if (s.motion === false) root.dataset.motion = 'off';
  else delete root.dataset.motion;
}

function isDarkTheme() {
  const t = getSettings().theme;
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

// ---- 主题/强调色切换动效 ------------------------------------------------
// 支持 View Transitions 时把改动包进 startViewTransition，新状态从触发控件
// 位置做 clip-path 圆形扫掠（样式见 tokens.css ::view-transition-*）；
// 不支持时回退 .theme-anim 短窗全站颜色渐变。motion 关 / 系统减动效直接切换。
// navigator.webdriver（自动化）跳过扫掠走同步路径，保证 e2e 时序确定。
let themeVTBusy = false;
let themeAnimTimer = 0;

function addThemeAnimWindow() {
  const root = document.documentElement;
  root.classList.add('theme-anim');
  clearTimeout(themeAnimTimer);
  themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 520);
}

function animateThemeChange(updateFn, origin) {
  const motionOff = getSettings().motion === false
    || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (motionOff) { updateFn(); return; }
  const vtOk = typeof document.startViewTransition === 'function' && !navigator.webdriver;
  if (vtOk && !themeVTBusy) {
    const rect = origin?.getBoundingClientRect?.();
    themeVTBusy = true;
    const vt = document.startViewTransition(updateFn);
    vt.ready.then(() => {
      const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 80;
      const y = rect ? rect.top + rect.height / 2 : 40;
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 440, easing: 'cubic-bezier(0.33, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => { /* 过渡被跳过即无妨 */ });
    vt.finished.catch(() => {}).finally(() => { themeVTBusy = false; });
    return;
  }
  if (!themeVTBusy) addThemeAnimWindow(); // 扫掠进行中再触发：直接切换，避免旧快照上的渐变穿帮
  updateFn();
}

/** 原位同步顶栏主题按钮（图标/文案/可访问名），免去整页重渲染打断扫掠 */
function syncThemeButton() {
  const btn = document.querySelector('.topbar .tb-actions button[aria-label="深色"], .topbar .tb-actions button[aria-label="浅色"]');
  if (!btn) return;
  const dark = isDarkTheme();
  btn.innerHTML = '';
  btn.appendChild(iconNode(dark ? 'theme-sun' : 'theme-moon'));
  const span = document.createElement('span');
  span.className = 'btn-label';
  span.textContent = dark ? '浅色' : '深色';
  btn.appendChild(span);
  btn.setAttribute('aria-label', dark ? '浅色' : '深色');
}

function toggleTheme(origin) {
  animateThemeChange(() => {
    setSetting('theme', isDarkTheme() ? 'light' : 'dark');
    applyTheme();
    syncThemeButton();
  }, origin);
}

// ---- 多巴胺随机配色（右下角浮钮） --------------------------------------
// 池子 = tokens.css 里 html[data-dopamine=<id>] 定义的 8 套鲜艳配色（亮/暗各对应一版）。
// 单击：随机换一套（避开当前）+ 圆形扫掠过渡；选中态持续到再次点击或双击恢复。
const DOPAMINE_POOL = ['candy', 'citrus', 'lime', 'sky', 'grape', 'coral', 'teal', 'mango'];

function pickDopamine() {
  const cur = getSettings().dopamine || '';
  const pool = DOPAMINE_POOL.filter((id) => id !== cur);
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomDopamine(origin) {
  animateThemeChange(() => {
    setSetting('dopamine', pickDopamine());
    applyTheme();
  }, origin);
}

function clearDopamine(origin) {
  animateThemeChange(() => {
    setSetting('dopamine', '');
    applyTheme();
  }, origin);
}

/** 右下角浮动圆钮：单击随机切换多巴胺配色，双击恢复默认配色 */
function dopamineButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-outline dopa-btn';
  btn.appendChild(iconNode('dopamine'));
  btn.setAttribute('aria-label', '多巴胺随机配色（单击切换，双击恢复默认）');
  btn.title = '单击换一套多巴胺随机配色，双击恢复默认';
  let clickTimer = 0;
  btn.addEventListener('click', (ev) => {
    // 单击/双击复用：单击延迟触发等 dblclick 判定，避免连换两套后又被重置
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => randomDopamine(ev.currentTarget), 260);
  });
  btn.addEventListener('dblclick', (ev) => {
    clearTimeout(clickTimer);
    clearDopamine(ev.currentTarget);
  });
  return btn;
}

function navigate() {
  const hash = location.hash || '#/';
  const m = /^#\/tool\/([\w-]+)$/.exec(hash);
  renderApp(m ? m[1] : null);
}

/** 侧边栏：首页入口 + 核心分组逐组列出；hiddenOnHome 分组统一收进「更多」区（专项页链接 + 全部工具） */
function buildSidebar(sidebar, toolId) {
  // 首页入口（工具页/更多页/历史页均可见；窄屏图标栏下是唯一回首页入口之一）
  const homeNav = document.createElement('nav');
  homeNav.className = 'side-nav side-nav-home';
  const onHome = !toolId && location.hash !== '#/more' && location.hash !== '#/history';
  const homeLink = document.createElement('a');
  homeLink.className = 'side-link' + (onHome ? ' active' : '');
  homeLink.href = '#/';
  homeLink.innerHTML = `<span class="ico"></span><span class="link-text">首页</span>`;
  homeLink.querySelector('.ico').appendChild(iconNode('home'));
  homeNav.appendChild(homeLink);
  sidebar.appendChild(homeNav);

  const moreGroups = GROUPS.filter((g) => g.hiddenOnHome);
  const emitGroup = (gh, items) => {
    const head = document.createElement('div');
    head.className = 'side-group';
    head.textContent = gh;
    sidebar.appendChild(head);
    const nav = document.createElement('nav');
    nav.className = 'side-nav';
    for (const t of items) {
      const a = document.createElement('a');
      a.className = 'side-link' + (t.id === toolId ? ' active' : '');
      a.href = `#/tool/${t.id}`;
      a.innerHTML = `<span class="ico"></span><span class="link-text">${esc(t.name)}</span>`;
      a.querySelector('.ico').appendChild(iconNode(t.id));
      nav.appendChild(a);
    }
    sidebar.appendChild(nav);
  };
  for (const g of GROUPS) {
    if (g.hiddenOnHome) continue;
    const items = TOOLS.filter((t) => t.group === g.id);
    if (items.length) emitGroup(g.name, items);
  }
  const moreItems = moreGroups.flatMap((g) => TOOLS.filter((t) => t.group === g.id));
  if (moreItems.length) {
    const head = document.createElement('div');
    head.className = 'side-group';
    head.textContent = '更多';
    sidebar.appendChild(head);
    const nav = document.createElement('nav');
    nav.className = 'side-nav';
    const moreLink = document.createElement('a');
    moreLink.className = 'side-link side-link-more' + (location.hash === '#/more' ? ' active' : '');
    moreLink.href = '#/more';
    moreLink.innerHTML = `<span class="ico"></span><span class="link-text">更多工具页</span>`;
    moreLink.querySelector('.ico').appendChild(iconNode('more-grid'));
    nav.appendChild(moreLink);
    for (const t of moreItems) {
      const a = document.createElement('a');
      a.className = 'side-link' + (t.id === toolId ? ' active' : '');
      a.href = `#/tool/${t.id}`;
      a.innerHTML = `<span class="ico"></span><span class="link-text">${esc(t.name)}</span>`;
      a.querySelector('.ico').appendChild(iconNode(t.id));
      nav.appendChild(a);
    }
    sidebar.appendChild(nav);
  }
}

function renderApp(toolId) {
  const tool = toolId ? getTool(toolId) : null;
  app.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'app';

  // 侧边栏（左上角品牌 = 回首页入口）
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  const brand = document.createElement('a');
  brand.className = 'side-brand';
  brand.href = '#/';
  brand.title = '回到首页';
  brand.setAttribute('aria-label', 'PDF 万能工具箱 · 回到首页');
  brand.innerHTML = `<div class="logo">PDF</div><span class="brand-text">万能工具箱</span>`;
  sidebar.appendChild(brand);
  buildSidebar(sidebar, toolId);
  const foot = document.createElement('div');
  foot.className = 'side-foot';
  foot.innerHTML = `<div class="local-badge"><span class="dot"></span>本地处理 · 文件不上传</div>
    <div style="margin-top:6px">字体：<span data-font-ok>…</span></div>`;
  sidebar.appendChild(foot);
  const fontOkEl = foot.querySelector('[data-font-ok]');

  // 主区
  const main = document.createElement('div');
  main.className = 'main';
  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <div class="tb-title">${tool ? `<span class="tb-ico"></span>${esc(tool.name)}<span class="tb-sub">${esc(tool.desc)}</span>` : (location.hash === '#/more' ? '更多工具' : 'PDF 万能工具箱')} </div>`;
  if (tool) topbar.querySelector('.tb-ico').appendChild(iconNode(tool.id));
  const tbBtns = document.createElement('div');
  tbBtns.className = 'tb-actions';
  const iconBtn = (id, label, cls, onClick) => {
    const b = button('', cls, onClick);
    b.appendChild(iconNode(id));
    // 标签包一层 span：窄屏 CSS 隐藏 .btn-label 后按钮退化为纯图标（aria-label 保可访问名）
    const span = document.createElement('span');
    span.className = 'btn-label';
    span.textContent = label;
    b.appendChild(span);
    b.setAttribute('aria-label', label);
    return b;
  };
  const dark0 = isDarkTheme();
  const themeBtn = iconBtn(dark0 ? 'theme-sun' : 'theme-moon', dark0 ? '浅色' : '深色', 'btn-ghost btn-sm', (ev) => toggleTheme(ev.currentTarget));
  const searchCtx = { toggleTheme, openSettings };
  const searchBtn = commandPaletteButton(searchCtx);
  const ghBtn = githubButton();
  const histBtn = iconBtn('history', '历史', 'btn-ghost btn-sm', () => { location.hash = '#/history'; });
  const setBtn = iconBtn('settings', '设置', 'btn-ghost btn-sm', () => openSettings());
  tbBtns.append(searchBtn, themeBtn, trayToggleButton(), histBtn, ghBtn, setBtn);
  topbar.appendChild(tbBtns);

  const content = document.createElement('div');
  content.className = 'content page-enter';

  if (tool) {
    const ws = document.createElement('div');
    ws.className = 'workspace';
    const mainCol = document.createElement('div');
    mainCol.className = 'ws-main';
    tool.render(mainCol);
    ws.appendChild(mainCol);
    content.appendChild(ws);
    // 记录最近使用（设置可整体关闭）；置于 renderApp 内 = 每次打开工具页计一次
    if (getSettings().recentEnabled !== false) pushRecent(toolId);
  } else if (location.hash === '#/history') {
    renderHistory(content);
  } else if (location.hash === '#/more') {
    renderMorePage(content);
  } else {
    renderHome(content);
  }

  main.append(topbar, content);
  shell.append(sidebar, main);
  // 右侧 PDF 暂存区（全局单例节点，跨页面共享）
  shell.append(trayRail());
  // 右下角多巴胺配色浮钮（单击换随机配色，双击恢复）
  shell.append(dopamineButton());
  app.appendChild(shell);
  fontOkEl.textContent = fontAvailability['noto-sc'] ? '中文水印已就绪' : '需部署字体包';
}

/** 工具卡片（带右上角收藏星标）。首页/更多页共用 */
function toolCard(t) {
  const c = document.createElement('a');
  c.className = 'tool-card';
  c.href = `#/tool/${t.id}`;
  c.innerHTML = `
    <div class="tc-ico"></div>
    <div class="tc-name">${esc(t.name)}</div>
    <div class="tc-desc">${esc(t.desc)}</div>`;
  c.querySelector('.tc-ico').appendChild(iconNode(t.id));
  // 星标切换：首页需即时增删卡片 → 重渲染；#/more 专项页原位更新即可
  c.appendChild(favStar(t.id, {
    onChange: () => { if (location.hash !== '#/more') navigate(); },
  }));
  return c;
}

/** 列表视图行（工具内容与卡片一致：图标/名称/描述/星标）。首页/更多页共用 */
function toolRow(t) {
  const r = document.createElement('a');
  r.className = 'tool-row';
  r.href = `#/tool/${t.id}`;
  r.innerHTML = `
    <span class="tr-ico"></span>
    <span class="tr-name">${esc(t.name)}</span>
    <span class="tr-desc">${esc(t.desc)}</span>`;
  r.querySelector('.tr-ico').appendChild(iconNode(t.id));
  r.appendChild(favStar(t.id, {
    onChange: () => { if (location.hash !== '#/more') navigate(); },
  }));
  return r;
}

/** 卡片/列表视图切换（右侧小型分段控件；aria 带视图全称避免与暂存区「列表」按钮撞可达名） */
function viewSwitch() {
  const cur = getSettings().viewMode || 'cards';
  const wrap = document.createElement('div');
  wrap.className = 'view-switch';
  for (const [val, label, aria] of [['cards', '卡片', '卡片视图'], ['list', '列表', '列表视图']]) {
    const b = button(label, cur === val ? 'btn-primary btn-xs' : 'btn-ghost btn-xs', () => {
      if (getSettings().viewMode === val) return;
      setSetting('viewMode', val);
      navigate();
    });
    b.setAttribute('aria-label', aria);
    b.setAttribute('aria-pressed', String(cur === val));
    wrap.appendChild(b);
  }
  return wrap;
}

function appendSection(content, name, items, countNote) {
  const head = document.createElement('div');
  head.className = 'home-sec';
  head.innerHTML = `<h2>${esc(name)}</h2>` + (countNote ? `<span class="muted-sm">${esc(countNote)}</span>` : '');
  content.appendChild(head);
  const listMode = getSettings().viewMode === 'list';
  const grid = document.createElement('div');
  grid.className = listMode ? 'tool-list' : 'tool-grid';
  items.forEach((t, i) => {
    const el = listMode ? toolRow(t) : toolCard(t);
    if (!listMode) el.style.setProperty('--stagger-i', Math.min(i, 12)); // 入场交错仅卡片网格需要
    grid.appendChild(el);
  });
  content.appendChild(grid);
}

/** 「更多」完整目录构建：扩展分组在前 + 核心工具目录在后。「更多」专项页与首页内联展开共用 */
function appendMoreSections(host) {
  const ordered = [...GROUPS.filter((g) => g.hiddenOnHome), ...GROUPS.filter((g) => !g.hiddenOnHome)];
  let shown = 0;
  let coreStarted = false;
  for (const g of ordered) {
    const items = TOOLS.filter((t) => t.group === g.id);
    if (!items.length) continue;
    if (!g.hiddenOnHome && !coreStarted) {
      coreStarted = true;
      if (shown) {
        const div = document.createElement('div');
        div.className = 'home-sec-divider';
        div.textContent = '—— 核心工具 ——';
        host.appendChild(div);
      }
    }
    appendSection(host, g.name, items, g.hiddenOnHome ? `${items.length} 个工具 · 默认不在首页` : `${items.length} 个工具`);
    shown += items.length;
  }
  return shown;
}

/** 首页第一行「最近使用」：最近用过的功能快捷入口（≤10 个），单条可删；设置可整体关闭 */
function renderRecentRow(content) {
  if (getSettings().recentEnabled === false) return;
  const ids = getRecent().filter((id) => getTool(id));
  if (!ids.length) return;
  const sec = document.createElement('div');
  sec.className = 'recent-sec';
  const head = document.createElement('div');
  head.className = 'home-sec';
  head.innerHTML = `<h2>最近使用</h2><span class="muted-sm">${ids.length} 个 · 最多保留 10 条</span>`;
  sec.appendChild(head);
  const row = document.createElement('div');
  row.className = 'recent-row';
  row.setAttribute('role', 'list');
  for (const id of ids) {
    const t = getTool(id);
    const chip = document.createElement('div');
    chip.className = 'recent-chip';
    chip.setAttribute('role', 'listitem');
    const link = document.createElement('a');
    link.className = 'recent-link';
    link.href = `#/tool/${t.id}`;
    link.title = t.name;
    const ico = document.createElement('span');
    ico.className = 'rc-ico';
    ico.appendChild(iconNode(t.id));
    const nm = document.createElement('span');
    nm.className = 'rc-name';
    nm.textContent = t.name;
    link.append(ico, nm);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-del';
    del.setAttribute('aria-label', `删除最近记录：${t.name}`);
    del.title = '从最近使用中移除';
    del.textContent = '×';
    del.addEventListener('click', (ev) => {
      ev.preventDefault();
      removeRecent(id);
      chip.remove();
      if (!row.children.length) sec.remove();
    });
    chip.append(link, del);
    row.appendChild(chip);
  }
  sec.appendChild(row);
  content.appendChild(sec);
}

/** 首页：只显示已收藏的工具，按功能分类分区（收藏 = 是否在首页显示的唯一开关） */
function renderHome(content) {
  renderRecentRow(content); // 第一行：最近使用（开启且有记录时显示）
  const hero = document.createElement('div');
  hero.className = 'card';
  hero.style.marginBottom = '16px';
  hero.innerHTML = `
    <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
      <div class="hero-ico" data-hero-ico></div>
      <div style="flex:1;min-width:0">
        <b style="font-size:15px">全部处理在您的浏览器内完成</b>
        <div class="note" style="margin-top:4px">文件不会发送到任何服务器：选择文件后，压缩、合并、水印、OCR 等全部通过 WASM 在本机浏览器中执行，可离线内网使用。点击卡片右上角的 ☆ 可调整首页显示。</div>
      </div>
      <div data-view-switch></div>
    </div>`;
  hero.querySelector('[data-hero-ico]').appendChild(iconNode('security'));
  hero.querySelector('[data-view-switch]').appendChild(viewSwitch());
  content.appendChild(hero);

  const favs = getFavorites();
  const sections = [];
  for (const g of GROUPS) {
    const items = TOOLS.filter((t) => t.group === g.id && favs.has(t.id));
    if (items.length) sections.push({ g, items });
  }
  if (!sections.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.style.marginBottom = '16px';
    empty.innerHTML = '<div class="card-body"><div class="empty"><span class="empty-ico"></span>还没有收藏的工具<br>在下方展开全部功能，点击卡片右上角的 ★ 收藏到首页</div></div>';
    empty.querySelector('.empty-ico').appendChild(iconNode('more-grid'));
    content.appendChild(empty);
  }
  for (const s of sections) appendSection(content, s.g.name, s.items, `${s.items.length} 个工具`);

  // 底部入口：点击在下方内联展开全部扩展功能（不再跳转专项页；应用会话内记忆展开状态）
  const moreCount = TOOLS.filter((t) => isMoreGroup(t.group)).length;
  if (moreCount) {
    const wrap = document.createElement('div');
    wrap.className = 'home-more-link';
    const toggleBtn = button(
      homeMoreOpen ? '收起更多工具' : `更多工具页（${moreCount} 个扩展功能）`,
      'btn-outline',
      () => {
        homeMoreOpen = !homeMoreOpen; // 就地展开/收起，避免整页重渲染抖动
        toggleBtn.textContent = homeMoreOpen ? '收起更多工具' : `更多工具页（${moreCount} 个扩展功能）`;
        let box = content.querySelector('.home-more-open');
        if (homeMoreOpen && !box) {
          box = document.createElement('div');
          box.className = 'home-more-open';
          content.appendChild(box);
          appendMoreSections(box);
          box.scrollIntoView({ behavior: getSettings().motion === false ? 'auto' : 'smooth', block: 'start' });
        } else if (!homeMoreOpen && box) {
          box.remove();
        }
      },
    );
    wrap.appendChild(toggleBtn);
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = '全部扩展功能按类别分组，在下方内联展开视图（可点右上角切换列表视图）；收藏后显示在首页';
    wrap.appendChild(note);
    content.appendChild(wrap);
    if (homeMoreOpen) { // 重渲染（如星标变化）后保持展开
      const box = document.createElement('div');
      box.className = 'home-more-open';
      content.appendChild(box);
      appendMoreSections(box);
    }
  }
}

/** 「更多」专项页：扩展工具按功能分类分区（默认全部不收藏）；
 *  核心工具也列在页面下方，作为完整目录——否则取消收藏的核心工具将无处重新收藏 */
function renderMorePage(content) {
  const head = document.createElement('div');
  head.className = 'card';
  head.style.marginBottom = '16px';
  head.innerHTML = `
    <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
      <div class="hero-ico" data-hero-ico></div>
      <div style="flex:1;min-width:0">
        <b style="font-size:15px">更多工具</b>
        <div class="note" style="margin-top:4px">扩展功能按类别分组（默认不收藏）。点击卡片右上角的 ★ 收藏后即显示在首页，再次点击取消收藏；下方同时列出核心工具，方便随时调整。所有处理仍在本地浏览器完成。</div>
      </div>
      <div data-view-switch></div>
    </div>`;
  head.querySelector('[data-hero-ico]').appendChild(iconNode('more-grid'));
  head.querySelector('[data-view-switch]').appendChild(viewSwitch());
  content.appendChild(head);

  const shown = appendMoreSections(content);
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = '<div class="card-body"><div class="empty">暂无扩展工具</div></div>';
    content.appendChild(empty);
  }
}

async function renderHistory(content) {
  content.innerHTML = '<div class="card"><div class="card-body"><div class="empty"><span class="spinner"></span>加载历史中…</div></div></div>';
  const [items, used] = await Promise.all([listHistory({ limit: 200 }), historyUsedBytes()]);
  content.innerHTML = '';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
  head.innerHTML = `<b>本地历史记录</b><span class="muted-sm">占用 ${fmtBytes(used)}</span>`;
  const clearBtn = button('清空全部', 'btn-danger btn-sm', async () => {
    const ok = await confirmDialog({
      title: '清空本地历史记录',
      message: '确定清空全部本地历史记录？此操作不可恢复。',
      confirmText: '清空',
      destructive: true,
    });
    if (!ok) return;
    await clearHistory();
    toast('已清空');
    renderApp(null);
  });
  head.appendChild(clearBtn);
  content.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = '<div class="card-body"><div class="empty"><span class="empty-ico"></span>暂无历史记录<br>各工具处理完成后点击"保存到历史"即可保留结果</div></div>';
    empty.querySelector('.empty-ico').appendChild(iconNode('history'));
    content.appendChild(empty);
    return;
  }
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '8px';
    const body = document.createElement('div');
    body.className = 'card-body';
    body.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    const info = document.createElement('div');
    info.style.flex = '1';
    info.innerHTML = `
      <b>${esc(it.toolName)}</b> <span class="muted-sm">${fmtTime2(it.time)}</span>
      <div class="note">${esc((it.docNames || []).join('、').slice(0, 80))}</div>
      <div class="note">${(it.outputs || []).map((o) => `${esc(o.name)}（${fmtBytes(o.size)}）`).join(' · ')}</div>`;
    const viewBtn = button('查看/下载', 'btn-outline btn-sm', async () => {
      const rec = await getHistory(it.id);
      if (!rec) { toast('记录不存在', 'error'); return; }
      const box = document.createElement('div');
      for (const o of rec.outputs || []) {
        const line = document.createElement('div');
        line.className = 'result-artifact';
        line.innerHTML = `<span class="ra-ico"></span>
          <div class="ra-info"><div class="ra-name">${esc(o.name)}</div><div class="ra-meta">${fmtBytes(o.size)}</div></div>`;
        line.querySelector('.ra-ico').appendChild(iconNode('doc'));
        const dl = button('下载', 'btn-primary btn-sm', () => {
          const url = URL.createObjectURL(o.blob);
          const a = document.createElement('a');
          a.href = url; a.download = o.name; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        });
        line.appendChild(dl);
        box.appendChild(line);
      }
      openModal(`历史记录 · ${esc(it.toolName)}`, box);
    });
    const delBtn = button('删除', 'btn-ghost btn-sm', async () => {
      await deleteHistory(it.id);
      toast('已删除');
      renderApp(null);
    });
    body.append(info, viewBtn, delBtn);
    card.appendChild(body);
    content.appendChild(card);
  }
}

/** 收起开场动画（index.html 内联 splash）：等最短展示时长后淡出移除 */
function dismissBootSplash(delay = 0) {
  const splash = document.querySelector('.boot-splash');
  if (!splash) return;
  setTimeout(() => {
    splash.classList.add('boot-done');
    setTimeout(() => splash.remove(), 500);
  }, Math.max(0, delay));
}

const ACCENTS = [
  { id: 'neutral', label: '中性（默认）', swatch: '#18181b', dark: '#fafafa' },
  { id: 'blue', label: '蓝色', swatch: '#2563eb', dark: '#3b82f6' },
  { id: 'violet', label: '紫色', swatch: '#7c3aed', dark: '#a78bfa' },
  { id: 'green', label: '绿色', swatch: '#16a34a', dark: '#22c55e' },
  { id: 'amber', label: '琥珀', swatch: '#d97706', dark: '#f59e0b' },
  { id: 'red', label: '红色', swatch: '#dc2626', dark: '#ef4444' },
];

function secTitle(text) {
  const d = document.createElement('div');
  d.className = 'set-sec-title';
  d.textContent = text;
  return d;
}

async function openSettings() {
  const s = getSettings();
  const box = document.createElement('div');

  // ---- 外观 ----
  box.appendChild(secTitle('外观'));
  box.appendChild(field('主题', (() => {
    const sel = select([
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
      { value: 'auto', label: '跟随系统' },
    ], s.theme);
    sel.onchange = () => { animateThemeChange(() => { setSetting('theme', sel.value); applyTheme(); syncThemeButton(); }, sel); };
    return sel;
  })()));
  const accentRow = document.createElement('div');
  accentRow.className = 'accent-row';
  const dark = isDarkTheme();
  for (const a of ACCENTS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'accent-swatch';
    sw.title = a.label;
    sw.setAttribute('aria-label', `主题色：${a.label}`);
    sw.style.background = dark ? a.dark : a.swatch;
    if ((s.accent || 'neutral') === a.id) sw.setAttribute('data-selected', '');
    sw.onclick = () => {
      animateThemeChange(() => {
        setSetting('accent', a.id);
        accentRow.querySelectorAll('.accent-swatch').forEach((x) => x.removeAttribute('data-selected'));
        sw.setAttribute('data-selected', '');
        applyTheme();
      }, sw);
    };
    accentRow.appendChild(sw);
  }
  const accentField = field('主题色', accentRow, '按钮、选中态与焦点环的强调色（默认中性黑，对齐 ui.shadcn.com）');
  accentField.querySelector('div.accent-row').style.marginTop = '2px';
  box.appendChild(accentField);
  box.appendChild(field('圆角', (() => {
    const sel = select([
      { value: 'none', label: '直角' },
      { value: 'sm', label: '小' },
      { value: 'default', label: '默认（0.625rem）' },
      { value: 'lg', label: '大' },
      { value: 'xl', label: '特大' },
    ], s.radius || 'default');
    sel.onchange = () => { setSetting('radius', sel.value); applyTheme(); };
    return sel;
  })()));
  const motionCb = checkbox('启用界面动画与过渡（页面切换、弹层等）', s.motion !== false);
  motionCb._input.onchange = () => { setSetting('motion', motionCb._input.checked); applyTheme(); };
  box.appendChild(motionCb);
  box.appendChild(field('图标方案', (() => {
    const sel = select([
      { value: 'svg', label: '手绘线描 SVG（默认）' },
      { value: 'color', label: '多彩手绘 SVG' },
      { value: 'emoji', label: '原版 emoji' },
    ], s.iconSet || 'svg');
    sel.onchange = () => { setSetting('iconSet', sel.value); navigate(); };
    return sel;
  })()));

  // ---- 处理 ----
  box.appendChild(secTitle('处理'));
  box.appendChild(field('单文件大小上限（MB）', (() => { const i = numberInput(s.maxUploadMB); i.min = 1; i.max = 2048; i.onchange = () => setSetting('maxUploadMB', +i.value || 500); return i; })()));
  box.appendChild(field('历史保留配额（MB）', (() => { const i = numberInput(s.historyQuotaMB); i.min = 50; i.max = 10240; i.onchange = () => setSetting('historyQuotaMB', +i.value || 500); return i; })()));
  box.appendChild(field('暂存区持久化配额（MB）', (() => { const i = numberInput(s.trayQuotaMB || 1024); i.min = 100; i.max = 10240; i.onchange = () => setSetting('trayQuotaMB', +i.value || 1024); return i; })(), '暂存区内容（含文件夹）持久保存的总量上限，超出自动移除最早条目'));
  box.appendChild(field('OCR 识别 DPI', (() => { const i = numberInput(s.ocrDpi); i.min = 96; i.max = 300; i.step = 8; i.onchange = () => setSetting('ocrDpi', +i.value || 200); return i; })(), '越高识别越准、越慢'));
  box.appendChild(field('产物命名模板', (() => {
    const i = textInput(getNamingTemplate(), '如 {name}-{op}-{params}-{time}');
    i.setAttribute('aria-label', '产物命名模板');
    i.onchange = () => {
      const v = i.value.trim();
      setSetting('namingTemplate', v || DEFAULT_NAMING_TEMPLATE);
      if (!v) i.value = DEFAULT_NAMING_TEMPLATE;
    };
    return i;
  })(), '令牌：{name} 原文件名 · {op} 操作 · {params} 参数（超 10 字符截断）· {time} 时间 · {i} 序号。留空恢复默认。多产物会自动追加页码/序号'));

  // ---- 最近使用 ----
  box.appendChild(secTitle('最近使用'));
  const recentCb = checkbox('记录最近使用的功能，并在首页第一行展示（最多 10 条）', s.recentEnabled !== false);
  recentCb._input.onchange = () => { setSetting('recentEnabled', recentCb._input.checked); navigate(); };
  box.appendChild(recentCb);
  const recentRow = document.createElement('div');
  recentRow.appendChild(button('清空最近使用记录', 'btn-outline btn-sm', () => {
    clearRecent();
    toast('已清空最近使用记录');
  }));
  recentRow.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '清除已记录的功能使用历史（不影响收藏与本地文件历史）；单条记录可在首页「最近使用」行内点 × 删除。' }));
  box.appendChild(recentRow);

  // ---- 引擎状态（WASM）----
  box.appendChild(secTitle('引擎状态（WASM）'));
  const engineNote = document.createElement('div');
  engineNote.className = 'hint';
  engineNote.style.marginBottom = '8px';
  engineNote.textContent = '全部引擎为按需加载的本地 WASM：首次使用对应功能时才下载/初始化，之后走浏览器缓存。';
  box.appendChild(engineNote);
  const engineListEl = document.createElement('div');
  engineListEl.className = 'engine-list';
  box.appendChild(engineListEl);
  const renderEngines = () => {
    engineListEl.innerHTML = '';
    for (const e of engineList()) {
      const row = document.createElement('div');
      row.className = `engine-row st-${e.status}`;
      const dot = document.createElement('span');
      dot.className = 'engine-dot';
      dot.setAttribute('aria-hidden', 'true');
      const info = document.createElement('div');
      info.className = 'engine-info';
      const nameLine = document.createElement('div');
      nameLine.className = 'engine-name';
      nameLine.innerHTML = `<b>${esc(e.label)}</b><span class="muted-sm">${esc(e.size || '')}</span>`;
      const descLine = document.createElement('div');
      descLine.className = 'engine-desc';
      descLine.textContent = e.desc || '';
      info.append(nameLine, descLine);
      const right = document.createElement('div');
      right.className = 'engine-state';
      if (e.status === 'ready') {
        const b = document.createElement('span');
        b.className = 'badge badge-ok';
        b.textContent = '✓ 就绪';
        right.appendChild(b);
      } else if (e.status === 'loading') {
        const s = document.createElement('span');
        s.className = 'spinner';
        right.appendChild(s);
      } else if (e.status === 'error') {
        const b = document.createElement('span');
        b.className = 'badge badge-no';
        b.textContent = '失败';
        right.appendChild(b);
      }
      if (e.status !== 'loading' && e.probe) {
        right.appendChild(button(e.status === 'idle' ? '加载' : '重新检测', 'btn-outline btn-xs', (ev) => {
          ev.currentTarget.disabled = true;
          probeEngine(e.id);
        }));
      }
      const detail = document.createElement('div');
      detail.className = 'engine-detail';
      if (e.status === 'loading') detail.textContent = e.detail || '加载中…';
      else if (e.status === 'error') detail.textContent = e.detail || '加载失败';
      else if (e.status === 'ready' && e.detail) detail.textContent = e.detail;
      if (detail.textContent) info.appendChild(detail);
      // 下载进度条（大体积 WASM 包：pandoc / Typst 等）
      if (e.status === 'loading' && e.progress?.total) {
        const pct = Math.min(100, Math.round((e.progress.loaded / e.progress.total) * 100));
        const bar = document.createElement('div');
        bar.className = 'engine-progress';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', `${e.label} 下载进度`);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(pct));
        const fill = document.createElement('div');
        fill.className = 'engine-progress-fill';
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        const pctText = document.createElement('span');
        pctText.className = 'engine-progress-text';
        pctText.textContent = `${pct}%（${fmtBytes(e.progress.loaded)} / ${fmtBytes(e.progress.total)}）`;
        info.append(bar, pctText);
      }
      row.append(dot, info, right);
      engineListEl.appendChild(row);
    }
  };
  renderEngines();
  const unsubEngines = onEngines(renderEngines);

  // ---- 外挂字体 ----
  box.appendChild(secTitle('外挂字体'));
  const fontNote = document.createElement('div');
  fontNote.className = 'hint';
  fontNote.style.marginBottom = '8px';
  fontNote.textContent = '上传（ttf/otf/ttc/woff/woff2）或订阅远程字体，保存在本机浏览器；可用于水印/文字工具的字体选择，并注入 Typst 排版引擎（Markdown 转 PDF）。';
  box.appendChild(fontNote);
  const fontToolbar = document.createElement('div');
  fontToolbar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
  const fontUploadBtn = button('上传字体', 'btn-outline btn-sm', async () => {
    const files = await pickFiles({ multiple: true, accept: `${FONT_ACCEPT},application/font-woff,application/x-font-ttf` });
    if (!files.length) return;
    let okN = 0;
    for (const f of files) {
      try {
        const bytes = await f.arrayBuffer();
        await addUserFont({ bytes, name: f.name, source: 'upload' });
        okN += 1;
      } catch (err) {
        toast(`${f.name}：${err.message}`, 'error', 5000);
      }
    }
    if (okN) toast(`已导入 ${okN} 个字体`);
    await renderUserFonts();
  });
  fontUploadBtn.setAttribute('aria-label', '上传外挂字体文件');
  fontToolbar.appendChild(fontUploadBtn);
  box.appendChild(fontToolbar);
  const fontListEl = document.createElement('div');
  fontListEl.className = 'userfont-list';
  fontListEl.setAttribute('aria-label', '外挂字体列表');
  box.appendChild(fontListEl);
  const renderUserFonts = async () => {
    const fonts = await listUserFonts();
    fontListEl.textContent = '';
    if (!fonts.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '尚未安装外挂字体。';
      fontListEl.appendChild(empty);
      return;
    }
    for (const f of fonts) {
      const rowEl = document.createElement('div');
      rowEl.className = 'userfont-row';
      const infoEl = document.createElement('div');
      infoEl.className = 'uf-info';
      const nm = document.createElement('div');
      nm.className = 'uf-name';
      nm.textContent = f.family || f.name;
      const meta = document.createElement('div');
      meta.className = 'uf-meta';
      meta.textContent = `${f.name} · ${fmtBytes(f.size)} · ${f.source === 'remote' ? '远程订阅' : '本地上传'}`;
      infoEl.append(nm, meta);
      const del = button('删除', 'btn-ghost btn-xs', async () => {
        await removeUserFont(f.id);
        await renderUserFonts();
        toast('已删除外挂字体');
      });
      del.setAttribute('aria-label', `删除外挂字体：${f.family || f.name}`);
      rowEl.append(infoEl, del);
      fontListEl.appendChild(rowEl);
    }
  };
  await renderUserFonts();
  // 远程字体订阅：每行一个 URL；保存即同步下载并持久化（启动时也会自动同步）
  const urlArea = document.createElement('textarea');
  urlArea.className = 'remote-font-urls';
  urlArea.rows = 3;
  urlArea.placeholder = 'https://example.com/fonts/MyFont-Regular.ttf\nhttps://example.com/fonts/MyFont-Bold.ttf';
  urlArea.setAttribute('aria-label', '远程字体 URL 列表');
  urlArea.value = getRemoteUrls().join('\n');
  const urlStatus = document.createElement('div');
  urlStatus.className = 'hint';
  urlStatus.style.marginTop = '4px';
  const syncBtn = button('保存并立即同步', 'btn-outline btn-sm', async (ev) => {
    const urls = setRemoteUrls(urlArea.value.split('\n'));
    urlArea.value = urls.join('\n');
    if (!urls.length) {
      urlStatus.textContent = '已清空远程字体订阅（已安装的远程字体保留在本机，可手动删除）。';
      return;
    }
    const btn = ev.currentTarget;
    btn.disabled = true; // currentTarget 仅在派发期间有效：await 前先捕获按钮引用
    urlStatus.textContent = '正在下载远程字体…';
    const r = await syncRemoteFonts({
      onItem: (rec, err) => {
        urlStatus.textContent = err
          ? `下载失败：${err.url}（${err.error}）`
          : `已安装：${rec.family || rec.name}`;
        if (!err) renderUserFonts();
      },
    });
    btn.disabled = false;
    urlStatus.textContent = `同步完成：新增 ${r.ok} 个 · 更新 ${r.updated} 个${r.failed.length ? ` · 失败 ${r.failed.length} 个（详情见上方提示）` : ''}`;
    await renderUserFonts();
  });
  syncBtn.setAttribute('aria-label', '保存远程字体 URL 并立即同步');
  const urlWrap = document.createElement('div');
  urlWrap.style.marginTop = '10px';
  urlWrap.appendChild(field('远程字体 URL（每次启动自动下载并持久化到本机）', urlArea));
  const urlBtnRow = document.createElement('div');
  urlBtnRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap';
  urlBtnRow.append(syncBtn, urlStatus);
  urlWrap.appendChild(urlBtnRow);
  box.appendChild(urlWrap);

  // ---- 收藏 ----
  box.appendChild(secTitle('收藏'));
  const favRow = document.createElement('div');
  favRow.appendChild(button('恢复默认收藏', 'btn-outline btn-sm', () => {
    resetFavorites();
    toast(`已恢复默认收藏（${defaultFavoriteIds().length} 个核心工具）`);
    box.closest('.modal-mask')?.remove();
    if (location.hash === '#/more') renderApp(null);
    else navigate();
  }));
  const favHint = document.createElement('div');
  favHint.className = 'hint';
  favHint.style.marginTop = '6px';
  favHint.textContent = '撤销全部星标调整，首页恢复为默认收藏的工具';
  favRow.appendChild(favHint);
  box.appendChild(favRow);

  // ---- 运行日志 ----
  box.appendChild(secTitle('运行日志'));
  const logNote = document.createElement('div');
  logNote.className = 'hint';
  logNote.style.marginBottom = '8px';
  logNote.textContent = '引擎调用、加载状态、兜底降级与错误全记录（仅保存在本机，不含文件内容与任何密码）。排查问题时可整段复制发给开发者。';
  box.appendChild(logNote);
  const logToolbar = document.createElement('div');
  logToolbar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
  const logFilter = select([
    { value: 'info', label: '全部级别' },
    { value: 'warn', label: '警告及以上' },
    { value: 'error', label: '仅错误' },
  ], 'info');
  logFilter.setAttribute('aria-label', '日志级别过滤');
  const logCopyBtn = button('复制全部', 'btn-outline btn-sm', async () => {
    try {
      await navigator.clipboard.writeText(logsToText(getLogs({ minLevel: logFilter.value })));
      toast('日志已复制到剪贴板');
    } catch {
      toast('复制失败：浏览器拒绝了剪贴板访问', 'error');
    }
  });
  logCopyBtn.setAttribute('aria-label', '复制全部运行日志');
  const logClearBtn = button('清空日志', 'btn-ghost btn-sm', () => {
    clearLogs();
    toast('已清空');
  });
  logClearBtn.setAttribute('aria-label', '清空运行日志');
  logToolbar.append(logFilter, logCopyBtn, logClearBtn);
  box.appendChild(logToolbar);
  const logList = document.createElement('div');
  logList.className = 'log-list';
  logList.style.cssText = 'max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);padding:8px 10px;background:var(--secondary);font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all';
  logList.setAttribute('role', 'log');
  logList.setAttribute('aria-label', '运行日志内容');
  box.appendChild(logList);
  const renderLogs = () => {
    const list = getLogs({ minLevel: logFilter.value });
    if (!list.length) {
      logList.textContent = '暂无日志';
      return;
    }
    // 最多渲染最近 200 条，防长会话卡顿；自动滚到底
    const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
    logList.textContent = logsToText(list.slice(-200));
    if (atBottom) logList.scrollTop = logList.scrollHeight;
  };
  logFilter.onchange = renderLogs;
  renderLogs();
  const unsubLogs = onLogChange(renderLogs);

  // ---- 维护 ----
  box.appendChild(secTitle('维护'));
  const cacheRow = document.createElement('div');
  cacheRow.appendChild(button('清理引擎缓存', 'btn-outline btn-sm', async (ev) => {
    const btn = ev.currentTarget; // await 后 currentTarget 为 null：先捕获引用
    btn.disabled = true;
    await clearAssetCache();
    toast('已清理 WASM 引擎持久缓存（下次使用对应功能时重新下载）');
    renderCacheInfo();
    btn.disabled = false;
  }));
  cacheRow.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'pandoc / Typst 等扩展引擎包已持久化到本机（Cache Storage），下载一次即可离线复用；清理后需重新下载。' }));
  const cacheInfo = document.createElement('div');
  cacheInfo.className = 'hint';
  cacheInfo.style.marginTop = '4px';
  const renderCacheInfo = async () => {
    const entries = await assetCacheEntries();
    const est = await storageEstimate();
    const total = entries.reduce((s, e) => s + e.size, 0);
    cacheInfo.textContent = `已持久化 ${entries.length} 个引擎包（共 ${fmtBytes(total)}）` +
      (est.quota ? ` · 本源存储已用 ${fmtBytes(est.usage)} / 配额约 ${fmtBytes(est.quota)}` : '');
  };
  renderCacheInfo();
  cacheRow.appendChild(cacheInfo);
  box.appendChild(cacheRow);

  const resetRow = document.createElement('div');
  resetRow.style.marginTop = '10px';
  const resetBtn = button('恢复初始环境', 'btn-outline btn-sm', async () => {
    const ok = await confirmDialog({
      title: '恢复初始环境',
      message: '将清除本机保存的全部应用数据：设置与外观、收藏、暂存区（含文件夹）、历史记录、运行日志与已下载的引擎缓存，然后自动刷新页面。此操作不可撤销。',
      confirmText: '恢复初始环境',
      destructive: true,
    });
    if (!ok) return;
    log('app', '执行一键恢复初始环境');
    // 1) 本应用 localStorage / sessionStorage
    try {
      const rm = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('pdftoolkit.')) rm.push(k);
      }
      rm.forEach((k) => localStorage.removeItem(k));
      sessionStorage.clear();
    } catch { /* 忽略 */ }
    // 2) IndexedDB（历史 + 暂存区 + tesseract 语言包缓存 keyval，按名删除本应用相关库）
    try {
      const names = (await indexedDB.databases?.())?.map((d) => d.name)?.filter((n) => n && (String(n).startsWith('pdftoolkit') || n === 'keyval'))
        || ['pdftoolkit', 'pdftoolkit-tray', 'keyval'];
      await Promise.all(names.map((n) => new Promise((res) => {
        const r = indexedDB.deleteDatabase(n);
        r.onsuccess = r.onerror = r.onblocked = () => res();
      })));
    } catch { /* 忽略 */ }
    // 3) Cache Storage（引擎持久缓存）
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('pdftoolkit')).map((k) => caches.delete(k)));
    } catch { /* 忽略 */ }
    toast('已恢复初始环境，正在刷新…');
    setTimeout(() => location.reload(), 400);
  });
  resetBtn.setAttribute('aria-label', '一键恢复初始环境（清除全部本机数据）');
  resetRow.appendChild(resetBtn);
  resetRow.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '一键清除设置、收藏、暂存区、历史、日志与引擎缓存并刷新——用于排查由后期环境配置引起的异常。' }));
  box.appendChild(resetRow);

  // ---- 关于 ----
  box.appendChild(secTitle('关于'));
  const about = document.createElement('div');
  about.style.cssText = 'border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);padding:14px;background:var(--secondary)';
  const nameRow = document.createElement('div');
  nameRow.className = 'about-row';
  nameRow.innerHTML = `<b>${esc(APP_NAME)}</b><span class="ver-mono">${esc(APP_VERSION_FULL)}</span>`;
  const licRow = document.createElement('div');
  licRow.className = 'about-row';
  licRow.innerHTML = `<span class="muted-sm">开源协议 ${esc(APP_LICENSE)} · 全部处理在本地浏览器完成，文件不上传</span>`;
  const linkRow = document.createElement('div');
  linkRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
  const repoBtn = document.createElement('a');
  repoBtn.className = 'btn btn-outline btn-sm';
  repoBtn.href = APP_REPO;
  repoBtn.target = '_blank';
  repoBtn.rel = 'noopener noreferrer';
  repoBtn.textContent = 'GitHub 仓库';
  const issueBtn = document.createElement('a');
  issueBtn.className = 'btn btn-ghost btn-sm';
  issueBtn.href = APP_REPO_ISSUES;
  issueBtn.target = '_blank';
  issueBtn.rel = 'noopener noreferrer';
  issueBtn.textContent = '问题反馈 (Issues)';
  linkRow.append(repoBtn, issueBtn);
  about.append(nameRow, licRow, linkRow);
  box.appendChild(about);
  // 更新日志：构建期由 vite 插件从 git log 生成 dist/changelog.json（含每次提交的本地时间）
  const logBtn = button('查看更新日志', 'btn-outline btn-sm', null);
  logBtn.setAttribute('aria-label', '查看更新日志');
  const logBox = document.createElement('div');
  logBox.className = 'changelog-box';
  logBox.hidden = true;
  let changelogLoaded = false;
  logBtn.onclick = async () => {
    logBox.hidden = !logBox.hidden;
    if (logBox.hidden || changelogLoaded) return;
    logBox.textContent = '加载更新日志…';
    try {
      const url = new URL('changelog.json', document.baseURI).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      changelogLoaded = true;
      logBox.textContent = '';
      const head = document.createElement('div');
      head.className = 'cl-head';
      head.textContent = `当前构建 v${data.version || APP_VERSION} · ${data.commit || BUILD_COMMIT}` +
        `${data.buildDate ? ` · ${data.buildDate}` : ''} · 共 ${data.commits.length} 次提交`;
      logBox.appendChild(head);
      const list = document.createElement('div');
      list.className = 'changelog-list';
      list.setAttribute('role', 'log');
      list.setAttribute('aria-label', '更新日志内容');
      for (const c of data.commits || []) {
        const rowEl = document.createElement('div');
        rowEl.className = 'cl-row';
        const dateEl = document.createElement('span');
        dateEl.className = 'cl-date';
        dateEl.textContent = c.date;
        const hashEl = document.createElement('span');
        hashEl.className = 'cl-hash ver-mono';
        hashEl.textContent = c.hash;
        const subjEl = document.createElement('span');
        subjEl.className = 'cl-subject';
        subjEl.textContent = c.subject; // textContent：commit 标题不注入 HTML
        rowEl.append(dateEl, hashEl, subjEl);
        list.appendChild(rowEl);
      }
      if (!list.children.length) list.textContent = '构建产物未包含提交记录（可能不在 git 仓库内构建）。';
      logBox.appendChild(list);
    } catch (err) {
      logBox.textContent = `更新日志不可用：${err.message}（更新日志在构建产物中生成，开发模式或缓存缺失时可能不存在）`;
    }
  };
  const clRow = document.createElement('div');
  clRow.style.marginTop = '8px';
  clRow.append(logBtn, logBox);
  box.appendChild(clRow);
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = '设置仅保存在本机浏览器，不会包含任何密码。';
  box.appendChild(note);
  const modal = openModal('设置', box);
  modal.setOnClose(() => { unsubEngines(); unsubLogs(); });
}

// 启动
initShadcn();
applyTheme();
setupEngineRegistry();
hydrateTray(); // 暂存区持久化水合（异步，完成后 UI 自动刷新）
try { if (localStorage.getItem('pdftoolkit.tray.collapsed') === '1') document.body.classList.add('tray-collapsed'); } catch { /* 忽略 */ }
const BOOT_MIN_MS = 700; // 开场动画最短展示时长（首访加载慢时由加载时间自然接管）
const bootT0 = performance.now();
probeFonts().then((r) => {
  fontAvailability = r;
  setLimitsFromSettings();
  navigate();
  setEngineStatus('fonts', r['noto-sc'] ? 'ready' : 'error', r['noto-sc'] ? '已部署 · 中文水印可用' : '未部署（水印功能受限）');
  dismissBootSplash(BOOT_MIN_MS - (performance.now() - bootT0));
});
window.addEventListener('hashchange', navigate);
// 远程外挂字体：启动自动同步（结果进运行日志；失败保留本机已缓存副本，离线可用）
if (getRemoteUrls().length) {
  syncRemoteFonts().then((r) => {
    if (r.ok || r.updated) log('fonts', `远程字体自动同步完成：新增 ${r.ok}、更新 ${r.updated}${r.failed.length ? `、失败 ${r.failed.length}` : ''}`);
  }).catch((e) => log('fonts', '远程字体自动同步失败', { level: 'warn', detail: String(e?.message || e) }));
}
// 全局错误兜底进运行日志（设置面板可查；重复错误折叠由环形缓冲自然承担）
window.addEventListener('error', (e) => {
  log('global', `未捕获错误：${e.message || '未知'}`, { level: 'error', detail: e.filename ? `${e.filename}:${e.lineno}` : '' });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  log('global', `未处理的 Promise 拒绝：${r?.message || String(r ?? '未知')}`, { level: 'error', detail: r?.code || '' });
});
// 跟随系统主题（auto）：系统深浅变化时带过渡切换
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getSettings().theme === 'auto') animateThemeChange(applyTheme);
  });
} catch { /* 旧浏览器无 matchMedia addEventListener */ }
// ⌘K / Ctrl+K 打开全局功能搜索（shadcn Command 风格）
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette({ toggleTheme, openSettings });
  }
});
