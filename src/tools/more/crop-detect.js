// 裁剪边框检测（纯函数，无 DOM）：扫描页面四周的纯白/纯黑边距。
// 输入 RGBA 位图（如 doc.render 产出的 ImageBitmap 绘到 canvas 后的 ImageData），
// 输出各边背景边距（像素）与背景色类型，供裁剪工具设置默认裁剪线。
// 背景类型由四角像素判定（白底页角是白、扫描黑边页角是黑），随后只按该类型
// 扫描——白内容块在黑底上不会被误当背景吞掉。

/**
 * 检测四周白边/黑边。
 * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} img RGBA，行主序
 * @param {{lightTol?:number, darkTol?:number, frac?:number, cap?:number}} opts
 *   lightTol 白色判定容差（min(r,g,b) ≥ 255-lightTol 视为白，默认 12）
 *   darkTol  黑色判定容差（max(r,g,b) ≤ darkTol 视为黑，默认 40）
 *   frac     一行/列内允许的非背景像素占比上限（容忍扫描噪点，默认 0.01）
 *   cap      单边边距占该维度最大比例（防止整页纯色时吃掉一半页面，默认 0.5）
 * @returns {{left:number, top:number, right:number, bottom:number,
 *            bg:'white'|'black', uniform:boolean}} 边距单位为像素；uniform=整页近纯色
 */
export function detectBorders(img, opts = {}) {
  const { lightTol = 12, darkTol = 40, frac = 0.01, cap = 0.5 } = opts;
  const { data, width: w, height: h } = img;
  const lightTh = 255 - lightTol;
  const isLight = (i) => data[i] >= lightTh && data[i + 1] >= lightTh && data[i + 2] >= lightTh;
  const isDark = (i) => data[i] <= darkTol && data[i + 1] <= darkTol && data[i + 2] <= darkTol;

  // 背景类型：取四角 3×3 共 36 像素，白/黑谁多算谁（都不占多数时默认白）
  let cLight = 0;
  let cDark = 0;
  for (const [cx, cy] of [[0, 0], [w - 3, 0], [0, h - 3], [w - 3, h - 3]]) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const i = ((cy + dy) * w + (cx + dx)) * 4;
        if (isLight(i)) cLight++;
        else if (isDark(i)) cDark++;
      }
    }
  }
  const whiteBg = cLight >= cDark;
  const isBg = whiteBg ? isLight : isDark;

  /** 一行/列是否为背景线：背景像素占比 ≥ 1-frac */
  const bgLine = (idxOf, len) => {
    let bg = 0;
    for (let k = 0; k < len; k++) {
      if (isBg(idxOf(k))) bg++;
    }
    return bg / len >= 1 - frac;
  };

  const maxW = Math.floor(w * cap);
  const maxH = Math.floor(h * cap);
  let left = 0;
  while (left < maxW && bgLine((y) => (y * w + left) * 4, h)) left++;
  let right = 0;
  while (right < maxW && bgLine((y) => (y * w + (w - 1 - right)) * 4, h)) right++;
  let top = 0;
  while (top < maxH && bgLine((x) => (top * w + x) * 4, w)) top++;
  let bottom = 0;
  while (bottom < maxH && bgLine((x) => ((h - 1 - bottom) * w + x) * 4, w)) bottom++;

  if (left >= maxW && right >= maxW && top >= maxH && bottom >= maxH) {
    // 四边都顶到上限：确认整页是否纯色（是则裁剪无意义）
    let bg = 0;
    const total = w * h;
    for (let i = 0; i < total * 4; i += 4) {
      if (isBg(i)) bg++;
    }
    if (bg / total >= 1 - frac) {
      return { left: 0, top: 0, right: 0, bottom: 0, bg: whiteBg ? 'white' : 'black', uniform: true };
    }
  }
  return {
    left, top, right, bottom,
    bg: whiteBg ? 'white' : 'black',
    uniform: false,
  };
}

/** 像素边距 → pt（按渲染比例换算，保留 1 位小数） */
export function pxToPt(margins, scalePtPerPx) {
  const r = (v) => Math.round(v * scalePtPerPx * 10) / 10;
  return { left: r(margins.left), top: r(margins.top), right: r(margins.right), bottom: r(margins.bottom) };
}
