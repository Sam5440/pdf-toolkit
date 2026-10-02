// EPUB 转 PDF（更多 · 对齐 PDF24 epub-to-pdf）：多章节解析，章节间自动分页 → 引擎 text.toPdf
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseToBlocks } from '../../core/importers.js';

const PAPER_OPTS = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'a5', label: 'A5（常用电子书尺寸）' },
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
  id: 'epub2pdf',
  name: 'EPUB 转 PDF',
  group: 'm-topdf',
  desc: '电子书按章节转换为 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: '.epub,application/epub+zip',
      acceptTest: /\.epub$/i,
      acceptHint: '选择 1 个 .epub 文件（按 spine 顺序提取各章节文字，章节间自动分页）',
      onAdd(added) {
        state.doc = added.length ? added[added.length - 1] : null;
        goBtn.disabled = !state.doc;
      },
      onRemove() {
        if (!panel.docs().length) { state.doc = null; goBtn.disabled = true; }
      },
    });

    const { card, body } = paramsCard();
    const paperSel = select(PAPER_OPTS, 'a5');
    body.appendChild(field('纸张', paperSel));
    const sizeSel = select(FONT_OPTS, '11');
    body.appendChild(field('正文字号', sizeSel));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const doc = state.doc;
      if (!doc) throw new Error('请先选择文件');
      setP(15, '解析 EPUB…');
      const bytes = new Uint8Array(await doc.file.arrayBuffer());
      const { blocks, title } = parseToBlocks(doc.name, bytes);
      if (!blocks.length) throw new Error('EPUB 中没有可提取的文字');
      const bookTitle = title || doc.name.replace(/\.epub$/i, '');
      const res = await run('text.toPdf', {
        name: bookTitle,
        blocks,
        paper: paperSel.value,
        margin: 48,
        fontSize: Number(sizeSel.value) || 11,
        title: bookTitle,
      }, {
        onProgress: (p) => setP(p.total ? 20 + (p.done / p.total) * 80 : 50, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'epub2pdf', toolName: 'EPUB 转 PDF',
        docNames: [doc.name],
        options: { paper: paperSel.value, fontSize: Number(sizeSel.value) },
        extraNote: 'EPUB 仅提取文字内容重新排版（图片与原排版样式不保留）。',
      }));
      return res;
    });
  },
});
