// PDF 查看器（更多）：canvas 逐页浏览，翻页 / 缩放 / 旋转显示
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { button, select, toast } from '../../components/ui.js';

const BASE_DPI = 96;

registerTool({
  id: 'viewer',
  name: 'PDF 查看器',
  group: 'more',
  desc: '本地浏览 PDF：翻页/缩放/旋转',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = {
      doc: null, pageCount: 0, cur: 0, rotation: 0,
      visualW: 0, visualH: 0,
    };
    let renderToken = 0;

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（仅在本地浏览器内打开）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        state.cur = 0;
        state.rotation = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch (e) {
          toast(e.message, 'error');
        }
        await renderPage();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        state.cur = 0;
        canvas.width = 0;
        canvas.height = 0;
        label.textContent = '未选择文件';
        updateNav();
      },
    });

    // 工具栏
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px';
    const prevBtn = button('上一页', 'btn-outline btn-sm', () => gotoPage(state.cur - 1));
    prevBtn.setAttribute('data-vw-prev', '');
    const nextBtn = button('下一页', 'btn-outline btn-sm', () => gotoPage(state.cur + 1));
    nextBtn.setAttribute('data-vw-next', '');
    const label = document.createElement('span');
    label.className = 'muted-sm';
    label.setAttribute('data-vw-label', '');
    label.textContent = '未选择文件';
    const zoomSel = select([
      { value: '0.5', label: '50%' },
      { value: '0.75', label: '75%' },
      { value: '1', label: '100%' },
      { value: '1.5', label: '150%' },
      { value: '2', label: '200%' },
    ], '1');
    zoomSel.setAttribute('data-vw-zoom', '');
    zoomSel.style.width = 'auto';
    zoomSel.addEventListener('change', () => renderPage());
    const rotBtn = button('旋转 90°', 'btn-outline btn-sm', () => {
      state.rotation = (state.rotation + 90) % 360;
      renderPage();
    });
    bar.append(prevBtn, label, nextBtn, zoomSel, rotBtn);

    // 画布
    const stage = document.createElement('div');
    stage.style.cssText = 'position:relative;display:inline-block;max-width:100%;background:#fff;box-shadow:var(--shadow)';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-vw-canvas', '');
    canvas.style.cssText = 'display:block;max-width:100%';
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';
    body.append(bar, stage);
    card.appendChild(body);

    const emptyHint = document.createElement('div');
    emptyHint.className = 'hint';
    emptyHint.style.marginTop = '8px';
    emptyHint.textContent = '提示：查看器仅在本页显示，不做任何修改；缩放按 DPI 渲染，文字始终清晰。';

    container.append(panel.el, card, emptyHint);

    function updateNav() {
      const ok = state.pageCount > 0;
      prevBtn.disabled = !ok || state.cur <= 0;
      nextBtn.disabled = !ok || state.cur >= state.pageCount - 1;
      if (ok) label.textContent = `第 ${state.cur + 1} / ${state.pageCount} 页`;
    }

    function gotoPage(p) {
      if (!state.pageCount) return;
      const np = Math.max(0, Math.min(state.pageCount - 1, p));
      if (np === state.cur) return;
      state.cur = np;
      renderPage();
    }

    async function renderPage() {
      if (!state.doc || !state.pageCount) { updateNav(); return; }
      const my = ++renderToken;
      const ratio = Number(zoomSel.value) || 1;
      try {
        const r = await run('doc.render', {
          docId: state.doc.id,
          page: state.cur,
          dpi: Math.round(BASE_DPI * ratio),
          bg: '#ffffff',
        }, {}, new Map([[state.doc.id, state.doc]]));
        if (my !== renderToken) { r.bitmap.close?.(); return; }
        state.visualW = r.visualW;
        state.visualH = r.visualH;
        if (state.rotation % 360 === 0) {
          canvas.width = r.width;
          canvas.height = r.height;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(r.bitmap, 0, 0);
        } else {
          // 旋转显示（仅显示层旋转，不改文件）
          const swap = state.rotation % 180 !== 0;
          canvas.width = swap ? r.height : r.width;
          canvas.height = swap ? r.width : r.height;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((state.rotation * Math.PI) / 180);
          ctx.drawImage(r.bitmap, -r.width / 2, -r.height / 2);
          ctx.restore();
        }
        r.bitmap.close?.();
        updateNav();
      } catch (e) {
        if (my === renderToken) toast(`页面渲染失败：${e.message}`, 'error');
      }
    }
  },
});
