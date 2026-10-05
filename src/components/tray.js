// 右侧 PDF 暂存区面板：上传/生成结果自动入架，可拖拽到左侧编辑区选取，
// 列表/封面双视图，单件与一键预览全部。全局单例：跨页面导航共享同一个 DOM 节点。
import { esc, fmtBytes, sanitizeFilename } from '../core/format.js';
import {
  trayItems, trayCount, trayBytes, removeFromTray, clearTray,
  onTrayChange, TRAY_MIME, getTrayItem, isPdf, addPdfsToTray,
} from '../core/tray.js';
import { pickFiles, validateFile } from '../core/files.js';
import { sendToActivePanel } from './input.js';
import { toast, button, openModal, confirmDialog } from './ui.js';
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

/**
 * 直接向暂存区添加文件：只收 PDF（跳过其他类型并提示），过大小上限校验。
 * 与工具页上传镜像共用同一数据入口（addPdfsToTray），同一 File 去重不产生二份。
 */
function uploadToTray(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const pdfs = [];
  let skipped = 0;
  for (const f of list) {
    if (!isPdf(f.name, f.type)) { skipped++; continue; }
    const err = validateFile(f);
    if (err) { toast(err, 'error'); continue; }
    pdfs.push(f);
  }
  const added = addPdfsToTray(pdfs, { source: 'upload' });
  if (added.length && skipped) toast(`已添加 ${added.length} 个 PDF，跳过 ${skipped} 个非 PDF 文件`);
  else if (added.length) toast(`已添加 ${added.length} 个 PDF 到暂存区`);
  else if (skipped === list.length) toast('暂存区只收 PDF 文件', 'error');
}

/** 打开文件选择器（真实 input[file]）并把所选文件加入暂存区 */
async function pickAndAddToTray() {
  uploadToTray(await pickFiles({ multiple: true }));
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
      <button class="btn btn-ghost btn-sm btn-icon tray-fold" data-fold aria-label="收起/展开暂存区"><span class="tray-fold-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></span></button>
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
    foldBtn.querySelector('.tray-fold-ico').style.transform = collapsed ? 'rotate(180deg)' : '';
  }
  syncFold();

  // 移动端抽屉（tray-open）：点击抽屉外任意区域关闭（标准 drawer 行为）
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('tray-open')) return;
    if (el.contains(e.target)) return;
    if (e.target.closest?.('[data-tray-toggle]')) return;
    document.body.classList.remove('tray-open');
  });

  const uploadBtn = button('', 'btn-outline btn-sm', pickAndAddToTray);
  uploadBtn.setAttribute('data-tray-upload', '');
  uploadBtn.setAttribute('aria-label', '上传 PDF 到暂存区');
  uploadBtn.title = '选择 PDF 加入暂存区（也可把文件拖到此面板）';
  uploadBtn.appendChild(iconNode('upload'));
  const uploadLbl = document.createElement('span');
  uploadLbl.className = 'btn-label';
  uploadLbl.textContent = '上传';
  uploadBtn.appendChild(uploadLbl);

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
  tools.append(uploadBtn, previewAllBtn, addAllBtn, viewWrap);

  // 外部文件拖入面板直接入架；内部暂存项拖动（TRAY_MIME）不响应
  let extDragDepth = 0;
  const hasExtFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => {
    if (!hasExtFiles(e)) return;
    e.preventDefault();
    extDragDepth++;
    el.classList.add('tray-drag');
  });
  el.addEventListener('dragover', (e) => { if (hasExtFiles(e)) e.preventDefault(); });
  el.addEventListener('dragleave', () => {
    extDragDepth = Math.max(0, extDragDepth - 1);
    if (!extDragDepth) el.classList.remove('tray-drag');
  });
  el.addEventListener('drop', (e) => {
    extDragDepth = 0;
    el.classList.remove('tray-drag');
    if (!hasExtFiles(e)) return;
    e.preventDefault();
    uploadToTray([...(e.dataTransfer?.files || [])]);
  });

  const clearBtn = button('清空', 'btn-ghost btn-sm', async () => {
    if (!trayCount()) return;
    const ok = await confirmDialog({
      title: '清空暂存区',
      message: `确定清空暂存区的 ${trayCount()} 个文件？（不影响已下载或已保存的文件）`,
      confirmText: '清空',
      destructive: true,
    });
    if (!ok) return;
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
    // 空架时预览/加入无意义，置灰引导上传
    previewAllBtn.disabled = !items.length;
    addAllBtn.disabled = !items.length;
    coverIO?.disconnect();
    coverIO = null;
    body.innerHTML = '';
    if (!items.length) {
      body.innerHTML = `
        <div class="tray-empty" role="button" tabindex="0" aria-label="上传 PDF 到暂存区" data-tray-empty>
          <span class="tray-empty-ico" data-ico></span>
          暂无暂存文件
          <span class="muted-sm">点击选择 PDF，或把文件拖到这里；工具页上传 / 生成的 PDF 也会自动出现在这里</span>
        </div>`;
      body.querySelector('[data-ico]').appendChild(iconNode('tray'));
      const dz = body.querySelector('[data-tray-empty]');
      dz.onclick = pickAndAddToTray;
      dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndAddToTray(); } };
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
  toggleBtn.setAttribute('aria-label', 'PDF 暂存区');
  toggleBtn.setAttribute('data-tray-toggle', '');
  const sync = () => {
    toggleBtn.innerHTML = '';
    toggleBtn.appendChild(iconNode('tray'));
    const label = document.createElement('span');
    label.className = 'btn-label';
    label.textContent = '暂存区';
    toggleBtn.appendChild(label);
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
