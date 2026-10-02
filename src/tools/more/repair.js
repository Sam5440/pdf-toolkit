// 修复 PDF（更多 · 对齐 PDF24 repair-pdf）：mupdf 重建交叉引用，pdf-lib 容错重存兜底
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { button } from '../../components/ui.js';
import { resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'repair',
  name: '修复 PDF',
  group: 'm-fix',
  desc: '重建损坏的 PDF 交叉引用与结构',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（损坏文件也可尝试修复；全程本地处理）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        try {
          state.doc.info = await ensureDoc(state.doc);
        } catch { /* 上层已 toast */ }
        updateEnable();
      },
      onRemove() { state.doc = null; updateEnable(); },
    });

    const goBtn = button('开始修复', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      setP(30, '重建文件结构…');
      const res = await run('repair.run', {
        docId: state.doc.id,
      }, { onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 50, p.stage) },
      new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 修复引擎: res.summary.via, 体积: `${Math.round((res.summary.size || 0) / 1024)} KB` },
        toolId: 'repair', toolName: '修复 PDF',
        docNames: [state.doc.name],
        options: {},
        warnings: res.warnings,
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
