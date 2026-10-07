// 裁剪 PDF（更多 · 可视化框选）：页面预览上直接拖动四边/四角裁剪线，实时预览裁剪效果；
// 支持任意页预览、一键识别白边/黑边；上传后默认按第 1 页边框设置裁剪线
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, numberInput, textInput, button, select, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { detectBorders, pxToPt } from './crop-detect.js';

const PREVIEW_DPI = 96;
const LINE_COLOR = '#e11d48'; // 裁剪线主色（先描白晕，深底/彩底上都可见）
const MIN_BOX = 12; // pt，裁剪框最小边长

registerTool({
  id: 'crop',
  name: '裁剪 PDF',
  group: 'm-page',
  desc: '页面预览上拖拽裁剪线框选区域，自动识别白边/黑边',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = {
      doc: null, pageCount: 0, cur: 0,
      visualW: 0, visualH: 0, // 当前预览页视觉尺寸（pt，/Rotate 已换向）
      pageW: 0, pageH: 0, // 第 1 页视觉尺寸（客户端校验用）
      crop: { left: 0, top: 0, right: 0, bottom: 0 }, // 裁剪线内缩值（视觉 pt，相对各页边缘）
      userEdited: false, // 用户手动改过数值/拖过线后，自动识别不再覆盖
    };
    let renderToken = 0;
    let baseBitmap = null; // 当前页原始位图
    let pageRenderP = null; // 进行中的渲染 Promise（自动识别复用，避免重复渲染）
    let drag = null; // { axes:{l,r,t,b}, start:{x,y}, crop0 }

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        state.cur = 0;
        state.userEdited = false;
        state.crop = { left: 0, top: 0, right: 0, bottom: 0 };
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
          const pm = info.pages?.[0];
          state.pageW = pm ? pm.visualW || pm.w : 0;
          state.pageH = pm ? pm.visualH || pm.h : 0;
        } catch { /* 上层已 toast */ }
        buildJump();
        syncNav();
        syncInputs();
        validate();
        renderPage();
        autoDetectFirst();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        state.cur = 0;
        state.crop = { left: 0, top: 0, right: 0, bottom: 0 };
        state.userEdited = false;
        renderToken++;
        pageRenderP = null;
        baseBitmap?.close?.();
        baseBitmap = null;
        canvas.width = 0;
        canvas.height = 0;
        stage.hidden = true;
        emptyHint.hidden = false;
        pageInfo.textContent = '未选择文件';
        buildJump();
        syncNav();
        syncInputs();
        validate();
      },
    });

    // ---- 预览卡 ----
    const previewCard = document.createElement('div');
    previewCard.className = 'card';
    previewCard.style.marginTop = '14px';
    const pbody = document.createElement('div');
    pbody.className = 'card-body';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px';
    const prevBtn = button('上一页', 'btn-outline btn-sm', () => gotoPage(state.cur - 1));
    prevBtn.setAttribute('data-cp-prev', '');
    const nextBtn = button('下一页', 'btn-outline btn-sm', () => gotoPage(state.cur + 1));
    nextBtn.setAttribute('data-cp-next', '');
    const jumpSel = select([], '0');
    jumpSel.setAttribute('data-cp-jump', '');
    jumpSel.setAttribute('aria-label', '跳转到页');
    jumpSel.style.cssText = 'max-width:130px;min-width:0';
    jumpSel.addEventListener('change', () => gotoPage(Number(jumpSel.value)));
    const pageInfo = document.createElement('span');
    pageInfo.className = 'muted-sm';
    pageInfo.setAttribute('data-cp-pageinfo', '');
    pageInfo.style.cssText = 'flex-basis:100%;min-width:0';
    pageInfo.textContent = '未选择文件';
    const detectBtn = button('自动识别边框', 'btn-outline btn-sm', () => detectCurrent());
    detectBtn.setAttribute('data-cp-detect', '');
    detectBtn.style.marginLeft = 'auto';
    const fullBtn = button('恢复整页', 'btn-outline btn-sm', () => {
      state.userEdited = true;
      state.crop = { left: 0, top: 0, right: 0, bottom: 0 };
      syncInputs();
      paint();
      validate();
    });
    fullBtn.setAttribute('data-cp-full', '');
    bar.append(prevBtn, jumpSel, nextBtn, detectBtn, fullBtn, pageInfo);

    const stage = document.createElement('div');
    stage.setAttribute('data-cp-stage', '');
    stage.hidden = true;
    stage.style.cssText = 'position:relative;display:inline-block;max-width:100%;background:#fff;box-shadow:var(--shadow)';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-cp-canvas', '');
    canvas.style.cssText = 'display:block;max-width:100%;max-height:72vh;width:auto;height:auto;touch-action:none';
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const emptyHint = document.createElement('div');
    emptyHint.className = 'muted-sm';
    emptyHint.style.cssText = 'padding:38px 0;text-align:center';
    emptyHint.textContent = '上传 PDF 后在此预览页面，拖动四边裁剪线框选保留区域';

    const hintEl = document.createElement('div');
    hintEl.className = 'hint';
    hintEl.style.marginTop = '10px';
    hintEl.textContent = '拖动四边/四角裁剪线调整保留区域，暗色部分将被裁掉；翻页可预览任意一页，「自动识别边框」按当前页检测白边或黑边。';

    pbody.append(bar, stage, emptyHint, hintEl);
    previewCard.appendChild(pbody);

    // ---- 裁剪线拖拽手柄（透明命中区；线条视觉画在 canvas 上）----
    const mkHandle = (css, attr) => {
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;touch-action:none;${css}`;
      el.setAttribute('aria-hidden', 'true');
      if (attr) el.setAttribute(attr.name, attr.value);
      stage.appendChild(el);
      return el;
    };
    const EDGE_V = 'width:26px;margin-left:-13px;top:0;bottom:0;cursor:ew-resize';
    const EDGE_H = 'height:26px;margin-top:-13px;left:0;right:0;cursor:ns-resize';
    const hL = mkHandle(EDGE_V, { name: 'data-cp-edge', value: 'left' });
    const hR = mkHandle(EDGE_V, { name: 'data-cp-edge', value: 'right' });
    const hT = mkHandle(EDGE_H, { name: 'data-cp-edge', value: 'top' });
    const hB = mkHandle(EDGE_H, { name: 'data-cp-edge', value: 'bottom' });
    const CORNER = 'width:30px;height:30px;margin:-15px 0 0 -15px;';
    const cTL = mkHandle(`${CORNER}cursor:nwse-resize`, { name: 'data-cp-corner', value: 'tl' });
    const cTR = mkHandle(`${CORNER}cursor:nesw-resize`, { name: 'data-cp-corner', value: 'tr' });
    const cBR = mkHandle(`${CORNER}cursor:nwse-resize`, { name: 'data-cp-corner', value: 'br' });
    const cBL = mkHandle(`${CORNER}cursor:nesw-resize`, { name: 'data-cp-corner', value: 'bl' });

    // ---- 数值卡 ----
    const { card, body } = paramsCard();

    const modeSel = select([
      { value: 'visual', label: '可视化框选（拖拽裁剪线）' },
      { value: 'reset', label: '重置为完整页面（恢复 MediaBox）' },
    ], 'visual');
    modeSel.setAttribute('data-crop-mode', '');
    body.appendChild(field('裁剪方式', modeSel));

    const valsRow = document.createElement('div');
    valsRow.className = 'field-row';
    const mkVal = (key, ph) => {
      const i = numberInput('', { min: 0, step: 0.5 });
      i.placeholder = ph;
      i.setAttribute(`data-crop-${key}`, '');
      i.style.cssText = 'flex:1 1 0;min-width:0;max-width:120px';
      i.addEventListener('input', () => {
        state.userEdited = true;
        state.crop[key] = i.value.trim() === '' ? 0 : Number(i.value) || 0;
        paint();
        validate();
      });
      return i;
    };
    const lInp = mkVal('left', '左');
    const tInp = mkVal('top', '上');
    const rInp = mkVal('right', '右');
    const bInp = mkVal('bottom', '下');
    valsRow.append(lInp, tInp, rInp, bInp);
    const valsField = field('裁剪线内缩（左 · 上 · 右 · 下 pt）', valsRow, '与预览图拖拽联动；内缩值相对所选页各自的页面边缘');
    body.appendChild(valsField);

    const errBox = document.createElement('div');
    errBox.className = 'alert alert-error';
    errBox.setAttribute('data-crop-err', '');
    errBox.style.cssText = 'margin-top:4px;display:none';
    body.appendChild(errBox);

    const pagesInp = textInput('', '');
    pagesInp.inputMode = 'numeric';
    pagesInp.placeholder = '留空 = 全部；如 1-3';
    pagesInp.setAttribute('data-crop-pages', '');
    body.appendChild(field('页码范围', pagesInp, '裁剪线位置应用到所选页（按各页自身边缘计算）'));

    const goBtn = button('开始裁剪', 'btn-primary', () => exec());
    goBtn.setAttribute('data-crop-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, previewCard, card, goBtn, resultBox);

    modeSel.addEventListener('change', () => {
      const reset = modeSel.value === 'reset';
      previewCard.style.display = reset ? 'none' : '';
      valsField.style.display = reset ? 'none' : '';
      validate();
    });

    const num = (inp) => {
      const s = String(inp.value).trim();
      return s === '' ? 0 : Number(s);
    };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    function showErr(msg) {
      errBox.textContent = msg;
      errBox.style.display = 'block';
      goBtn.disabled = true;
    }

    function validate() {
      errBox.style.display = 'none';
      errBox.textContent = '';
      if (!state.doc) { goBtn.disabled = true; return; }
      if (modeSel.value === 'reset') { goBtn.disabled = false; return; }
      const [l, t, r, b] = [num(lInp), num(tInp), num(rInp), num(bInp)];
      const vals = [l, t, r, b];
      if (vals.some((v) => !Number.isFinite(v) || v < 0)) {
        showErr('四边数值需为 ≥ 0 的数字'); return;
      }
      if (state.pageW && state.pageH) {
        if (l + r >= state.pageW - 2 || t + b >= state.pageH - 2) {
          showErr(`裁剪尺寸过大（页面约 ${Math.round(state.pageW)}×${Math.round(state.pageH)} pt），请减小内缩值`); return;
        }
      }
      goBtn.disabled = false;
    }

    function syncInputs() {
      const r1 = (v) => String(Math.round(v * 10) / 10);
      lInp.value = r1(state.crop.left);
      tInp.value = r1(state.crop.top);
      rInp.value = r1(state.crop.right);
      bInp.value = r1(state.crop.bottom);
    }

    function buildJump() {
      jumpSel.textContent = '';
      for (let i = 0; i < state.pageCount; i++) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `第 ${i + 1} 页`;
        jumpSel.appendChild(o);
      }
    }

    function syncNav() {
      const has = state.pageCount > 0;
      prevBtn.disabled = !has || state.cur <= 0;
      nextBtn.disabled = !has || state.cur >= state.pageCount - 1;
      jumpSel.disabled = !has;
      detectBtn.disabled = !has;
      if (has) jumpSel.value = String(state.cur);
    }

    function gotoPage(p) {
      if (!state.pageCount) return;
      const np = clamp(p, 0, state.pageCount - 1);
      if (np === state.cur) return;
      state.cur = np;
      renderPage();
    }

    async function renderPage() {
      if (!state.doc || !state.pageCount) return;
      const my = ++renderToken;
      const p = run('doc.render', {
        docId: state.doc.id, page: state.cur, dpi: PREVIEW_DPI, bg: '#ffffff',
      }, {}, new Map([[state.doc.id, state.doc]]));
      pageRenderP = p;
      try {
        const r = await p;
        if (my !== renderToken) { r.bitmap.close?.(); return; }
        baseBitmap?.close?.();
        baseBitmap = r.bitmap;
        state.visualW = r.visualW || 595;
        state.visualH = r.visualH || 842;
        canvas.width = r.width;
        canvas.height = r.height;
        pageInfo.textContent = `第 ${state.cur + 1} / ${state.pageCount} 页 · ${Math.round(state.visualW)}×${Math.round(state.visualH)} pt`;
        stage.hidden = false;
        emptyHint.hidden = true;
        syncNav();
        paint();
      } catch (e) {
        if (my === renderToken) toast(`页面渲染失败：${e.message}`, 'error');
      } finally {
        if (my === renderToken) pageRenderP = null;
      }
    }

    /** 重绘：底图 + 裁剪区外压暗 + 四边裁剪线/抓手 + 尺寸标注 */
    function paint() {
      if (!baseBitmap || !canvas.width) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(baseBitmap, 0, 0);
      const k = state.visualW ? canvas.width / state.visualW : 1;
      const { left, top, right, bottom } = state.crop;
      const x0 = clamp(left * k, 0, canvas.width - 2);
      const y0 = clamp(top * k, 0, canvas.height - 2);
      const x1 = clamp(canvas.width - right * k, x0 + 2, canvas.width);
      const y1 = clamp(canvas.height - bottom * k, y0 + 2, canvas.height);
      ctx.fillStyle = 'rgba(15,23,42,0.55)';
      ctx.fillRect(0, 0, canvas.width, y0);
      ctx.fillRect(0, y1, canvas.width, canvas.height - y1);
      ctx.fillRect(0, y0, x0, y1 - y0);
      ctx.fillRect(x1, y0, canvas.width - x1, y1 - y0);
      // 裁剪线：白晕 + 主色，深浅底都可见
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3.5;
      strokeBox(x0, y0, x1, y1);
      ctx.strokeStyle = LINE_COLOR;
      ctx.lineWidth = 1.5;
      strokeBox(x0, y0, x1, y1);
      drawGrips(x0, y0, x1, y1);
      // 保留区域尺寸标注
      const wPt = Math.max(0, Math.round(state.visualW - left - right));
      const hPt = Math.max(0, Math.round(state.visualH - top - bottom));
      const label = `${wPt} × ${hPt} pt`;
      ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(label, x0 + 8, y0 + 8);
      ctx.fillStyle = LINE_COLOR;
      ctx.fillText(label, x0 + 8, y0 + 8);
      positionHandles();
    }

    function strokeBox(x0, y0, x1, y1) {
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y0);
      ctx.lineTo(x1, y1); ctx.lineTo(x0, y1);
      ctx.closePath();
      ctx.stroke();
    }

    /** 四边中点抓手：垂直于裁剪线的短杠 */
    function drawGrips(x0, y0, x1, y1) {
      const len = 16, th = 4;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const bar = (cx, cy, w, h) => {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(cx - w / 2 - 1.5, cy - h / 2 - 1.5, w + 3, h + 3);
        ctx.fillStyle = LINE_COLOR;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      };
      bar(x0, my, th, len);
      bar(x1, my, th, len);
      bar(mx, y0, len, th);
      bar(mx, y1, len, th);
    }

    function positionHandles() {
      const set = (el, xPct, yPct) => {
        if (xPct != null) el.style.left = `${xPct}%`;
        if (yPct != null) el.style.top = `${yPct}%`;
      };
      const pw = state.visualW || 1, ph = state.visualH || 1;
      const xl = (state.crop.left / pw) * 100;
      const xr = (1 - state.crop.right / pw) * 100;
      const yt = (state.crop.top / ph) * 100;
      const yb = (1 - state.crop.bottom / ph) * 100;
      set(hL, xl, null);
      set(hR, xr, null);
      set(hT, null, yt);
      set(hB, null, yb);
      set(cTL, xl, yt);
      set(cTR, xr, yt);
      set(cBR, xr, yb);
      set(cBL, xl, yb);
    }

    // ---- 拖拽（pointer 事件；canvas CSS 尺寸 ↔ 视觉 pt 换算）----
    const evPt = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.width ? (e.clientX - rect.left) * (state.visualW / rect.width) : 0,
        y: rect.height ? (e.clientY - rect.top) * (state.visualH / rect.height) : 0,
      };
    };

    function bindDrag(el, axes) {
      el.addEventListener('pointerdown', (e) => {
        if (!baseBitmap) return;
        e.preventDefault();
        drag = { axes, start: evPt(e), crop0: { ...state.crop } };
        el.setPointerCapture?.(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag || !el.hasPointerCapture?.(e.pointerId)) return;
        const p = evPt(e);
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        const o = drag.crop0;
        const c = { ...o };
        if (drag.axes.l) c.left = clamp(o.left + dx, 0, state.visualW - o.right - MIN_BOX);
        if (drag.axes.r) c.right = clamp(o.right - dx, 0, state.visualW - o.left - MIN_BOX);
        if (drag.axes.t) c.top = clamp(o.top + dy, 0, state.visualH - o.bottom - MIN_BOX);
        if (drag.axes.b) c.bottom = clamp(o.bottom - dy, 0, state.visualH - o.top - MIN_BOX);
        state.crop = c;
        state.userEdited = true;
        syncInputs();
        paint();
      });
      const up = () => {
        if (!drag) return;
        drag = null;
        validate();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    bindDrag(hL, { l: true });
    bindDrag(hR, { r: true });
    bindDrag(hT, { t: true });
    bindDrag(hB, { b: true });
    bindDrag(cTL, { l: true, t: true });
    bindDrag(cTR, { r: true, t: true });
    bindDrag(cBR, { r: true, b: true });
    bindDrag(cBL, { l: true, b: true });

    // ---- 白边/黑边识别 ----
    function detectFromBitmap(bitmap) {
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bitmap, 0, 0);
      return detectBorders(cx.getImageData(0, 0, c.width, c.height));
    }

    function applyDetection(m, pageNo, scale) {
      if (m.uniform) {
        toast(`第 ${pageNo} 页整页近纯色，未识别到内容边界`, 'error');
        return;
      }
      state.crop = pxToPt(m, scale);
      syncInputs();
      paint();
      validate();
      const pt = state.crop;
      const parts = [
        ['上', pt.top], ['下', pt.bottom], ['左', pt.left], ['右', pt.right],
      ].filter(([, v]) => v > 0).map(([n, v]) => `${n} ${v}`).join(' · ');
      toast(`已按第 ${pageNo} 页识别${m.bg === 'white' ? '白' : '黑'}边${parts ? `：${parts} pt` : '（内容已顶边，无需裁剪）'}`);
    }

    async function detectCurrent() {
      if (!baseBitmap) { toast('请先选择 PDF 文件', 'error'); return; }
      const my = renderToken;
      try {
        if (pageRenderP) await pageRenderP;
      } catch { /* 渲染失败由 renderPage 提示 */ }
      if (my !== renderToken || !baseBitmap) return;
      const m = detectFromBitmap(baseBitmap);
      applyDetection(m, state.cur + 1, state.visualW / canvas.width);
    }

    /** 上传后按第 1 页自动识别一次，作为默认裁剪线（用户手动改过则不覆盖） */
    async function autoDetectFirst() {
      if (!state.doc || state.userEdited) return;
      const my = renderToken;
      try {
        if (pageRenderP) await pageRenderP;
      } catch { return; }
      if (my !== renderToken || state.userEdited || !baseBitmap) return;
      try {
        const m = detectFromBitmap(baseBitmap);
        if (!state.userEdited && my === renderToken) applyDetection(m, 1, state.visualW / canvas.width);
      } catch { /* 识别失败保持 0 */ }
    }

    const exec = runWithProgress(resultBox, async (setP) => {
      const uiMode = modeSel.value;
      // op 协议只认 margin/percent/reset；可视化框选即 margin 语义（四边内缩 pt）
      const opMode = uiMode === 'reset' ? 'reset' : 'margin';
      const values = uiMode === 'reset' ? {} : { left: num(lInp), top: num(tInp), right: num(rInp), bottom: num(bInp) };
      const res = await run('pages.crop', {
        docId: state.doc.id,
        mode: opMode,
        values,
        pages: pagesInp.value.trim() || 'all',
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'crop', toolName: '裁剪 PDF',
        docNames: [state.doc.name],
        options: { mode: opMode, ...values, pages: pagesInp.value },
      }));
      if (uiMode !== 'reset') {
        // 预览反映裁剪结果：worker 内文档已更新，重渲染当前页并归零裁剪线
        state.crop = { left: 0, top: 0, right: 0, bottom: 0 };
        syncInputs();
        renderPage();
      }
      return res;
    });
  },
});
