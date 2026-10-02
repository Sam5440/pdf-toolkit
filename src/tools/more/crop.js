// 裁剪 PDF（更多 · 对齐 PDF24 crop）：按边距/百分比设置 CropBox，或重置为完整页面
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, numberInput, textInput, button, select } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'crop',
  name: '裁剪 PDF',
  group: 'm-page',
  desc: '按边距/百分比/精确框设置裁剪区域',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0, pageW: 0, pageH: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
          const pm = info.pages?.[0];
          state.pageW = pm ? pm.visualW || pm.w : 0;
          state.pageH = pm ? pm.visualH || pm.h : 0;
        } catch { /* 上层已 toast */ }
        validate();
      },
      onRemove() {
        state.doc = null; state.pageCount = 0; state.pageW = 0; state.pageH = 0;
        validate();
      },
    });

    const { card, body } = paramsCard();

    const modeSel = select([
      { value: 'margin', label: '按边距裁剪（pt）' },
      { value: 'percent', label: '按百分比裁剪（%）' },
      { value: 'reset', label: '重置为完整页面' },
    ], 'margin');
    modeSel.setAttribute('data-crop-mode', '');
    body.appendChild(field('裁剪模式', modeSel));

    const mkVal = (key, ph) => {
      const i = numberInput('', { min: 0, step: 1 });
      i.placeholder = ph;
      i.setAttribute(`data-crop-${key}`, '');
      i.addEventListener('input', validate);
      return i;
    };
    const lInp = mkVal('left', '左');
    const tInp = mkVal('top', '上');
    const rInp = mkVal('right', '右');
    const bInp = mkVal('bottom', '下');
    const valsRow = document.createElement('div');
    valsRow.className = 'field-row';
    valsRow.append(lInp, tInp, rInp, bInp);
    const valsField = field('四边数值（左 · 上 · 右 · 下）', valsRow, '留空按 0 处理');
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
    body.appendChild(field('页码范围', pagesInp, '仅裁剪所选页'));

    const goBtn = button('开始裁剪', 'btn-primary', () => exec());
    goBtn.setAttribute('data-crop-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const num = (inp) => {
      const s = String(inp.value).trim();
      return s === '' ? 0 : Number(s);
    };

    function showErr(msg) {
      errBox.textContent = msg;
      errBox.style.display = 'block';
      goBtn.disabled = true;
    }

    function validate() {
      errBox.style.display = 'none';
      errBox.textContent = '';
      if (!state.doc) { goBtn.disabled = true; return; }
      const mode = modeSel.value;
      if (mode === 'reset') { goBtn.disabled = false; return; }
      const [l, t, r, b] = [num(lInp), num(tInp), num(rInp), num(bInp)];
      const vals = [l, t, r, b];
      if (vals.some((v) => !Number.isFinite(v) || v < 0)) {
        showErr('四边数值需为 ≥ 0 的数字'); return;
      }
      if (mode === 'percent') {
        if (l + r >= 100 || t + b >= 100) {
          showErr('左右或上下的百分比之和需小于 100，否则页面会被裁没'); return;
        }
      } else if (state.pageW && state.pageH) {
        if (l + r >= state.pageW - 2 || t + b >= state.pageH - 2) {
          showErr(`裁剪尺寸过大（页面约 ${Math.round(state.pageW)}×${Math.round(state.pageH)} pt），请减小边距`); return;
        }
      }
      goBtn.disabled = false;
    }

    modeSel.addEventListener('change', () => {
      const pct = modeSel.value === 'percent';
      for (const inp of [lInp, tInp, rInp, bInp]) {
        if (pct) { inp.min = '0'; inp.max = '49'; } else { inp.min = '0'; inp.removeAttribute('max'); }
      }
      valsField.style.display = modeSel.value === 'reset' ? 'none' : '';
      validate();
    });

    const exec = runWithProgress(resultBox, async (setP) => {
      const mode = modeSel.value;
      const values = mode === 'reset' ? {} : { left: num(lInp), top: num(tInp), right: num(rInp), bottom: num(bInp) };
      const res = await run('pages.crop', {
        docId: state.doc.id,
        mode,
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
        options: { mode, ...values, pages: pagesInp.value },
      }));
      return res;
    });
  },
});
