// 应用主入口：布局、路由、主题、历史/设置入口
import './styles/tokens.css';
import './styles/components.css';
import './styles/workspace.css';

import { TOOLS, GROUPS, getTool } from './tools/registry.js';
import { esc, fmtTime2, fmtBytes } from './core/format.js';
import { toast, openModal, button, field } from './components/ui.js';
import { iconNode } from './components/icons.js';
import { getSettings, setSetting } from './core/settings.js';
import { listHistory, getHistory, deleteHistory, clearHistory, historyUsedBytes } from './core/history.js';
import { probeFonts } from './core/fonts.js';
import { setLimitsFromSettings } from './core/limits.js';

const app = document.getElementById('app');

let fontAvailability = {};

function applyTheme() {
  const t = getSettings().theme;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

function navigate() {
  const hash = location.hash || '#/';
  const m = /^#\/tool\/([\w-]+)$/.exec(hash);
  renderApp(m ? m[1] : null);
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
  for (const g of GROUPS) {
    const items = TOOLS.filter((t) => t.group === g.id);
    if (!items.length) continue;
    const gh = document.createElement('div');
    gh.className = 'side-group';
    gh.textContent = g.name;
    sidebar.appendChild(gh);
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
  }
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
    <div class="tb-title">${tool ? `<span class="tb-ico"></span>${esc(tool.name)}<span class="tb-sub">${esc(tool.desc)}</span>` : 'PDF 万能工具箱'} </div>`;
  if (tool) topbar.querySelector('.tb-ico').appendChild(iconNode(tool.id));
  const tbBtns = document.createElement('div');
  tbBtns.style.cssText = 'display:flex;gap:6px';
  const iconBtn = (id, label, cls, onClick) => {
    const b = button('', cls, onClick);
    b.appendChild(iconNode(id));
    b.appendChild(document.createTextNode(label));
    return b;
  };
  const themeBtn = iconBtn(getSettings().theme === 'dark' ? 'theme-sun' : 'theme-moon', getSettings().theme === 'dark' ? ' 浅色' : ' 深色', 'btn-ghost btn-sm', () => {
    setSetting('theme', getSettings().theme === 'dark' ? 'light' : 'dark');
    applyTheme();
    navigate();
  });
  const histBtn = iconBtn('history', ' 历史', 'btn-ghost btn-sm', () => { location.hash = '#/history'; });
  const setBtn = iconBtn('settings', ' 设置', 'btn-ghost btn-sm', () => openSettings());
  tbBtns.append(themeBtn, histBtn, setBtn);
  topbar.appendChild(tbBtns);

  const content = document.createElement('div');
  content.className = 'content';

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
  } else {
    renderHome(content);
  }

  main.append(topbar, content);
  shell.append(sidebar, main);
  app.appendChild(shell);
  fontOkEl.textContent = fontAvailability['noto-sc'] ? '中文水印已就绪' : '需部署字体包';
}

function renderHome(content) {
  const hero = document.createElement('div');
  hero.className = 'card';
  hero.style.marginBottom = '16px';
  hero.innerHTML = `
    <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
      <div class="hero-ico" data-hero-ico></div>
      <div>
        <b style="font-size:15px">全部处理在您的浏览器内完成</b>
        <div class="note" style="margin-top:4px">文件不会发送到任何服务器：选择文件后，压缩、合并、水印、OCR 等全部通过 WASM 在本机浏览器中执行，可离线内网使用。</div>
      </div>
    </div>`;
  hero.querySelector('[data-hero-ico]').appendChild(iconNode('security'));
  content.appendChild(hero);
  const grid = document.createElement('div');
  grid.className = 'tool-grid';
  for (const t of TOOLS) {
    const c = document.createElement('a');
    c.className = 'tool-card';
    c.href = `#/tool/${t.id}`;
    c.innerHTML = `
      <div class="tc-ico"></div>
      <div class="tc-name">${esc(t.name)}</div>
      <div class="tc-desc">${esc(t.desc)}</div>`;
    c.querySelector('.tc-ico').appendChild(iconNode(t.id));
    grid.appendChild(c);
  }
  content.appendChild(grid);
}

async function renderHistory(content) {
  content.innerHTML = '<div class="card"><div class="card-body"><div class="empty"><span class="spinner"></span>加载历史中…</div></div></div>';
  const [items, used] = await Promise.all([listHistory({ limit: 200 }), historyUsedBytes()]);
  content.innerHTML = '';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
  head.innerHTML = `<b>本地历史记录</b><span class="muted-sm">占用 ${fmtBytes(used)}</span>`;
  const clearBtn = button('清空全部', 'btn-danger btn-sm', async () => {
    if (!confirm('确定清空全部本地历史记录？此操作不可恢复。')) return;
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

function openSettings() {
  const s = getSettings();
  const box = document.createElement('div');
  const rows = [
    field('主题', (() => {
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="light">浅色</option><option value="dark">深色</option><option value="auto">跟随系统</option>';
      sel.value = s.theme;
      sel.onchange = () => { setSetting('theme', sel.value); applyTheme(); };
      return sel;
    })()),
    field('单文件大小上限（MB）', (() => { const i = document.createElement('input'); i.type = 'number'; i.value = s.maxUploadMB; i.min = 1; i.max = 2048; i.onchange = () => setSetting('maxUploadMB', +i.value || 500); return i; })()),
    field('历史保留配额（MB）', (() => { const i = document.createElement('input'); i.type = 'number'; i.value = s.historyQuotaMB; i.min = 50; i.max = 10240; i.onchange = () => setSetting('historyQuotaMB', +i.value || 500); return i; })()),
    field('OCR 识别 DPI', (() => { const i = document.createElement('input'); i.type = 'number'; i.value = s.ocrDpi; i.min = 96; i.max = 300; i.step = 8; i.onchange = () => setSetting('ocrDpi', +i.value || 200); return i; })(), '越高识别越准、越慢'),
  ];
  rows.forEach((r) => box.appendChild(r));
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = '设置仅保存在本机浏览器，不会包含任何密码。';
  box.appendChild(note);
  openModal('设置', box);
}

// 启动
applyTheme();
probeFonts().then((r) => { fontAvailability = r; setLimitsFromSettings(); navigate(); });
window.addEventListener('hashchange', navigate);
