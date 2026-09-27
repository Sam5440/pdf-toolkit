// 工具注册中心：引入全部工具模块触发自注册（唯一需要集中维护的清单文件）
import { TOOLS, GROUPS, getTool } from './core.js';
import './merge.js';
import './split.js';
import './organize.js';
import './edit.js';
import './watermark.js';
import './overlay.js';
import './compress.js';
import './security.js';
import './office.js';
import './ocr.js';
import './text.js';
import './images2pdf.js';
import './pdf2images.js';
import './extractimages.js';
import './compare.js';

export { TOOLS, GROUPS, getTool };
