// pdf.js 打开未嵌入字体的 PDF 所需的资源参数：CID 字体（国内导出极常见，如 STSong-Light）
// 依赖 CMap 做字符码→Unicode 映射，标准字体依赖内置字体库，JBIG2/JPX 图像与 ICC 色彩
// 依赖 wasm；三者缺失时对应内容渲染失败（中文表现为整段空白）。资源由 public/pdfjs/
// 随构建拷贝到站点根。仅主线程可用（用到 document.baseURI）；引擎 worker 内请在
// pdfjsOpen 用 assetBase() 拼同样的 URL 并显式传 useWorkerFetch: true。
// 非浏览器环境（单测/Node）无 document，回退仅作占位：测试不会真正 fetch
const BASE = new URL(import.meta.env.BASE_URL || '/', globalThis.document?.baseURI ?? 'file:///').href;

export const PDFJS_ASSET_OPTS = {
  cMapUrl: `${BASE}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
  wasmUrl: `${BASE}pdfjs/wasm/`,
};
