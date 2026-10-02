// 提取 PDF 页面（更多 · 对齐 PDF24 extract-pages）：抽取所选页另存为新 PDF
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'extractpages',
  name: '提取 PDF 页面',
  group: 'm-page',
  desc: '抽取所选页保存为新 PDF',
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
    const pagesInp = textInput('', '');
    pagesInp.inputMode = 'numeric';
    pagesInp.placeholder = '如 1-3,5；留空 = 全部页';
    pagesInp.setAttribute('data-ex-pages', '');
    body.appendChild(field('提取页码范围', pagesInp, '仅抽取所选页，按原顺序组成新 PDF'));

    const goBtn = button('开始提取', 'btn-primary', () => exec());
    goBtn.setAttribute('data-ex-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pages.extract', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'extractpages', toolName: '提取 PDF 页面',
        docNames: [state.doc.name],
        options: { pages: pagesInp.value },
      }));
      return res;
    });
  },
});
