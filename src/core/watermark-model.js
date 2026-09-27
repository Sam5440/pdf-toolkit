// 水印模型（纯逻辑）：规格校验/默认值、页范围解析、模板变量、平铺布局。
// 预览与导出共用此模块 + 同一绘制代码路径（engine-worker wm.apply / wm.preview）。

export const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
export const PLACEMENTS = ['single', 'tile', 'diagonal', 'fullscreen'];
export const PAGE_SCOPES = ['all', 'odd', 'even', 'custom'];

/**
 * 校验并补全水印层参数
 * @param {object} layer
 */
export function sanitizeLayer(layer) {
  if (!layer || typeof layer !== 'object') throw new Error('水印层参数缺失');
  const type = layer.type === 'image' ? 'image' : 'text';
  if (type === 'text' && !String(layer.text ?? '').trim()) {
    throw new Error('文字水印内容不能为空');
  }
  const anchor = ANCHORS.includes(layer.anchor) ? layer.anchor : 'mc';
  const placement = PLACEMENTS.includes(layer.placement) ? layer.placement : 'single';
  const scope = PAGE_SCOPES.includes(layer.pages) ? layer.pages : 'all';
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, n));
  };
  return {
    type,
    text: type === 'text' ? String(layer.text ?? '') : '',
    fontId: type === 'text' ? String(layer.fontId || 'auto') : undefined,
    fontSize: num(layer.fontSize, 48, 4, 300),
    color: normalizeColor(layer.color, '#888888'),
    opacity: num(layer.opacity, 0.35, 0.01, 1),
    bold: !!layer.bold,
    align: ['left', 'center', 'right'].includes(layer.align) ? layer.align : 'center',
    imageRef: type === 'image' ? layer.imageRef : undefined,
    imageScale: num(layer.imageScale, 0.5, 0.01, 5),
    anchor,
    offsetX: num(layer.offsetX, 0, -2000, 2000),
    offsetY: num(layer.offsetY, 0, -2000, 2000),
    rotation: num(layer.rotation, 0, -180, 180),
    placement,
    density: num(layer.density, 4, 1, 16),
    tileSpacingX: num(layer.tileSpacingX, 80, 4, 1000),
    tileSpacingY: num(layer.tileSpacingY, 80, 4, 1000),
    stagger: !!layer.stagger,
    marginX: num(layer.marginX, 20, 0, 500),
    marginY: num(layer.marginY, 20, 0, 500),
    // 兼容两种键名：契约用 layer.layerSide，编辑器历史用 layer.layer
    layerSide: (layer.layerSide ?? layer.layer) === 'under' ? 'under' : 'over',
    pages: scope,
    customRange: String(layer.customRange ?? ''),
  };
}

export function normalizeColor(c, dflt) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (typeof c === 'string' && /^#[0-9a-fA-F]{3}$/.test(c)) {
    return '#' + c.slice(1).split('').map((ch) => ch + ch).join('').toLowerCase();
  }
  return dflt;
}

export function hexToRgb01(hex) {
  const h = normalizeColor(hex, '#000000');
  return {
    r: parseInt(h.slice(1, 3), 16) / 255,
    g: parseInt(h.slice(3, 5), 16) / 255,
    b: parseInt(h.slice(5, 7), 16) / 255,
  };
}

/** 层作用页（0 基） */
export function resolveLayerPages(layer, pageCount) {
  if (layer.pages === 'odd') {
    const out = []; for (let i = 0; i < pageCount; i += 2) out.push(i); return out;
  }
  if (layer.pages === 'even') {
    const out = []; for (let i = 1; i < pageCount; i += 2) out.push(i); return out;
  }
  if (layer.pages === 'custom') {
    // 延迟 import 会造成循环依赖，这里用同一实现（pagerange 无依赖）
    const r = parseRangeInlined(layer.customRange, pageCount);
    if (!r.ok) throw new Error(`页范围错误：${r.error}`);
    return r.pages;
  }
  const out = []; for (let i = 0; i < pageCount; i++) out.push(i); return out;
}

