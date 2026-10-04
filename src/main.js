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

function toggleTheme() {
  setSetting('theme', isDarkTheme() ? 'light' : 'dark');
  applyTheme();
}

function navigate() {
  const hash = location.hash || '#/';
  const m = /^#\/tool\/([\w-]+)$/.exec(hash);
  renderApp(m ? m[1] : null);
}

/** 侧边栏：核心分组逐组列出；hiddenOnHome 分组统一收进「更多」区（专项页链接 + 全部工具） */
function buildSidebar(sidebar, toolId) {
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

  // 侧边栏
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="side-brand"><div class="logo">PDF</div><span class="brand-text">万能工具箱</span></div>`;
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
  tbBtns.style.cssText = 'display:flex;gap:6px;align-items:center';
  const iconBtn = (id, label, cls, onClick) => {
    const b = button('', cls, onClick);
    b.appendChild(iconNode(id));
    b.appendChild(document.createTextNode(label));
    return b;
  };
  const themeBtn = iconBtn(getSettings().theme === 'dark' ? 'theme-sun' : 'theme-moon', getSettings().theme === 'dark' ? ' 浅色' : ' 深色', 'btn-ghost btn-sm', () => {
    toggleTheme();
    navigate();
  });
  const searchCtx = { toggleTheme, openSettings };
  const searchBtn = commandPaletteButton(searchCtx);
  const ghBtn = githubButton();
  const histBtn = iconBtn('history', ' 历史', 'btn-ghost btn-sm', () => { location.hash = '#/history'; });
  const setBtn = iconBtn('settings', ' 设置', 'btn-ghost btn-sm', () => openSettings());
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
  for (const t of items) grid.appendChild(toolCard(t));
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
    sel.onchange = () => { setSetting('theme', sel.value); applyTheme(); };
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
      setSetting('accent', a.id);
      accentRow.querySelectorAll('.accent-swatch').forEach((x) => x.removeAttribute('data-selected'));
      sw.setAttribute('data-selected', '');
      applyTheme();
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
  openModal('设置', box);
}

// 启动
initShadcn();
applyTheme();
try { if (localStorage.getItem('pdftoolkit.tray.collapsed') === '1') document.body.classList.add('tray-collapsed'); } catch { /* 忽略 */ }
probeFonts().then((r) => { fontAvailability = r; setLimitsFromSettings(); navigate(); });
window.addEventListener('hashchange', navigate);
// ⌘K / Ctrl+K 打开全局功能搜索（shadcn Command 风格）
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette({ toggleTheme, openSettings });
  }
});
