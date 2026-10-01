// PDF 转 TIFF（更多 · 对齐 PDF24 pdf-to-tiff）：多页 TIFF，Pillow/预览器可读
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, checkbox, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'pdf2tiff',
  name: 'PDF 转 TIFF',
  group: 'more',
  desc: '多页 TIFF（Pillow/预览器可读）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        goBtn.disabled = !state.doc;
      },
      onRemove() { state.doc = null; goBtn.disabled = true; },
    });

    const { card, body } = paramsCard();

    const dpiSel = select([
      { value: '110', label: '110 DPI（文件小）' },
      { value: '150', label: '150 DPI（推荐）' },
      { value: '200', label: '200 DPI（较清晰）' },
      { value: '300', label: '300 DPI（打印）' },
    ], '150');
    body.appendChild(field('DPI', dpiSel));

    const grayCb = checkbox('转为灰度（可显著减小体积）', false);
    grayCb._input.setAttribute('data-tiff-gray', '');
    body.appendChild(field('选项', grayCb));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pdf.toTiff', {
        docId: state.doc.id,
        pages: 'all',
        dpi: Number(dpiSel.value) || 150,
        gray: grayCb._input.checked,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 50, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, DPI: res.summary.dpi },
        toolId: 'pdf2tiff', toolName: 'PDF 转 TIFF',
        docNames: [state.doc.name],
        options: { dpi: dpiSel.value, gray: grayCb._input.checked },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
