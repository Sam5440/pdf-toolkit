// 页面几何：MediaBox/CropBox、旋转、视觉坐标 ↔ PDF 用户坐标 变换
// 所有纯函数，供 worker 绘制与前端预览共同使用（保证预览=导出）。

/**
 * 归一化盒子为 {x0,y0,x1,y1,w,h}
 * @param {{x:number,y:number,width:number,height:number}|{x0:number,y0:number,x1:number,y1:number}} box
 */
export function normBox(box) {
  if (box == null) return { x0: 0, y0: 0, x1: 612, y1: 792, w: 612, h: 792 };
  let x0, y0, x1, y1;
  if ('width' in box && 'height' in box) {
    x0 = box.x ?? 0; y0 = box.y ?? 0;
    x1 = x0 + box.width; y1 = y0 + box.height;
  } else {
    x0 = Math.min(box.x0, box.x1); y0 = Math.min(box.y0, box.y1);
    x1 = Math.max(box.x0, box.x1); y1 = Math.max(box.y0, box.y1);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** 显示尺寸（考虑 /Rotate 90/180/270 时宽高互换） */
export function visualSize(box, rotation) {
  const b = normBox(box);
  const r = ((rotation % 360) + 360) % 360;
  if (r === 90 || r === 270) return { w: b.h, h: b.w };
  return { w: b.w, h: b.h };
}

/**
 * 视觉坐标（左上原点，y 向下，单位 pt，相对 CropBox 可视区）→ PDF 用户坐标。
 * dx 从盒左、dy 从盒下计。
 * r=0:   vx=dx, vy=h-dy
 * r=90:  vx=dy, vy=dx
 * r=180: vx=w-dx, vy=dy
 * r=270: vx=h-dy, vy=w-dx
 */
export function visualToUser(vx, vy, box, rotation) {
  const b = normBox(box);
  const r = ((rotation % 360) + 360) % 360;
  let dx, dy;
  if (r === 0) { dx = vx; dy = b.h - vy; }
  else if (r === 90) { dx = vy; dy = vx; }
  else if (r === 180) { dx = b.w - vx; dy = vy; }
  else if (r === 270) { dx = b.w - vy; dy = b.h - vx; }
  else throw new Error(`不支持旋转角 ${rotation}`);
  return { x: b.x0 + dx, y: b.y0 + dy };
}

/** PDF 用户坐标 → 视觉坐标（左上原点） */
export function userToVisual(x, y, box, rotation) {
  const b = normBox(box);
  const r = ((rotation % 360) + 360) % 360;
  const dx = x - b.x0, dy = y - b.y0;
  if (r === 0) return { vx: dx, vy: b.h - dy };
  if (r === 90) return { vx: dy, vy: dx };
  if (r === 180) return { vx: b.w - dx, vy: dy };
  if (r === 270) return { vx: b.h - dy, vy: b.w - dx };
  throw new Error(`不支持旋转角 ${rotation}`);
}

/**
 * 水印绘制角度换算：pdf-lib 用户空间正角=逆时针。
 * 页面显示时被顺时针旋转 r，视觉逆时针角 = 用户角 - r。
 * 反解：用户角 = 视觉角 + r。
 */
export function userAngleForVisual(visualAngleDeg, rotation) {
  return visualAngleDeg + (((rotation % 360) + 360) % 360);
}

/** 旋转增量合法值 */
export function normalizeRotationStep(step) {
  const s = ((Math.round(step / 90) * 90) % 360 + 360) % 360;
  return s;
}

/**
 * 视觉向量 → 用户向量（用于旋转页面上绘制多行文字偏移/尺寸向量）。
 * dvx/dvy 为视觉坐标增量（y 向下）；返回用户空间增量（y 向上）。
 */
export function visualVecToUser(dvx, dvy, rotation) {
  const r = ((rotation % 360) + 360) % 360;
  if (r === 0) return { dx: dvx, dy: -dvy };
  if (r === 90) return { dx: dvy, dy: dvx };
  if (r === 180) return { dx: -dvx, dy: dvy };
  if (r === 270) return { dx: -dvy, dy: -dvx };
  throw new Error(`不支持旋转角 ${rotation}`);
}

/** 绝对旋转合成（当前 rotate + delta） */
export function composeRotation(current, delta) {
  return (((current + delta) % 360) + 360) % 360;
}

/**
 * 视觉镜像 → 内容流变换矩阵 [a,b,c,d,e,f]（PDF cm 语义），轴心取可视框（CropBox）中心。
 * mirrorX=左右镜像（视觉水平翻转）、mirrorY=上下镜像（视觉垂直翻转），可叠加（叠加=点对称）。
 * rotation 为页面最终 /Rotate：视觉水平方向在用户空间由 x（rot 0/180）或 y（rot 90/270）承载，
 * 据此把视觉翻转映射为对应内容轴翻转，保证带 /Rotate 的页镜像方向仍符合视觉直觉。
 * 返回 null 表示无需镜像。
 */
export function mirrorMatrix(box, rotation, mirrorX, mirrorY) {
  if (!mirrorX && !mirrorY) return null;
  const b = normBox(box);
  const r = ((rotation % 360) + 360) % 360;
  const swap = r === 90 || r === 270; // 视觉水平轴 ↔ 用户 y 轴
  const tx = b.x0 + b.x1, ty = b.y0 + b.y1;
  if (mirrorX && mirrorY) return [-1, 0, 0, -1, tx, ty];
  if (mirrorX) return swap ? [1, 0, 0, -1, 0, ty] : [-1, 0, 0, 1, tx, 0];
  return swap ? [-1, 0, 0, 1, tx, 0] : [1, 0, 0, -1, 0, ty];
}

/**
 * 九宫格锚点 → 视觉坐标（相对可视区）。
 * anchors: tl tc tr / ml mc mr / bl bc br
 */
export function anchorPoint(anchor, vw, vh) {
  const col = { l: 0, c: 0.5, r: 1 }[anchor[1]] ?? 0.5;
  const row = { t: 0, m: 0.5, b: 1 }[anchor[0]] ?? 0.5;
  return { vx: col * vw, vy: row * vh };
}

/** 安全裁剪框（限制在 MediaBox 内，最小 1pt） */
export function clampCrop(crop, mediaBox) {
  const m = normBox(mediaBox);
  const c = normBox(crop);
  const x0 = Math.max(m.x0, Math.min(c.x0, m.x1 - 1));
  const y0 = Math.max(m.y0, Math.min(c.y0, m.y1 - 1));
  const x1 = Math.max(x0 + 1, Math.min(c.x1, m.x1));
  const y1 = Math.max(y0 + 1, Math.min(c.y1, m.y1));
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