function parseRangeInlined(input, pageCount) {
  // 与 pagerange.parsePageRange 相同语义（复制以保持本模块零依赖可单测）
  const s = String(input ?? '').trim().toLowerCase();
  if (!s || s === 'all') {
    const o = []; for (let i = 0; i < pageCount; i++) o.push(i); return { ok: true, pages: o };
  }
  const seen = new Set(); const out = [];
  for (const raw of s.split(/[,，;；\s]+/)) {
    if (!raw) continue;
    let m = /^(\d+)-(\d+)$/.exec(raw);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a < 1 || b < 1 || a > pageCount || b > pageCount) return { ok: false, error: `${raw} 超出范围` };
      const st = a <= b ? 1 : -1;
      for (let i = a; i !== b + st; i += st) { if (!seen.has(i - 1)) { seen.add(i - 1); out.push(i - 1); } }
      continue;
    }
    if (/^\d+$/.test(raw)) {
      const n = +raw;
      if (n < 1 || n > pageCount) return { ok: false, error: `${n} 超出范围` };
      if (!seen.has(n - 1)) { seen.add(n - 1); out.push(n - 1); }
      continue;
    }
    return { ok: false, error: `无法识别「${raw}」` };
  }
  return out.length ? { ok: true, pages: out } : { ok: false, error: '页范围为空' };
}

/** 模板变量替换（受控白名单，不执行任何代码） */
export function applyTemplateVars(text, vars) {
  return String(text ?? '').replace(/\{(页码|总页数|文件名|日期|时间)\}/g, (m, name) => {
    switch (name) {
      case '页码': return String(vars.pageNo ?? '');
      case '总页数': return String(vars.pageCount ?? '');
      case '文件名': return String(vars.docName ?? '');
      case '日期': return vars.date ?? '';
      case '时间': return vars.time ?? '';
      default: return m;
    }
  });
}

/**
 * 平铺布局：返回视觉坐标（相对可视区左上）的 tile 中心点数组。
 * 保证至少 1 个；单元格大于页面时居中单个。
 */
export function tileLayout({ vw, vh, cellW, cellH, spacingX, spacingY, stagger, marginX, marginY }) {
  const cx0 = Math.min(vw / 2, marginX + cellW / 2);
  const cy0 = Math.min(vh / 2, marginY + cellH / 2);
  const stepX = cellW + Math.max(0, spacingX);
  const stepY = cellH + Math.max(0, spacingY);
  const cols = Math.max(1, Math.floor((vw - 2 * Math.min(marginX, Math.max(0, (vw - cellW) / 2))) / stepX) + 1);
  const rows = Math.max(1, Math.floor((vh - 2 * Math.min(marginY, Math.max(0, (vh - cellH) / 2))) / stepY) + 1);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let cx = cx0 + c * stepX;
      if (stagger && r % 2 === 1) cx += stepX / 2;
      // 超出右边界则跳过（保持整齐），但第一列始终保留
      if (cx - cellW / 2 >= vw - 0.5 && c > 0) continue;
      let cy = cy0 + r * stepY;
      if (cy - cellH / 2 >= vh - 0.5 && r > 0) continue;
      out.push({ cx, cy });
    }
  }
  return out;
}

/**
 * 全屏布局：density 列 × 等比行，格子中心均匀分布并向页面四周外扩一圈（出血），
 * 保证旋转后的字形也能覆盖页面四角与边缘（isam.top 式 3×3 网格的强化版）。
 * 行数由页面纵横比推得（stepY = stepX，近似方格）。
 */
export function fullscreenLayout({ vw, vh, density, stagger, offsetX = 0, offsetY = 0 }) {
  const cols = Math.max(1, Math.round(Number(density) || 4));
  const stepX = vw / cols;
  const rows = Math.max(1, Math.round(vh / stepX));
  const stepY = vh / rows;
  const out = [];
  // c ∈ [-1, cols]，r ∈ [-1, rows]：中心格覆盖页面，外圈提供出血
  for (let r = -1; r <= rows; r++) {
    for (let c = -1; c <= cols; c++) {
      let cx = (c + 0.5) * stepX;
      if (stagger && ((r % 2) + 2) % 2 === 1) cx += stepX / 2;
      out.push({ cx: cx + offsetX, cy: (r + 0.5) * stepY + offsetY });
    }
  }
  return out;
}
