// PDF 转 PPT（更多 · 对齐 PDF24 pdf-to-powerpoint）：每页一帧文本级导出
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2ppt',
  name: 'PDF 转 PPT',
  format: 'pptx',
  desc: `生成 PPTX，每页一帧。${NOTE}`,
});
