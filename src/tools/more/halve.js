// 页面切半（更多 · 对齐 PDF24 split-pages）：每页裁切为左右/上下两半（矢量裁剪）
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'halve',
  name: '页面切半',
  group: 'm-page',
  desc: '将每页裁切为左右或上下两半',
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

    const mkRadio = (name, value, label, dataAttr, checked = false) => {
      const l = document.createElement('label');
      l.className = 'checkbox-row';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = name;
      r.value = value;
      r.checked = checked;
      r.setAttribute(dataAttr, value);
      const s = document.createElement('span');
      s.textContent = label;
      l.append(r, s);
      return l;
    };

    const dirRow = document.createElement('div');
    dirRow.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap';
    dirRow.append(
      mkRadio('halve-dir', 'vertical', '左右切分（竖切）', 'data-halve-dir', true),
      mkRadio('halve-dir', 'horizontal', '上下切分（横切）', 'data-halve-dir'),
    );
    body.appendChild(field('切分方向', dirRow));

    const orderRow = document.createElement('div');
    orderRow.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap';
    orderRow.append(
      mkRadio('halve-order', 'normal', '正常顺序', 'data-halve-order', true),
      mkRadio('halve-order', 'reverse', '反转顺序', 'data-halve-order'),
    );
    body.appendChild(field('输出顺序', orderRow, '左右切分默认先左半后右半；上下切分默认先上半后下半'));

    const pagesInp = textInput('', '');
    pagesInp.inputMode = 'numeric';
    pagesInp.placeholder = '留空 = 全部；如 1-3';
    pagesInp.setAttribute('data-halve-pages', '');
    body.appendChild(field('页码范围', pagesInp, '仅切分所选页'));

    const goBtn = button('开始切分', 'btn-primary', () => exec());
    goBtn.setAttribute('data-halve-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const dir = dirRow.querySelector('input:checked') || dirRow.querySelector('input');
      const order = orderRow.querySelector('input:checked') || orderRow.querySelector('input');
      const res = await run('pages.halve', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
        direction: dir.value,
        order: order.value,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'halve', toolName: '页面切半',
        docNames: [state.doc.name],
        options: { pages: pagesInp.value, direction: dir.value, order: order.value },
      }));
      return res;
    });
  },
});
