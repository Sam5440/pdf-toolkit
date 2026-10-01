// PDF 转 Excel（更多 · 对齐 PDF24 pdf-to-excel）：行文本按 2+ 空格分列
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2excel',
  name: 'PDF 转 Excel',
  format: 'xlsx',
  desc: `生成 XLSX，每页一张工作表。${NOTE}`,
});
