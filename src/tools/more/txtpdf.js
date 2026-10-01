// 文本转 PDF（更多 · 对齐 PDF24 text-to-pdf）：txt/log/csv → importers.parseToBlocks → 引擎 text.toPdf
// csv 自动识别为表格块；txt/log 逐行成段
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseToBlocks } from '../../core/importers.js';

const PAPER_OPTS = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'a5', label: 'A5' },
  { value: 'a3', label: 'A3' },
  { value: 'legal', label: 'Legal' },
];
const FONT_OPTS = [
  { value: '10', label: '10pt（紧凑）' },
  { value: '11', label: '11pt（标准）' },
  { value: '12', label: '12pt（大）' },
  { value: '14', label: '14pt（更大）' },
];

registerTool({
  id: 'txtpdf',
  name: '文本转 PDF',
  group: 'more',
  desc: '将 txt/csv 文本文件排版为 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: '.txt,.log,.csv,text/plain,text/csv',
      acceptTest: /\.(txt|log|csv)$/i,
      acceptHint: '选择 1 个 .txt / .log / .csv 文件（处理全程在本地浏览器完成）',
      onAdd(added) {
        state.doc = added.length ? added[added.length - 1] : null;
        goBtn.disabled = !state.doc;
      },
      onRemove() {
        state.doc = panel.docs().length ? state.doc : null;
        if (!panel.docs().length) { state.doc = null; goBtn.disabled = true; }
      },
    });

    const { card, body } = paramsCard();
    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
    const sizeSel = select(FONT_OPTS, '11');
    body.appendChild(field('正文字号', sizeSel, 'csv 文件将自动识别为表格排版'));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const doc = state.doc;
      if (!doc) throw new Error('请先选择文件');
      setP(15, '解析文本…');
      const bytes = new Uint8Array(await doc.file.arrayBuffer());
      const { blocks } = parseToBlocks(doc.name, bytes);
      if (!blocks.length) throw new Error('文件中没有可排版的内容');
      const res = await run('text.toPdf', {
        name: doc.name.replace(/\.[^.]+$/, '') || '文档',
        blocks,
        paper: paperSel.value,
        margin: 48,
        fontSize: Number(sizeSel.value) || 11,
        title: doc.name,
      }, {
        onProgress: (p) => setP(p.total ? 20 + (p.done / p.total) * 80 : 50, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'txtpdf', toolName: '文本转 PDF',
        docNames: [doc.name],
        options: { paper: paperSel.value, fontSize: Number(sizeSel.value) },
      }));
      return res;
    });
  },
});
