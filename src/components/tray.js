// 右侧 PDF 暂存区面板：上传/生成结果自动入架，可拖拽到左侧编辑区选取，
// 列表/封面双视图，单件与一键预览全部。全局单例：跨页面导航共享同一个 DOM 节点。
import { esc, fmtBytes, sanitizeFilename } from '../core/format.js';
import {
  trayItems, trayCount, trayBytes, removeFromTray, clearTray,
  onTrayChange, TRAY_MIME, getTrayItem,
} from '../core/tray.js';
import { sendToActivePanel } from './input.js';
import { toast, button, openModal } from './ui.js';
import { iconNode } from './icons.js';
import { downloadArtifact } from '../core/download.js';
import { ensureDoc, run } from '../core/engine.js';

const COLLAPSE_KEY = 'pdftoolkit.tray.collapsed';
const VIEW_KEY = 'pdftoolkit.tray.view';
const PREVIEW_DPI = 64;
const COVER_DPI = 40;

// 封面缓存：`${id}:${size}` → {dataUrl, w, h}（模块级，跨导航复用）
const coverCache = new Map();
// 页数缓存：id → 页数
const pageCache = new Map();

/** 引擎用的伪文档（file 在内存中，doc.open 走同一个 worker 池） */
function pseudoDoc(item) {
  return { id: `traydoc_${item.id}`, name: item.name, size: item.size, file: item.file };
}

/** 确保拿到页数（缓存），失败返回 null */
async function pageCountOf(item) {
  if (pageCache.has(item.id)) return pageCache.get(item.id);
  try {
    const info = await ensureDoc(pseudoDoc(item));
    pageCache.set(item.id, info.pageCount);
    return info.pageCount;
  } catch {
    return null;
  }
}

/** 渲染某页为 canvas（失败抛错） */
async function renderPage(item, page, dpi) {
  const r = await run('doc.render', { docId: pseudoDoc(item).id, page, dpi, bg: '#ffffff' }, {}, new Map([[pseudoDoc(item).id, pseudoDoc(item)]]));
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
  r.bitmap.close?.();
  return canvas;
}

// ---- 封面懒加载（封面视图） ----
let coverIO = null;

function observeCover(card, item) {
  if (!coverIO) {
    coverIO = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        coverIO.unobserve(en.target);
        drawCover(en.target._trayItem, en.target);
      }
    }, { rootMargin: '260px' });
  }
  card._trayItem = item;
  coverIO.observe(card);
}

async function drawCover(item, holder) {
  const key = `${item.id}:${item.size}`;
  const cached = coverCache.get(key);
  if (cached) return paintCover(holder, cached);
  try {
    const canvas = await renderPage(item, 0, COVER_DPI);
    const data = { dataUrl: canvas.toDataURL('image/webp', 0.8), w: canvas.width, h: canvas.height };
    coverCache.set(key, data);
    pageCountOf(item).then(() => refreshIfVisible(item));
    paintCover(holder, data);
  } catch {
    holder.innerHTML = '';
    const ico = document.createElement('span');
    ico.className = 'tray-cover-fallback';
    ico.appendChild(iconNode('doc'));
    holder.appendChild(ico);
  }
}

function paintCover(holder, data) {
  holder.innerHTML = '';
  const img = document.createElement('img');
  img.src = data.dataUrl;
  img.alt = '';
  img.draggable = false;
  holder.appendChild(img);
}

/** 封面就绪后如果该卡片当前可见则刷新一次（补页数徽标） */
function refreshIfVisible(item) {
  if (!railEl || document.body.contains(railEl) === false) return;
  const badge = railEl.querySelector(`[data-tray-pages="${item.id}"]`);
  if (badge && pageCache.has(item.id)) badge.textContent = `${pageCache.get(item.id)} 页`;
}

