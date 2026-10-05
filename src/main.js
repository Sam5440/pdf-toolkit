// 应用主入口：布局、路由、主题、历史/设置入口
import './styles/tokens.css';
import './styles/components.css';
import './styles/workspace.css';

import { TOOLS, GROUPS, getTool } from './tools/registry.js';
import { esc, fmtTime2, fmtBytes } from './core/format.js';
import { toast, openModal, confirmDialog, button, field, favStar, checkbox, select, numberInput } from './components/ui.js';
import { initShadcn } from './components/shadcn.js';
import { openCommandPalette, commandPaletteButton, githubButton } from './components/search.js';
import { APP_NAME, APP_VERSION_FULL, APP_REPO, APP_REPO_ISSUES, APP_LICENSE } from './core/version.js';
import { iconNode } from './components/icons.js';
import { getSettings, setSetting } from './core/settings.js';
import { listHistory, getHistory, deleteHistory, clearHistory, historyUsedBytes } from './core/history.js';
import { probeFonts } from './core/fonts.js';
import { setLimitsFromSettings } from './core/limits.js';
import { isMoreGroup, getFavorites, resetFavorites, defaultFavoriteIds } from './core/favorites.js';
import { trayRail, trayToggleButton } from './components/tray.js';
import { engineList, onEngines, probeEngine, setEngineStatus } from './core/wasm-registry.js';
import { setupEngineRegistry } from './core/wasm-probes.js';

const app = document.getElementById('app');

let fontAvailability = {};

function applyTheme() {
  const s = getSettings();
  const dark = s.theme === 'dark' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.accent = s.accent || 'neutral';
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

function appendSection(content, name, items, countNote) {
  const head = document.createElement('div');
  head.className = 'home-sec';
  head.innerHTML = `<h2>${esc(name)}</h2>` + (countNote ? `<span class="muted-sm">${esc(countNote)}</span>` : '');
  content.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'tool-grid';
  items.forEach((t, i) => {
    const card = toolCard(t);
    card.style.setProperty('--stagger-i', Math.min(i, 12)); // 入场交错（CSS card-in）；封顶防长列表拖尾
    grid.appendChild(card);
  });
  content.appendChild(grid);
}

/** 首页：只显示已收藏的工具，按功能分类分区（收藏 = 是否在首页显示的唯一开关） */
function renderHome(content) {
  const hero = document.createElement('div');
  hero.className = 'card';
  hero.style.marginBottom = '16px';
  hero.innerHTML = `
    <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
      <div class="hero-ico" data-hero-ico></div>
      <div>
        <b style="font-size:15px">全部处理在您的浏览器内完成</b>
        <div class="note" style="margin-top:4px">文件不会发送到任何服务器：选择文件后，压缩、合并、水印、OCR 等全部通过 WASM 在本机浏览器中执行，可离线内网使用。点击卡片右上角的 ☆ 可调整首页显示。</div>
      </div>
    </div>`;
  hero.querySelector('[data-hero-ico]').appendChild(iconNode('security'));
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
    empty.innerHTML = '<div class="card-body"><div class="empty"><span class="empty-ico"></span>还没有收藏的工具<br>去「更多工具页」发现功能，点击卡片右上角的 ★ 收藏到首页</div></div>';
    empty.querySelector('.empty-ico').appendChild(iconNode('more-grid'));
    const goBtn = button('进入更多工具页', 'btn-outline btn-sm', () => { location.hash = '#/more'; });
    empty.querySelector('.empty').appendChild(goBtn);
    content.appendChild(empty);
    return;
  }
  for (const s of sections) appendSection(content, s.g.name, s.items, `${s.items.length} 个工具`);

  const moreCount = TOOLS.filter((t) => isMoreGroup(t.group)).length;
  if (moreCount) {
    const wrap = document.createElement('div');
    wrap.className = 'home-more-link';
    const a = document.createElement('a');
    a.href = '#/more';
    a.className = 'btn btn-outline';
    a.textContent = `更多工具页（${moreCount} 个扩展功能）`;
    wrap.appendChild(a);
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = '全部扩展功能按类别分组，收藏后显示在首页';
    wrap.appendChild(note);
    content.appendChild(wrap);
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
      <div>
        <b style="font-size:15px">更多工具</b>
        <div class="note" style="margin-top:4px">扩展功能按类别分组（默认不收藏）。点击卡片右上角的 ★ 收藏后即显示在首页，再次点击取消收藏；下方同时列出核心工具，方便随时调整。所有处理仍在本地浏览器完成。</div>
      </div>
    </div>`;
  head.querySelector('[data-hero-ico]').appendChild(iconNode('more-grid'));
  content.appendChild(head);

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
        content.appendChild(div);
      }
    }
    appendSection(content, g.name, items, g.hiddenOnHome ? `${items.length} 个工具 · 默认不在首页` : `${items.length} 个工具`);
    shown += items.length;
  }
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

function openSettings() {
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
  box.appendChild(field('OCR 识别 DPI', (() => { const i = numberInput(s.ocrDpi); i.min = 96; i.max = 300; i.step = 8; i.onchange = () => setSetting('ocrDpi', +i.value || 200); return i; })(), '越高识别越准、越慢'));

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
      row.append(dot, info, right);
      engineListEl.appendChild(row);
    }
  };
  renderEngines();
  const unsubEngines = onEngines(renderEngines);

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
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = '设置仅保存在本机浏览器，不会包含任何密码。';
  box.appendChild(note);
  const modal = openModal('设置', box);
  modal.setOnClose(unsubEngines);
}

// 启动
initShadcn();
applyTheme();
setupEngineRegistry();
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
