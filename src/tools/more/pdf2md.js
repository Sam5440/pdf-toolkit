// PDF 转 Markdown（更多 · 对齐 PDF24 pdf-to-markdown）：标题映射 #/##/###
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2md',
  name: 'PDF 转 Markdown',
  format: 'md',
  desc: `生成 .md，标题映射为 #/##/###。${NOTE}`,
});
