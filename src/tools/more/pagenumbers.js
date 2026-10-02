// 添加页码（更多 · 对齐 PDF24 add-page-numbers）：九宫格位置 + 格式模板，CJK 栅格化绘制
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  field, numberInput, textInput, select, button,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'pagenumbers',
  name: '添加页码',
  group: 'm-page',
  desc: '九宫格位置、格式模板、CJK 安全页码',
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

    const posSel = select([
      { value: 'top-left', label: '顶部左侧' },
      { value: 'top-center', label: '顶部居中' },
      { value: 'top-right', label: '顶部右侧' },
      { value: 'middle-left', label: '中部左侧' },
      { value: 'middle-center', label: '页面居中' },
      { value: 'middle-right', label: '中部右侧' },
      { value: 'bottom-left', label: '底部左侧' },
      { value: 'bottom-center', label: '底部居中' },
      { value: 'bottom-right', label: '底部右侧' },
    ], 'bottom-center');
    body.appendChild(field('位置', posSel));

    const startInp = numberInput(1, { min: 0, step: 1 });
    body.appendChild(field('起始页码', startInp));

    const fmtInp = textInput('{n} / {N}', '如 {n} / {N}、第 {n} 页（共 {N} 页）');
    body.appendChild(field('格式', fmtInp, '{n}=当前页码，{N}=总页数'));

    const fsInp = numberInput(12, { min: 6, max: 72, step: 1 });
    body.appendChild(field('字号（pt）', fsInp));

    const marginInp = numberInput(28, { min: 0, max: 200, step: 1 });
    body.appendChild(field('边距（pt）', marginInp));

    const pagesInp = textInput('', '留空 = 全部；如 1-3,5');
    body.appendChild(field('页码范围', pagesInp, '仅给所选页编号；留空处理全部页'));

    const goBtn = button('开始编号', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pages.pagenumbers', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
        position: posSel.value,
        start: Math.max(0, Number(startInp.value) || 1),
        format: fmtInp.value.trim() || '{n} / {N}',
        fontSize: Math.max(6, Number(fsInp.value) || 12),
        margin: Math.max(0, Number(marginInp.value) || 0),
        color: '#333333',
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, 位置: posSel.selectedOptions[0]?.textContent || posSel.value },
        toolId: 'pagenumbers', toolName: '添加页码',
        docNames: [state.doc.name],
        options: { pages: pagesInp.value, position: posSel.value, start: startInp.value, format: fmtInp.value },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
