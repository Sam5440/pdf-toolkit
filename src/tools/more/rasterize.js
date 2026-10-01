// 栅格化 PDF（更多 · 对齐 PDF24 rasterize-pdf）：整册转为指定 DPI 图像 PDF
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  field, numberInput, textInput, select, checkbox, button,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'rasterize',
  name: '栅格化 PDF',
  group: 'more',
  desc: '整册转为指定 DPI 的图像 PDF',
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

    const dpiSel = select([
      { value: '72', label: '72 DPI（草稿）' },
      { value: '110', label: '110 DPI（文件小）' },
      { value: '150', label: '150 DPI（推荐）' },
      { value: '200', label: '200 DPI（较清晰）' },
      { value: '300', label: '300 DPI（打印）' },
    ], '150');
    body.appendChild(field('DPI', dpiSel));

    const fmtSel = select([
      { value: 'jpeg', label: 'JPEG（体积小）' },
      { value: 'png', label: 'PNG（无损）' },
    ], 'jpeg');
    body.appendChild(field('图像格式', fmtSel));

    const qInp = numberInput(90, { min: 10, max: 100, step: 1 });
    body.appendChild(field('质量（10-100）', qInp, '仅 JPEG 格式使用'));

    const grayCb = checkbox('转为灰度（可显著减小体积）', false);
    body.appendChild(grayCb);

    const pagesInp = textInput('', '留空 = 全部；如 1-3,5');
    body.appendChild(field('页码范围', pagesInp, '留空处理全部页'));

    const goBtn = button('开始栅格化', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('raster.run', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
        dpi: Number(dpiSel.value) || 150,
        format: fmtSel.value,
        quality: Math.min(100, Math.max(10, Number(qInp.value) || 90)) / 100, // 引擎端 0-1
        gray: grayCb._input.checked,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, DPI: res.summary.dpi, 格式: res.summary.format },
        toolId: 'rasterize', toolName: '栅格化 PDF',
        docNames: [state.doc.name],
        options: { pages: pagesInp.value, dpi: dpiSel.value, format: fmtSel.value, quality: qInp.value, gray: grayCb._input.checked },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
