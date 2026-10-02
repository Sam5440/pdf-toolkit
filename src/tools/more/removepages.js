// 删除 PDF 页面（更多 · 对齐 PDF24 delete-pages）：按页码范围删除并保留其余页
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'removepages',
  name: '删除 PDF 页面',
  group: 'm-page',
  desc: '按页码范围删除指定页',
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
    pagesInp.placeholder = '留空 = 删除全部（至少保留 1 页）；如 2 或 1-3,5';
    pagesInp.setAttribute('data-rm-pages', '');
    body.appendChild(field('删除页码范围', pagesInp, '删除所选页，其余页保留；留空删除全部页'));

    const goBtn = button('开始删除', 'btn-primary', () => exec());
    goBtn.setAttribute('data-rm-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pages.remove', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const removed = Math.max(0, state.pageCount - (res.summary?.pages ?? 0));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 删除页数: removed, 剩余页数: res.summary.pages },
        toolId: 'removepages', toolName: '删除 PDF 页面',
        docNames: [state.doc.name],
        options: { pages: pagesInp.value },
      }));
      return res;
    });
  },
});
