// PDF 涂黑（更多 · 对齐 PDF24 redact-pdf）：预览页拖拽标记区域，mupdf 深度涂黑真删除
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  field, numberInput, button, toast,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

const PREVIEW_DPI = 96;

registerTool({
  id: 'redact',
  name: 'PDF 涂黑',
  group: 'm-secure',
  desc: '涂抹敏感区域，物理删除下层文字',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = {
      doc: null, pageCount: 0, cur: 0,
      visualW: 0, visualH: 0,
      marks: [], // {page, x, y, w, h}（视觉坐标，y 向下，pt）
    };
    let renderToken = 0;
    let baseBitmap = null; // 当前页原始位图（拖拽预览时反复重绘）

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        state.cur = 0;
        state.marks = [];
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch (e) {
          toast(e.message, 'error');
        }
        await renderPage();
        renderMarks();
        updateGo();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        state.marks = [];
        baseBitmap = null;
        canvas.width = 0;
        canvas.height = 0;
        pageLabel.textContent = '未选择文件';
        renderMarks();
        updateGo();
      },
    });

    // ---- 预览画布 ----
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px';
    const prevBtn = button('上一页', 'btn-outline btn-sm', () => gotoPage(state.cur - 1));
    prevBtn.setAttribute('data-rd-prev', '');
    const nextBtn = button('下一页', 'btn-outline btn-sm', () => gotoPage(state.cur + 1));
    nextBtn.setAttribute('data-rd-next', '');
    const pageLabel = document.createElement('span');
    pageLabel.className = 'muted-sm';
    pageLabel.setAttribute('data-rd-page', '');
    pageLabel.textContent = '未选择文件';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '在页面上按住拖拽即可标记涂黑区域';
    bar.append(prevBtn, pageLabel, nextBtn, hint);

    const stage = document.createElement('div');
    stage.setAttribute('data-rd-stage', '');
    stage.style.cssText = 'position:relative;display:inline-block;max-width:100%;background:#fff;box-shadow:var(--shadow)';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-rd-canvas', '');
    canvas.style.cssText = 'display:block;max-width:100%;touch-action:none;cursor:crosshair';
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    body.append(bar, stage);
    card.appendChild(body);

    // ---- 数值兜底输入 ----
    const numCard = paramsCard();
    const numRow = document.createElement('div');
    numRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end';
    const mkNum = (label, def, attr, min = 0) => {
      const i = numberInput(def, { min, step: 1 });
      i.setAttribute(`data-rd-${attr}`, '');
      i.style.width = '84px';
      const f = field(label, i);
      f.style.marginBottom = '0';
      numRow.appendChild(f);
      return i;
    };
    const nPage = mkNum('页码', 1, 'npage', 1);
    const nX = mkNum('X', 40, 'nx');
    const nY = mkNum('Y', 50, 'ny');
    const nW = mkNum('宽', 300, 'nw');
    const nH = mkNum('高', 50, 'nh');
    const addBtn = button('添加区域', 'btn-outline btn-sm', () => addNumeric());
    addBtn.setAttribute('data-rd-add', '');
    addBtn.style.marginBottom = '0';
    numRow.appendChild(addBtn);
    numCard.body.appendChild(numRow);

    // ---- 区域列表 ----
    const listCard = paramsCard();
    listCard.card.style.marginTop = '14px';
    const listTitle = document.createElement('b');
    listTitle.style.fontSize = '13.5px';
    listTitle.textContent = '已标记区域（0）';
    const marksList = document.createElement('div');
    marksList.setAttribute('data-rd-marks', '');
    marksList.style.marginTop = '8px';
    listCard.body.append(listTitle, marksList);

    const goBtn = button('执行涂黑', 'btn-primary', () => exec());
    goBtn.setAttribute('data-rd-apply', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, numCard.card, listCard.card, goBtn, resultBox);

    function updateGo() { goBtn.disabled = !state.doc || !state.marks.length; }

    function gotoPage(p) {
      if (!state.pageCount) return;
      const np = Math.max(0, Math.min(state.pageCount - 1, p));
      if (np === state.cur) return;
      state.cur = np;
      renderPage();
    }

    async function renderPage() {
      if (!state.doc || !state.pageCount) { return; }
      const my = ++renderToken;
      try {
        const r = await run('doc.render', {
          docId: state.doc.id, page: state.cur, dpi: PREVIEW_DPI, bg: '#ffffff',
        }, {}, new Map([[state.doc.id, state.doc]]));
        if (my !== renderToken) { r.bitmap.close?.(); return; }
        baseBitmap?.close?.();
        baseBitmap = r.bitmap;
        state.visualW = r.visualW || 595;
        state.visualH = r.visualH || 842;
        canvas.width = r.width;
        canvas.height = r.height;
        pageLabel.textContent = `第 ${state.cur + 1} / ${state.pageCount} 页`;
        paint();
      } catch (e) {
        if (my === renderToken) toast(`页面渲染失败：${e.message}`, 'error');
      }
    }

    /** 重绘：底图 + 已标记区域 + 拖拽预览 */
    function paint(dragRect = null) {
      if (!baseBitmap) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(baseBitmap, 0, 0);
      const k = canvas.width / state.visualW; // px / pt
      for (const mk of state.marks) {
        if (mk.page !== state.cur) continue;
        ctx.fillStyle = 'rgba(180,30,30,0.55)';
        ctx.fillRect(mk.x * k, mk.y * k, mk.w * k, mk.h * k);
      }
      if (dragRect) {
        ctx.fillStyle = 'rgba(220,50,50,0.35)';
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 1.5;
        ctx.fillRect(dragRect.x * k, dragRect.y * k, dragRect.w * k, dragRect.h * k);
        ctx.strokeRect(dragRect.x * k, dragRect.y * k, dragRect.w * k, dragRect.h * k);
      }
    }

    // ---- 拖拽标记（pointer 事件；坐标换算 canvas px → 视觉 pt）----
    let dragging = false;
    let start = null;
    const ptOf = (e) => {
      const rect = canvas.getBoundingClientRect();
      const k = state.visualW ? canvas.width / state.visualW : 1;
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width) / k,
        y: (e.clientY - rect.top) * (canvas.height / rect.height) / k,
      };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!state.pageCount) return;
      dragging = true;
      start = ptOf(e);
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = ptOf(e);
      paint({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      });
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      const p = ptOf(e);
      const rect = {
        page: state.cur,
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      if (rect.w > 4 && rect.h > 4) {
        state.marks.push(rect);
        renderMarks();
        paint();
        updateGo();
      } else {
        paint();
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', () => { dragging = false; paint(); });

    function addNumeric() {
      if (!state.pageCount) { toast('请先选择 PDF 文件', 'error'); return; }
      const page = Math.min(state.pageCount, Math.max(1, Number(nPage.value) || 1)) - 1;
      const rect = {
        page,
        x: Math.max(0, Number(nX.value) || 0),
        y: Math.max(0, Number(nY.value) || 0),
        w: Math.max(2, Number(nW.value) || 10),
        h: Math.max(2, Number(nH.value) || 10),
      };
      state.marks.push(rect);
      renderMarks();
      if (page !== state.cur) { state.cur = page; renderPage(); }
      else paint();
      updateGo();
    }

    function renderMarks() {
      marksList.textContent = '';
      listTitle.textContent = `已标记区域（${state.marks.length}）`;
      state.marks.forEach((mk, i) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'result-artifact';
        const info = document.createElement('div');
        info.className = 'ra-info';
        info.innerHTML = `<div class="ra-name">第 ${mk.page + 1} 页</div><div class="ra-meta">X ${Math.round(mk.x)} · Y ${Math.round(mk.y)} · ${Math.round(mk.w)}×${Math.round(mk.h)} pt</div>`;
        const del = button('删除', 'btn-outline btn-sm', () => {
          state.marks.splice(i, 1);
          renderMarks();
          paint();
          updateGo();
        });
        del.setAttribute('data-rd-del', '');
        rowEl.append(info, del);
        marksList.appendChild(rowEl);
      });
    }

    const exec = runWithProgress(resultBox, async (setP) => {
      if (!state.marks.length) { toast('请先标记至少一个涂黑区域', 'error'); throw new Error('请先标记至少一个涂黑区域'); }
      const res = await run('redact.apply', {
        docId: state.doc.id,
        marks: state.marks.map((mk) => ({ ...mk })),
        removeText: true,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 50, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 区域: res.summary.marks, 涂黑方式: res.summary.method === 'mupdf' ? '深度涂黑（文字已删除）' : '黑框遮盖' },
        toolId: 'redact', toolName: 'PDF 涂黑',
        docNames: [state.doc.name],
        options: { marks: state.marks.length },
        warnings: res.warnings,
      });
      resultBox.appendChild(card2);
      state.marks = [];
      renderMarks();
      updateGo();
      return res;
    });
  },
});
