// Excel 转 PDF（更多 · 对齐 PDF24 excel-to-pdf）：.xlsx → parseXlsx 表格块 → 引擎 text.toPdf
// 注意：旧版二进制 .xls 不支持，仅支持 .xlsx（Office Open XML）
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
  { value: 'a3', label: 'A3（宽表格更合适）' },
  { value: 'legal', label: 'Legal' },
];
const FONT_OPTS = [
  { value: '8', label: '8pt（宽表格）' },
  { value: '9', label: '9pt（紧凑）' },
  { value: '10', label: '10pt（标准）' },
  { value: '12', label: '12pt（大）' },
];

registerTool({
  id: 'excelpdf',
  name: 'Excel 转 PDF',
  group: 'more',
  desc: 'xlsx 表格转换为 PDF（旧 .xls 不支持）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      acceptTest: /\.xlsx$/i,
      acceptHint: '选择 1 个 .xlsx 文件（第一张工作表转为表格；旧 .xls 不支持，请先另存为 .xlsx）',
      onAdd(added) {
        state.doc = added.length ? added[added.length - 1] : null;
        goBtn.disabled = !state.doc;
      },
      onRemove() {
        if (!panel.docs().length) { state.doc = null; goBtn.disabled = true; }
      },
    });

    const { card, body } = paramsCard();
    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
    const sizeSel = select(FONT_OPTS, '10');
    body.appendChild(field('表格字号', sizeSel));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const doc = state.doc;
      if (!doc) throw new Error('请先选择文件');
      setP(15, '解析 XLSX…');
      const bytes = new Uint8Array(await doc.file.arrayBuffer());
      const { blocks } = parseToBlocks(doc.name, bytes);
      if (!blocks.length) throw new Error('工作表中没有数据');
      const res = await run('text.toPdf', {
        name: doc.name.replace(/\.xlsx$/i, '') || '表格',
        blocks,
        paper: paperSel.value,
        margin: 36,
        fontSize: Number(sizeSel.value) || 10,
        title: doc.name,
      }, {
        onProgress: (p) => setP(p.total ? 20 + (p.done / p.total) * 80 : 50, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, 行: blocks[0]?.rows?.length || 0 },
        toolId: 'excelpdf', toolName: 'Excel 转 PDF',
        docNames: [doc.name],
        options: { paper: paperSel.value, fontSize: Number(sizeSel.value) },
        extraNote: '仅支持 .xlsx（第一张工作表）；旧版 .xls 请先在 Excel/WPS 中另存为 .xlsx。表格超宽时按比例压缩列宽。',
      }));
      return res;
    });
  },
});
