// 页面缩略图工作台：懒加载缩略图、多选、拖拽重排、旋转/删除/复制等操作
// 被 合并/拆分/整理/编辑 等工具共享。页面项 {key, docId, docName, srcPage, rotationDelta, blank?}
import { iconNode } from './icons.js';
import { esc } from '../core/format.js';
import { run } from '../core/engine.js';
import { getDocument } from '../core/files.js';
import { toast } from './ui.js';

export function pageWorkbench({ docs = () => [], onChange = () => {}, readonly = false } = {}) {
  const state = {
    pages: [],            // [{key, docId, docName, srcPage, rotationDelta, blank}]
    selected: new Set(),  // key
    undo: [], redo: [],
  };

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-ws" data-ws></div>
    <div class="note" data-count style="margin-top:8px"></div>`;
  const ws = el.querySelector('[data-ws]');
  const countEl = el.querySelector('[data-count]');

  const thumbs = new Map(); // key → rendered

  // ---- 懒加载渲染：IntersectionObserver ----
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const card = en.target;
      io.unobserve(card);
      renderThumb(card._item, card);
    }
  }, { root: null, rootMargin: '300px' });

  async function renderThumb(item, card) {
    if (thumbs.has(item.key)) {
      attachThumb(card, thumbs.get(item.key));
      return;
    }
    if (item.blank) {
      const d = document.createElement('div');
      d.style.cssText = 'width:100%;height:100%;background:#fff;border:1px dashed var(--border-strong);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px';
      d.textContent = '空白页';
      attachThumb(card, d);
      return;
    }
    try {
      const r = await run('doc.render', { docId: item.docId, page: item.srcPage, dpi: 40, bg: '#ffffff' }, {}, docsMap());
      const canvas = document.createElement('canvas');
      canvas.width = r.width; canvas.height = r.height;
      canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
      r.bitmap.close();
      thumbs.set(item.key, canvas);
      attachThumb(card, canvas);
    } catch (e) {
      const d = document.createElement('div');
      d.textContent = '渲染失败';
      d.style.cssText = 'color:var(--no);font-size:11px';
      attachThumb(card, d);
    }
  }

  function docsMap() {
    const m = new Map();
    for (const d of docs()) m.set(d.id, d);
    return m;
  }

  function attachThumb(card, node) {
    const holder = card.querySelector('.thumb');
    if (!holder || holder.contains(node)) return;
    holder.innerHTML = '';
    const item = card._item;
    if (item.rotationDelta) {
      node.style.transform = `rotate(${item.rotationDelta}deg)`;
      node.style.maxWidth = item.rotationDelta % 180 ? '70%' : '100%';
      node.style.maxHeight = '100%';
    }
    holder.appendChild(node);
  }

  function render() {
    ws.innerHTML = '';
    for (const item of state.pages) {
      const card = document.createElement('div');
      card.className = 'page-card' + (state.selected.has(item.key) ? ' selected' : '');
      card.draggable = !readonly;
      card._item = item;
      card.innerHTML = `
        <div class="thumb"></div>
        <span class="sel-check">✓</span>
        <span class="page-no">${esc(item.docName ? `${item.docName.slice(0, 6)}·P${item.srcPage + 1}` : `P${item.srcPage + 1}`)}</span>
        ${item.rotationDelta ? `<span class="rotate-tag">${esc(item.rotationDelta > 0 ? '+' : '')}${item.rotationDelta}°</span>` : ''}
        ${item.blank ? '<span class="src-tag">空白页</span>' : ''}`;
      card.onclick = (e) => {
        if (e.shiftKey && state.selected.size && state.pages.length) {
          // shift 连选
          const lastIdx = state.pages.findIndex((p) => state.selected.has(p.key));
          const curIdx = state.pages.indexOf(item);
          const [a, b] = [Math.min(lastIdx, curIdx), Math.max(lastIdx, curIdx)];
          for (let i = a; i <= b; i++) state.selected.add(state.pages[i].key);
        } else if (e.ctrlKey || e.metaKey) {
          toggleSel(item.key);
        } else {
          state.selected.clear();
          state.selected.add(item.key);
        }
        render();
      };
      card.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', item.key);
        card.classList.add('dragging');
      };
      card.ondragend = () => card.classList.remove('dragging');
      card.ondragover = (e) => { e.preventDefault(); card.classList.add('drag-over'); };
      card.ondragleave = () => card.classList.remove('drag-over');
      card.ondrop = (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const srcKey = e.dataTransfer.getData('text/plain');
        if (!srcKey || srcKey === item.key) return;
        pushUndo();
        const from = state.pages.findIndex((p) => p.key === srcKey);
        const [moved] = state.pages.splice(from, 1);
        const to = state.pages.findIndex((p) => p.key === item.key);
        state.pages.splice(to, 0, moved);
        render();
        onChange('reorder');
      };
      ws.appendChild(card);
      io.observe(card);
    }
    countEl.textContent = `共 ${state.pages.length} 页，已选 ${state.selected.size} 页（点击选择，Ctrl 多选，Shift 连选，拖拽排序）`;
  }

  function toggleSel(key) {
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
  }

  function pushUndo() {
    state.undo.push(JSON.stringify(state.pages));
    if (state.undo.length > 60) state.undo.shift();
    state.redo = [];
  }

  // ---- 公开操作 API ----
  function setPages(pages) {
    state.pages = pages.map((p) => ({ rotationDelta: 0, ...p }));
    thumbs.clear();
    state.selected.clear();
    state.undo = []; state.redo = [];
    render();
  }

  function rotateSelected(delta) {
    if (!state.selected.size || readonly) return;
    pushUndo();
    for (const p of state.pages) {
      if (state.selected.has(p.key)) {
        if (p.blank) continue;
        p.rotationDelta = ((p.rotationDelta + delta) % 360 + 360) % 360;
      }
    }
    render();
    onChange('rotate');
  }

  function deleteSelected() {
    if (!state.selected.size || readonly) return;
    pushUndo();
    state.pages = state.pages.filter((p) => !state.selected.has(p.key));
    state.selected.clear();
    render();
    onChange('delete');
  }

  function duplicateSelected() {
    if (!state.selected.size || readonly) return;
    pushUndo();
    const out = [];
    for (const p of state.pages) {
      out.push(p);
      if (state.selected.has(p.key)) {
        out.push({ ...p, key: `${p.key}_c${Math.random().toString(36).slice(2, 6)}` });
      }
    }
    state.pages = out;
    render();
    onChange('duplicate');
  }

  function insertBlankAfterSelected(w = 595, h = 842) {
    if (readonly) return;
    pushUndo();
    const blankItem = { key: `blank_${Math.random().toString(36).slice(2, 8)}`, docId: null, docName: '', srcPage: 0, rotationDelta: 0, blank: { w, h } };
    if (state.selected.size) {
      const idx = state.pages.findIndex((p) => state.selected.has(p.key));
      state.pages.splice(idx + 1, 0, blankItem);
    } else {
      state.pages.push(blankItem);
    }
    render();
    onChange('insertBlank');
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.pages));
    state.pages = JSON.parse(state.undo.pop());
    render();
    onChange('undo');
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.pages));
    state.pages = JSON.parse(state.redo.pop());
    render();
    onChange('redo');
  }

  function selectAll() {
    state.pages.forEach((p) => state.selected.add(p.key));
    render();
  }

  /** 导出整理计划（rotation 为绝对值 = 原 rotate + delta） */
  async function buildPlan(getDocRotation = null) {
    const plan = [];
    const srcRot = new Map();
    for (const item of state.pages) {
      if (item.blank) { plan.push({ blank: item.blank }); continue; }
      if (!srcRot.has(`${item.docId}:${item.srcPage}`)) {
        const doc = getDocument(item.docId);
        const info = doc?.info;
        const base = info?.pages?.[item.srcPage]?.rot ?? 0;
        srcRot.set(`${item.docId}:${item.srcPage}`, base);
      }
      const base = srcRot.get(`${item.docId}:${item.srcPage}`);
      plan.push({
        srcDocId: item.docId,
        srcPage: item.srcPage,
        rotation: (((base + item.rotationDelta) % 360) + 360) % 360,
      });
    }
    return plan;
  }

  const api = {
    el, setPages, rotateSelected, deleteSelected, duplicateSelected,
    insertBlankAfterSelected, undo, redo, selectAll, buildPlan,
    get pages() { return state.pages; },
    get selectedCount() { return state.selected.size; },
    toolbarEl: null,
  };

  // 工具条
  const tb = document.createElement('div');
  tb.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px';
  const mkBtn = (label, fn, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'btn btn-outline btn-sm';
    b.textContent = label;
    b.onclick = fn;
    if (disabled) b.disabled = true;
    return b;
  };
  tb.append(
    mkBtn('↶ 撤销', () => undo()),
    mkBtn('↷ 重做', () => redo()),
    mkBtn('全选', () => selectAll()),
    mkBtn('⟳ 左转90°', () => rotateSelected(-90)),
    mkBtn('⟲ 右转90°', () => rotateSelected(90)),
    (() => { const b = mkBtn(' 删除所选', () => deleteSelected()); b.prepend(iconNode('trash')); return b; })(),
    mkBtn('⧉ 复制所选', () => duplicateSelected()),
    mkBtn('＋ 空白页', () => insertBlankAfterSelected()),
  );
  api.toolbarEl = tb;
  return api;
}