// ---- 预览（单件 / 一键全部） ----
export function openTrayPreview(items, startIndex = 0) {
  if (!items.length) { toast('暂存区还没有 PDF', 'error'); return; }
  let cur = Math.max(0, Math.min(items.length - 1, startIndex));
  let token = 0;
  let pagesIO = null;

  const wrap = document.createElement('div');
  wrap.className = 'pv-wrap';
  wrap.innerHTML = `
    <div class="pv-side" data-pv-side></div>
    <div class="pv-main" data-pv-main></div>`;
  const side = wrap.querySelector('[data-pv-side]');
  const main = wrap.querySelector('[data-pv-main]');

  const box = openModal('', wrap);
  box.box.classList.add('modal-wide');
  const headTitle = box.box.querySelector('.modal-head > div');
  const close = () => { pagesIO?.disconnect(); box.close(); };

  function renderSide() {
    side.innerHTML = '';
    items.forEach((it, i) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'pv-doc' + (i === cur ? ' active' : '');
      d.setAttribute('data-pv-doc', it.id);
      d.innerHTML = `
        <span class="pv-doc-thumb" data-thumb></span>
        <span class="pv-doc-info">
          <span class="pv-doc-name" title="${esc(it.name)}">${esc(it.name)}</span>
          <span class="muted-sm">${fmtBytes(it.size)}${pageCache.has(it.id) ? ` · ${pageCache.get(it.id)} 页` : ''}</span>
        </span>`;
      d.querySelector('[data-thumb]').appendChild(iconNode('doc'));
      d.onclick = () => { if (i !== cur) { cur = i; renderSide(); renderMain(); } };
      side.appendChild(d);
      observeCover(d.querySelector('[data-thumb]'), it);
    });
  }

  async function renderMain() {
    const my = ++token;
    const it = items[cur];
    headTitle.textContent = `预览 ${cur + 1}/${items.length} · ${it.name}`;
    main.querySelectorAll('.pv-page').forEach((s) => pagesIO?.unobserve(s));
    main.innerHTML = '<div class="pv-loading"><span class="spinner"></span>正在打开…</div>';
    const pages = await pageCountOf(it);
    if (my !== token) return;
    if (!pages) {
      main.innerHTML = '<div class="pv-loading">无法打开该文件（可能已损坏或不是有效 PDF）</div>';
      return;
    }
    main.innerHTML = '';
    for (let p = 0; p < pages; p++) {
      const slot = document.createElement('div');
      slot.className = 'pv-page';
      slot.innerHTML = `<div class="pv-page-no">第 ${p + 1} / ${pages} 页</div><div class="pv-page-canvas"><span class="spinner"></span></div>`;
      slot._page = p;
      main.appendChild(slot);
    }
    if (!pagesIO) {
      pagesIO = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          pagesIO.unobserve(en.target);
          drawPreviewPage(en.target);
        }
      }, { root: main, rootMargin: '420px' });
    }
    main.querySelectorAll('.pv-page').forEach((s) => pagesIO.observe(s));
    const active = side.querySelector('.pv-doc.active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  async function drawPreviewPage(slot) {
    const my = token;
    const it = items[cur];
    const holder = slot.querySelector('.pv-page-canvas');
    try {
      const canvas = await renderPage(it, slot._page, PREVIEW_DPI);
      if (my !== token) return;
      holder.innerHTML = '';
      canvas.className = 'pv-canvas';
      holder.appendChild(canvas);
    } catch {
      if (my === token) { holder.innerHTML = '<span class="pv-page-err">渲染失败</span>'; }
    }
  }

  renderSide();
  renderMain();
  box.setOnClose(() => pagesIO?.disconnect());
  return { close };
}

// ---- 面板本体（全局单例） ----
let railEl = null;
let viewMode = null;

function readView() {
  if (viewMode) return viewMode;
  try { viewMode = localStorage.getItem(VIEW_KEY) === 'cover' ? 'cover' : 'list'; } catch { viewMode = 'list'; }
  return viewMode;
}

function sourceBadge(source) {
  return source === 'result' ? '<span class="badge badge-primary">生成</span>' : '<span class="badge badge-muted">上传</span>';
}

