// 更改页面大小（更多 · 对齐 PDF24 resize）：统一调整为标准纸张（矢量重排）
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, numberInput, button, select } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'resize',
  name: '更改页面大小',
  group: 'm-page',
  desc: '统一调整为 A4/A3/A5/Letter 等规格',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

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
        } catch { /* 上层已 toast */ }
        updateEnable();
      },
      onRemove() { state.doc = null; state.pageCount = 0; updateEnable(); },
    });

    const { card, body } = paramsCard();

    const paperSel = select([
      { value: 'a4', label: 'A4' },
      { value: 'a3', label: 'A3' },
      { value: 'a5', label: 'A5' },
      { value: 'letter', label: 'Letter' },
      { value: 'legal', label: 'Legal' },
    ], 'a4');
    paperSel.setAttribute('data-rz-paper', '');
    body.appendChild(field('目标纸张', paperSel));

    const orientSel = select([
      { value: 'portrait', label: '竖版' },
      { value: 'landscape', label: '横版' },
    ], 'portrait');
    orientSel.setAttribute('data-rz-orient', '');
    body.appendChild(field('方向', orientSel));

    const fitSel = select([
      { value: 'contain', label: '等比适应（完整显示，留白）' },
      { value: 'stretch', label: '拉伸填满（可能变形）' },
    ], 'contain');
    fitSel.setAttribute('data-rz-fit', '');
    body.appendChild(field('适应方式', fitSel));

    const marginInp = numberInput(0, { min: 0, step: 1 });
    marginInp.setAttribute('data-rz-margin', '');
    body.appendChild(field('边距（pt）', marginInp, '内容距纸张四边的距离，单位 pt'));

    const goBtn = button('开始调整', 'btn-primary', () => exec());
    goBtn.setAttribute('data-rz-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pages.resize', {
        docId: state.doc.id,
        paper: paperSel.value,
        orientation: orientSel.value,
        fit: fitSel.value,
        margin: Math.max(0, Number(marginInp.value) || 0),
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, 纸张: String(res.summary.paper).toUpperCase() },
        toolId: 'resize', toolName: '更改页面大小',
        docNames: [state.doc.name],
        options: { paper: paperSel.value, orientation: orientSel.value, fit: fitSel.value, margin: marginInp.value },
      }));
      return res;
    });
  },
});
