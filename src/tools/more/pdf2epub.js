// PDF 转 EPUB（更多 · 对齐 PDF24 pdf-to-epub）：每页一章的可重排电子书
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2epub',
  name: 'PDF 转 EPUB',
  format: 'epub',
  desc: `生成 EPUB 电子书，每页一章。${NOTE}`,
});
