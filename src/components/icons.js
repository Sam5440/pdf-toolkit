// SVG 图标装载器：全部图标来自 src/assets/icons/*.svg（单色线描）与
// src/assets/icons-color/*.svg（多彩手绘，第三套），每个图标由独立 subagent 绘制，
// 见 docs/ICON-GUIDELINES.md。?raw 内联进 bundle；字符串是构建期静态资产，可安全 innerHTML。
// 图标方案（settings.iconSet）：'svg'（默认，手绘线描）| 'color'（多彩手绘）| 'emoji'（原版 emoji）。
// 新功能图标必须三套齐备（单色 + 多彩 + EMOJI 映射），见 ICON-GUIDELINES「硬性细则」。
import { getSettings } from '../core/settings.js';

const raw = import.meta.glob('../assets/icons/*.svg', { query: '?raw', import: 'default', eager: true });
const rawColor = import.meta.glob('../assets/icons-color/*.svg', { query: '?raw', import: 'default', eager: true });

export const ICONS = {};
for (const [p, svg] of Object.entries(raw)) {
  ICONS[p.split('/').pop().replace(/\.svg$/, '')] = svg;
}

// 多彩手绘方案（第三套）：缺某个图标时回退到单色版
export const ICONS_COLOR = {};
for (const [p, svg] of Object.entries(rawColor)) {
  ICONS_COLOR[p.split('/').pop().replace(/\.svg$/, '')] = svg;
}

// 原版 emoji 方案映射（与 SVG 图标 id 一一对应；无对应项时回退 SVG）
export const EMOJI = {
  merge: '📑', split: '✂️', organize: '🗂', edit: '✏️', watermark: '💧',
  overlay: '🧅', compress: '🗜', security: '🔐', office: '📝', ocr: '🔤',
  text: '📄', images2pdf: '🖼', pdf2images: '🏞', extractimages: '📦', compare: '🔍',
  'theme-moon': '🌙', 'theme-sun': '☀️',
  history: '🕘', settings: '⚙️', upload: '📄', success: '✅', winner: '🏆',
  home: '🏠',
  dopamine: '🎨',
  workflow: '🧩', database: '🗃️', restore: '↩️',
  doc: '📄', trash: '🗑', warn: '⚠️', image: '🖼', 'more-grid': '🧰', tray: '📥',
  folder: '📁',
  // 「更多」分组
  rotate: '🔄', removepages: '➖', extractpages: '📤', nup: '🔲', halve: '➗',
  crop: '⬜', pagenumbers: '#️⃣', bookmarks: '🔖', docinfo: 'ℹ️', metaclean: '🧹',
  viewerpref: '👁', redact: '⬛', sign: '✍️', formfill: '📋', formcreate: '🗃',
  flatten: '🥞', rasterize: '🧱', repair: '🛠', viewer: '👓', search: '🔎',
  passgen: '🔑', qrcode: '📱', scan: '📷', webpage: '🌐', invoice: '🧾',
  createpdf: '📝', txtpdf: '📃', md2pdf: '⬇️', rtf2pdf: '📃', epub2pdf: '📖',
  odf2pdf: '⭕', excelpdf: '📊', svgpdf: '📈', tiffpdf: '🗞', heicpdf: '📸',
  imgconvert: '🔀', pdf2word: '📘', pdf2ppt: '📕', pdf2pptimg: '📽', pdf2excel: '📗', pdf2html: '🕸',
  pdf2md: '📉', pdf2rtf: '📃', pdf2epub: '📚', pdf2odf: '🌏', pdf2tiff: '🗞',
  pdf2svg: '🖋', webpconvert: '🔀', heicconvert: '🔀',
  'qrcode-scan': '📲', 'hash-calc': '🧮', crypt: '🗝️', imgocr: '🔠', filebed: '☁️',
  'image-bed': '🖼️', uploads: '🗂️',
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

function useColor() {
  try { return getSettings().iconSet === 'color'; } catch { return false; }
}

/** 多彩方案取图：icons-color 命中 → 单色兜底 → null（交由调用方走 FALLBACK） */
function resolveColorIcon(id) {
  return ICONS_COLOR[id] || (ICON_ALIAS[id] ? ICONS_COLOR[ICON_ALIAS[id]] : null) || null;
}

/** 生成图标节点：SVG 方案返回 <span class="icon-svg"><svg…/></span>（多彩方案同用
 *  .icon-svg 容器，仅 svg 内容不同），emoji 方案返回 <span class="icon-emoji">📑</span>
 *  （currentColor 随主题仅 SVG 有效） */
export function iconNode(id, className = '') {
  const span = document.createElement('span');
  if (useEmoji() && EMOJI[id]) {
    span.className = `icon-emoji${className ? ` ${className}` : ''}`;
    span.textContent = EMOJI[id];
    return span;
  }
  span.className = `icon-svg${className ? ` ${className}` : ''}`;
  span.innerHTML = (useColor() && resolveColorIcon(id)) || resolveIcon(id);
  return span;
}

/** 内联 SVG 字符串（模板 innerHTML 场景用；静态资产，可安全嵌入） */
export function iconSvg(id, className = '') {
  if (useEmoji() && EMOJI[id]) {
    return `<span class="icon-emoji${className ? ` ${className}` : ''}">${EMOJI[id]}</span>`;
  }
  const body = (useColor() && resolveColorIcon(id)) || resolveIcon(id);
  return `<span class="icon-svg${className ? ` ${className}` : ''}">${body}</span>`;
}
