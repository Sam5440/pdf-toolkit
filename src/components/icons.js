// SVG 图标装载器：全部图标来自 src/assets/icons/*.svg（每个图标由独立 subagent 绘制，
// 见 docs/ICON-GUIDELINES.md）。?raw 内联进 bundle；字符串是构建期静态资产，可安全 innerHTML。
const raw = import.meta.glob('../assets/icons/*.svg', { query: '?raw', import: 'default', eager: true });

export const ICONS = {};
for (const [p, svg] of Object.entries(raw)) {
  ICONS[p.split('/').pop().replace(/\.svg$/, '')] = svg;
}

// 兜底：通用文档图标（仅当某图标缺失时使用）
export const FALLBACK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6h14l8 8v26a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M28 6v8h8"/></svg>';

export function hasIcon(id) {
  return !!ICONS[id];
}

/** 生成图标节点：<span class="icon-svg"><svg…/></span>（currentColor 随主题） */
export function iconNode(id, className = '') {
  const span = document.createElement('span');
  span.className = `icon-svg${className ? ` ${className}` : ''}`;
  span.innerHTML = ICONS[id] || FALLBACK;
  return span;
}

/** 内联 SVG 字符串（模板 innerHTML 场景用；静态资产，可安全嵌入） */
export function iconSvg(id, className = '') {
  return `<span class="icon-svg${className ? ` ${className}` : ''}">${ICONS[id] || FALLBACK}</span>`;
}
