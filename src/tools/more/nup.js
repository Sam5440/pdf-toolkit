// 每页页面数（更多 · 对齐 PDF24 N-up）：将多页矢量拼版到一页纸（2/4/6/9/16 合 1）
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, numberInput, textInput, button, select, checkbox } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'nup',
  name: '每页页面数',
  group: 'more',
  desc: '将多页拼版到一页纸（2/4/6/9/16 合 1）',
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

    const perSel = select([
      { value: '2', label: '每页 2 张（1×2）' },
      { value: '4', label: '每页 4 张（2×2）' },
      { value: '6', label: '每页 6 张（2×3）' },
      { value: '9', label: '每页 9 张（3×3）' },
      { value: '16', label: '每页 16 张（4×4）' },
    ], '4');
    perSel.setAttribute('data-nup-per', '');
    body.appendChild(field('每页张数', perSel));

    const paperSel = select([
      { value: 'a4', label: 'A4' },
      { value: 'a3', label: 'A3' },
      { value: 'a5', label: 'A5' },
      { value: 'letter', label: 'Letter' },
    ], 'a4');
    paperSel.setAttribute('data-nup-paper', '');
    body.appendChild(field('纸张', paperSel));

    const orientSel = select([
      { value: 'portrait', label: '竖版' },
      { value: 'landscape', label: '横版' },
    ], 'portrait');
    orientSel.setAttribute('data-nup-orient', '');
    body.appendChild(field('方向', orientSel));

    const marginInp = numberInput(14, { min: 0, step: 1 });
    marginInp.setAttribute('data-nup-margin', '');
    body.appendChild(field('边距（pt）', marginInp, '纸张四边留白，单位 pt'));

    const borderCk = checkbox('绘制单元格边框');
    borderCk._input.setAttribute('data-nup-border', '');
    body.appendChild(borderCk);

    const pagesInp = textInput('', '');
    pagesInp.inputMode = 'numeric';
    pagesInp.placeholder = '留空 = 全部；如 1-4';
    pagesInp.setAttribute('data-nup-pages', '');
    body.appendChild(field('页码范围', pagesInp, '仅拼版所选页；不足一张时余位留空'));

    const goBtn = button('开始拼版', 'btn-primary', () => exec());
    goBtn.setAttribute('data-nup-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pages.nup', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
        per: Number(perSel.value),
        paper: paperSel.value,
        orientation: orientSel.value,
        margin: Math.max(0, Number(marginInp.value) || 0),
        border: borderCk._input.checked,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 张数: res.summary.sheets, 每页: res.summary.perPage },
        toolId: 'nup', toolName: '每页页面数',
        docNames: [state.doc.name],
        options: {
          pages: pagesInp.value, per: perSel.value, paper: paperSel.value,
          orientation: orientSel.value, margin: marginInp.value, border: borderCk._input.checked,
        },
      }));
      return res;
    });
  },
});
