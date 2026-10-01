// PDF 转 HTML（更多 · 对齐 PDF24 pdf-to-html）：标题/段落结构化输出
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2html',
  name: 'PDF 转 HTML',
  format: 'html',
  desc: `生成单文件 HTML（h1-h3/p 分级）。${NOTE}`,
});
