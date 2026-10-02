// SVG 图标装载器：全部图标来自 src/assets/icons/*.svg（每个图标由独立 subagent 绘制，
// 见 docs/ICON-GUIDELINES.md）。?raw 内联进 bundle；字符串是构建期静态资产，可安全 innerHTML。
// 图标方案（settings.iconSet）：'svg'（默认，手绘线描）| 'emoji'（原版 emoji，可在设置页切换）。
import { getSettings } from '../core/settings.js';

const raw = import.meta.glob('../assets/icons/*.svg', { query: '?raw', import: 'default', eager: true });

export const ICONS = {};
for (const [p, svg] of Object.entries(raw)) {
  ICONS[p.split('/').pop().replace(/\.svg$/, '')] = svg;
}

// 原版 emoji 方案映射（与 SVG 图标 id 一一对应；无对应项时回退 SVG）
export const EMOJI = {
  merge: '📑', split: '✂️', organize: '🗂', edit: '✏️', watermark: '💧',
  overlay: '🧅', compress: '🗜', security: '🔐', office: '📝', ocr: '🔤',
  text: '📄', images2pdf: '🖼', pdf2images: '🏞', extractimages: '📦', compare: '🔍',
  'theme-moon': '🌙', 'theme-sun': '☀️',
  history: '🕘', settings: '⚙️', upload: '📄', success: '✅', winner: '🏆',
  doc: '📄', trash: '🗑', warn: '⚠️', image: '🖼', 'more-grid': '🧰',
  // 「更多」分组
  rotate: '🔄', removepages: '➖', extractpages: '📤', nup: '🔲', halve: '➗',
  crop: '⬜', pagenumbers: '#️⃣', bookmarks: '🔖', docinfo: 'ℹ️', metaclean: '🧹',
  viewerpref: '👁', redact: '⬛', sign: '✍️', formfill: '📋', formcreate: '🗃',
  flatten: '🥞', rasterize: '🧱', repair: '🛠', viewer: '👓', search: '🔎',
  passgen: '🔑', qrcode: '📱', scan: '📷', webpage: '🌐', invoice: '🧾',
  createpdf: '📝', txtpdf: '📃', md2pdf: '⬇️', rtf2pdf: '📃', epub2pdf: '📖',
  odf2pdf: '⭕', excelpdf: '📊', svgpdf: '📈', tiffpdf: '🗞', heicpdf: '📸',
  imgconvert: '🔀', pdf2word: '📘', pdf2ppt: '📕', pdf2excel: '📗', pdf2html: '🕸',
  pdf2md: '📉', pdf2rtf: '📃', pdf2epub: '📚', pdf2odf: '🌏', pdf2tiff: '🗞',
  pdf2svg: '🖋', webpconvert: '🔀', heicconvert: '🔀',
};

// 图标别名：某工具无专属 SVG 时复用语义最近的图标
const ICON_ALIAS = {
  webpconvert: 'imgconvert',
  heicconvert: 'imgconvert',
};

function resolveIcon(id) {
  return ICONS[id] || (ICON_ALIAS[id] ? ICONS[ICON_ALIAS[id]] : null) || FALLBACK;
}

// 兜底：通用文档图标（仅当某图标缺失时使用）
export const FALLBACK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6h14l8 8v26a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M28 6v8h8"/></svg>';

export function hasIcon(id) {
  return !!ICONS[id];
}

function useEmoji() {
  try { return getSettings().iconSet === 'emoji'; } catch { return false; }
}

/** 生成图标节点：SVG 方案返回 <span class="icon-svg"><svg…/></span>，
 *  emoji 方案返回 <span class="icon-emoji">📑</span>（currentColor 随主题仅 SVG 有效） */
export function iconNode(id, className = '') {
  const span = document.createElement('span');
  if (useEmoji() && EMOJI[id]) {
    span.className = `icon-emoji${className ? ` ${className}` : ''}`;
    span.textContent = EMOJI[id];
    return span;
  }
  span.className = `icon-svg${className ? ` ${className}` : ''}`;
  span.innerHTML = resolveIcon(id);
  return span;
}

/** 内联 SVG 字符串（模板 innerHTML 场景用；静态资产，可安全嵌入） */
export function iconSvg(id, className = '') {
  if (useEmoji() && EMOJI[id]) {
    return `<span class="icon-emoji${className ? ` ${className}` : ''}">${EMOJI[id]}</span>`;
  }
  return `<span class="icon-svg${className ? ` ${className}` : ''}">${resolveIcon(id)}</span>`;
}
