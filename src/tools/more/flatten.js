// 扁平化 PDF（更多 · 对齐 PDF24 flatten-pdf）：表单扁平化 / 整册栅格化
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'flatten',
  name: '扁平化 PDF',
  group: 'more',
  desc: '表单扁平化或整册栅格化烧入',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch { /* 上层已 toast */ }
        updateEnable();
      },
      onRemove() { state.doc = null; state.pageCount = 0; updateEnable(); },
    });

    const { card, body } = paramsCard();

    // 模式 radio：form（矢量保留）/ raster（整册栅格化）
    const modeBox = document.createElement('div');
    const radios = [];
    const mkRadio = (value, label, hint, checked) => {
      const l = document.createElement('label');
      l.className = 'checkbox-row';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'flatten-mode';
      r.value = value;
      r.checked = checked;
      const s = document.createElement('span');
      s.textContent = `${label}（${hint}）`;
      l.append(r, s);
      modeBox.appendChild(l);
      radios.push(r);
      return r;
    };
    mkRadio('form', '表单扁平化', '表单字段转为静态内容，矢量与文字保留', true);
    mkRadio('raster', '整册栅格化', '每页转为图像烧入，注释/图层/表单全部固定', false);
    body.appendChild(field('模式', modeBox));

    const dpiSel = select([
      { value: '110', label: '110 DPI（文件小）' },
      { value: '150', label: '150 DPI（推荐）' },
      { value: '200', label: '200 DPI（更清晰）' },
    ], '150');
    const dpiField = field('栅格化 DPI', dpiSel, '仅「整册栅格化」模式使用');
    body.appendChild(dpiField);

    const syncDpi = () => { dpiSel.disabled = radios.find((r) => r.checked)?.value !== 'raster'; };
    radios.forEach((r) => r.addEventListener('change', syncDpi));
    syncDpi();

    const goBtn = button('开始扁平化', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const mode = radios.find((r) => r.checked)?.value || 'form';
      if (mode === 'form' && !state.pageCount) toast('请先选择文件', 'error');
      const res = await run('flatten.run', {
        docId: state.doc.id,
        mode,
        dpi: Number(dpiSel.value) || 150,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 模式: mode === 'form' ? '表单扁平化' : `栅格化 ${res.summary.dpi}DPI` },
        toolId: 'flatten', toolName: '扁平化 PDF',
        docNames: [state.doc.name],
        options: { mode, dpi: dpiSel.value },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
