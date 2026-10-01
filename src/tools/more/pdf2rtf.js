// PDF 转 RTF（更多 · 对齐 PDF24 pdf-to-rtf）：\uN 转义任意 Unicode
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2rtf',
  name: 'PDF 转 RTF',
  format: 'rtf',
  desc: `生成 RTF（富文本，兼容各文字处理器）。${NOTE}`,
});
