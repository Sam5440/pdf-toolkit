// PDF 转 SVG（更多 · 对齐 PDF24 pdf-to-svg）：每页一个 SVG（页面位图封装）
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

const NOTE = '位图封装 SVG，非矢量追踪';

registerTool({
  id: 'pdf2svg',
  name: 'PDF 转 SVG',
  group: 'more',
  desc: `每页导出 SVG（${NOTE}）`,
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
      { value: '96', label: '96 DPI（屏幕）' },
      { value: '150', label: '150 DPI（推荐）' },
      { value: '200', label: '200 DPI（较清晰）' },
      { value: '300', label: '300 DPI（打印）' },
    ], '150');
    body.appendChild(field('DPI', dpiSel));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pdf.toSvg', {
        docId: state.doc.id,
        pages: 'all',
        dpi: Number(dpiSel.value) || 150,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 50, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, DPI: res.summary.dpi },
        toolId: 'pdf2svg', toolName: 'PDF 转 SVG',
        docNames: [state.doc.name],
        options: { dpi: dpiSel.value },
        extraNote: NOTE,
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
