// 移除元数据（更多 · 对齐 PDF24 remove-metadata）：清空文档信息与 XMP 元数据流
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { button, checkbox } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'metaclean',
  name: '移除元数据',
  group: 'more',
  desc: '清空文档信息与 XMP 元数据',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        updateEnable();
      },
      onRemove() { state.doc = null; updateEnable(); },
    });

    const { card, body } = paramsCard();

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = '将清除标题、作者、主题、关键词、创建者/生产者等文档信息，并删除 XMP 元数据流。此操作会写入新文件，原文件不受影响。';
    body.appendChild(note);

    const agreeCk = checkbox('我了解将清除全部文档信息');
    agreeCk._input.setAttribute('data-mc-agree', '');
    agreeCk._input.addEventListener('change', updateEnable);
    agreeCk.style.marginTop = '10px';
    body.appendChild(agreeCk);

    const goBtn = button('开始清除', 'btn-primary', () => exec());
    goBtn.setAttribute('data-mc-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !(state.doc && agreeCk._input.checked); }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('meta.strip', {
        docId: state.doc.id,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: {},
        toolId: 'metaclean', toolName: '移除元数据',
        docNames: [state.doc.name],
        options: {},
        extraNote: '已清除标题、作者、主题、关键词、创建者/生产者，并尝试删除 XMP 元数据流。',
      }));
      return res;
    });
  },
});