function buildRail() {
  const el = document.createElement('aside');
  el.className = 'tray-rail';
  el.setAttribute('aria-label', 'PDF 暂存区');
  el.innerHTML = `
    <div class="tray-head">
      <span class="tray-ico" data-ico></span>
      <span class="tray-title">PDF 暂存区</span>
      <span class="badge badge-primary" data-count>0</span>
      <button class="btn btn-ghost btn-sm tray-fold" data-fold aria-label="收起/展开暂存区">›</button>
    </div>
    <div class="tray-tools" data-tools></div>
    <div class="tray-body" data-body></div>
    <div class="tray-foot" data-foot></div>`;
  el.querySelector('[data-ico]').appendChild(iconNode('tray'));
  const body = el.querySelector('[data-body]');
  const tools = el.querySelector('[data-tools]');
  const foot = el.querySelector('[data-foot]');
  const countEl = el.querySelector('[data-count]');

  const foldBtn = el.querySelector('[data-fold]');
  foldBtn.onclick = () => {
    if (matchMedia('(max-width: 1020px)').matches) {
      document.body.classList.remove('tray-open');
    } else {
      const collapsed = document.body.classList.toggle('tray-collapsed');
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : ''); } catch { /* 忽略 */ }
      syncFold();
    }
  };
  function syncFold() {
    const collapsed = document.body.classList.contains('tray-collapsed');
    foldBtn.textContent = collapsed ? '‹' : '›';
  }
  syncFold();

  const previewAllBtn = button('预览全部', 'btn-primary btn-sm', () => {
    const items = trayItems();
    if (!items.length) { toast('暂存区还没有 PDF', 'error'); return; }
    openTrayPreview(items, 0);
  });
  previewAllBtn.setAttribute('data-tray-preview-all', '');
  previewAllBtn.setAttribute('aria-label', '一键预览暂存区全部 PDF');
  const addAllBtn = button('全部加入', 'btn-outline btn-sm', () => {
    const items = trayItems();
    if (!items.length) { toast('暂存区还没有 PDF', 'error'); return; }
    if (sendToActivePanel(items.map((i) => i.file))) toast(`已加入 ${items.length} 个文件到左侧编辑区`);
    else toast('请先进入一个工具页，再从暂存区选取文件', 'error');
  });
  addAllBtn.setAttribute('data-tray-add-all', '');
  addAllBtn.setAttribute('aria-label', '把暂存区全部文件加入编辑区');
  const listBtn = button('列表', 'btn-ghost btn-sm', () => setView('list'));
  const coverBtn = button('封面', 'btn-ghost btn-sm', () => setView('cover'));
  listBtn.setAttribute('data-tray-view', 'list');
  coverBtn.setAttribute('data-tray-view', 'cover');
  const viewWrap = document.createElement('div');
  viewWrap.className = 'tray-view-toggle';
  viewWrap.append(listBtn, coverBtn);
  tools.append(previewAllBtn, addAllBtn, viewWrap);

  const clearBtn = button('清空', 'btn-ghost btn-sm', async () => {
    if (!trayCount()) return;
    if (!confirm(`确定清空暂存区的 ${trayCount()} 个文件？（不影响已下载或已保存的文件）`)) return;
    clearTray();
  });
  // 带上下文的 accessible name：可见文字保持简短，且不与工具页自身的「下载/清空」按钮混淆
  clearBtn.setAttribute('aria-label', '移除暂存区全部文件');
  foot.innerHTML = '<span class="muted-sm" data-size></span>';
  foot.querySelector('[data-size]').after(clearBtn);

  function setView(v) {
    viewMode = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* 忽略 */ }
    listBtn.classList.toggle('active', v === 'list');
    coverBtn.classList.toggle('active', v === 'cover');
    renderBody();
  }

  function renderBody() {
    const items = trayItems();
    countEl.textContent = String(items.length);
    foot.querySelector('[data-size]').textContent = items.length ? `共 ${items.length} 个 · ${fmtBytes(trayBytes())}` : '';
    coverIO?.disconnect();
    coverIO = null;
    body.innerHTML = '';
    if (!items.length) {
      body.innerHTML = `
        <div class="tray-empty">
          <span class="tray-empty-ico" data-ico></span>
          暂无暂存文件
          <span class="muted-sm">上传或生成的 PDF 会自动出现在这里，可拖到左侧编辑区继续处理</span>
        </div>`;
      body.querySelector('[data-ico]').appendChild(iconNode('tray'));
      return;
    }
    if (readView() === 'cover') {
      const grid = document.createElement('div');
      grid.className = 'tray-grid';
      for (const it of items) grid.appendChild(coverCard(it));
      body.appendChild(grid);
      grid.querySelectorAll('.tray-card').forEach((c) => observeCover(c.querySelector('.tray-cover'), c._trayItem));
    } else {
      const list = document.createElement('div');
      list.className = 'tray-list';
      for (const it of items) list.appendChild(listRow(it));
      body.appendChild(list);
    }
  }

  function dragStart(e, item) {
    e.dataTransfer.setData(TRAY_MIME, item.id);
    e.dataTransfer.setData('text/plain', item.name);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.target.closest('[data-tray-item]')?.classList.add('dragging');
  }
  function dragEnd(e) {
    e.target.closest('[data-tray-item]')?.classList.remove('dragging');
  }

  function itemActions(it) {
    const wrap = document.createElement('div');
    wrap.className = 'tray-actions';
    const addBtn = button('加入', 'btn-outline btn-xs', () => {
      if (sendToActivePanel([it.file])) toast(`已把「${sanitizeFilename(it.name)}」加入左侧编辑区`);
      else toast('请先进入一个工具页，再从暂存区选取文件', 'error');
    });
    addBtn.title = '加入左侧编辑区（也可直接拖动）';
    addBtn.setAttribute('aria-label', `把 ${it.name} 加入编辑区`);
    const dlBtn = button('下载', 'btn-ghost btn-xs', async () => {
      downloadArtifact({ name: it.name, mime: it.mime || 'application/pdf', bytes: it.file });
    });
    dlBtn.setAttribute('aria-label', `下载暂存文件 ${it.name}`);
    const rmBtn = button('✕', 'btn-ghost btn-xs tray-rm', () => removeFromTray(it.id));
    rmBtn.title = '从暂存区移除';
    rmBtn.setAttribute('aria-label', `移除 ${it.name}`);
    wrap.append(addBtn, dlBtn, rmBtn);
    return wrap;
  }

  function listRow(it) {
    const row = document.createElement('div');
    row.className = 'tray-item';
    row.draggable = true;
    row.setAttribute('data-tray-item', it.id);
    row.innerHTML = `
      <span class="ti-ico" data-ico></span>
      <div class="ti-info">
        <div class="ti-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="ti-meta muted-sm">${fmtBytes(it.size)}${pageCache.has(it.id) ? ` · ${pageCache.get(it.id)} 页` : ''} ${sourceBadge(it.source)}</div>
      </div>`;
    row.querySelector('[data-ico]').appendChild(iconNode('doc'));
    row.appendChild(itemActions(it));
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      openTrayPreview(trayItems(), trayItems().findIndex((x) => x.id === it.id));
    };
    row.addEventListener('dragstart', (e) => dragStart(e, it));
    row.addEventListener('dragend', dragEnd);
    return row;
  }

  function coverCard(it) {
    const card = document.createElement('div');
    card.className = 'tray-card';
    card.draggable = true;
    card.setAttribute('data-tray-item', it.id);
    card._trayItem = it;
    card.innerHTML = `
      <div class="tray-cover"><span class="spinner"></span></div>
      <div class="tray-card-name" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="tray-card-meta muted-sm"><span data-tray-pages="${it.id}">${pageCache.has(it.id) ? `${pageCache.get(it.id)} 页` : fmtBytes(it.size)}</span> ${sourceBadge(it.source)}</div>`;
    const acts = itemActions(it);
    acts.classList.add('tray-card-actions');
    card.appendChild(acts);
    card.onclick = (e) => {
      if (e.target.closest('button')) return;
      openTrayPreview(trayItems(), trayItems().findIndex((x) => x.id === it.id));
    };
    card.addEventListener('dragstart', (e) => dragStart(e, it));
    card.addEventListener('dragend', dragEnd);
    return card;
  }

  onTrayChange(renderBody);
  setView(readView());
  return el;
}

/** 顶栏暂存区开关按钮（全局单例，带数量徽标） */
let toggleBtn = null;
export function trayToggleButton() {
  if (toggleBtn) return toggleBtn;
  toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn btn-ghost btn-sm tray-toggle';
  toggleBtn.type = 'button';
  toggleBtn.title = 'PDF 暂存区';
  toggleBtn.setAttribute('data-tray-toggle', '');
  const sync = () => {
    toggleBtn.innerHTML = '';
    toggleBtn.appendChild(iconNode('tray'));
    toggleBtn.appendChild(document.createTextNode(' 暂存区'));
    const n = trayCount();
    if (n) {
      const b = document.createElement('span');
      b.className = 'badge badge-primary tray-toggle-n';
      b.textContent = String(n);
      toggleBtn.appendChild(b);
    }
  };
  toggleBtn.onclick = () => {
    if (matchMedia('(max-width: 1020px)').matches) document.body.classList.toggle('tray-open');
    else document.body.classList.toggle('tray-collapsed');
  };
  onTrayChange(sync);
  sync();
  return toggleBtn;
}

/** 挂载点：main.js 每次渲染调用，拿同一个节点塞回新布局 */
export function trayRail() {
  if (!railEl) railEl = buildRail();
  return railEl;
}
