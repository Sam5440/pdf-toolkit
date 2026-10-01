// PDF 转 ODF（更多 · 对齐 PDF24 系）：输出 ODT / ODS / ODP 三选一
import { officeExportTool } from './pdf2word.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

officeExportTool({
  id: 'pdf2odf',
  name: 'PDF 转 ODF',
  format: 'odt',
  formatOptions: [
    { value: 'odt', label: 'ODT（文字文档）' },
    { value: 'ods', label: 'ODS（表格）' },
    { value: 'odp', label: 'ODP（演示）' },
  ],
  desc: `生成 OpenDocument（ODT/ODS/ODP）。${NOTE}`,
});
