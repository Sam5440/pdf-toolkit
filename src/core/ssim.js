// SSIM（结构相似性）— 高斯窗实现，与 python skimage.metrics.structural_similarity(σ=1.5, 11×11, gaussian_weights) 对齐。
// 输入为等宽等高的灰度 Uint8Array。用于压缩质量评估（预览与导出同一代码）。

const K1 = 0.01, K2 = 0.03, L = 255;
const C1 = (K1 * L) ** 2, C2 = (K2 * L) ** 2;

function gaussianKernel11() {
  const sigma = 1.5, r = 5;
  const k = new Float64Array(11);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v; sum += v;
  }
  for (let i = 0; i < 11; i++) k[i] /= sum;
  return k;
}

const K = gaussianKernel11();

/** 可分离二维高斯滤波 */
function filter2(src, w, h) {
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -5; i <= 5; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; // 与 skimage 的 reflect padding 近似（对称填充对均匀图差异极小）
        acc += src[y * w + xx] * K[i + 5];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -5; i <= 5; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * K[i + 5];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * @param {Uint8Array} a 灰度图 A
 * @param {Uint8Array} b 灰度图 B
 * @param {number} w @param {number} h
 * @returns {number} SSIM 均值
 */
export function ssimGray(a, b, w, h) {
  if (a.length !== b.length || w * h !== a.length) throw new Error('SSIM 输入尺寸不一致');
  if (w < 11 || h < 11) {
    // 小图退化为全局 MSE 相似度
    let mse = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
    mse /= a.length;
    return 1 - mse / (255 * 255);
  }
  const fa = Float64Array.from(a), fb = Float64Array.from(b);
  const mua = filter2(fa, w, h), mub = filter2(fb, w, h);
  const aa = new Float64Array(w * h), bb = new Float64Array(w * h), ab = new Float64Array(w * h);
  for (let i = 0; i < aa.length; i++) {
    aa[i] = fa[i] * fa[i]; bb[i] = fb[i] * fb[i]; ab[i] = fa[i] * fb[i];
  }
  const vA = filter2(aa, w, h), vB = filter2(bb, w, h), cov = filter2(ab, w, h);
  let total = 0, count = 0;
  for (let i = 0; i < mua.length; i++) {
    const ma = mua[i], mb = mub[i];
    const va = Math.max(0, vA[i] - ma * ma), vb = Math.max(0, vB[i] - mb * mb);
    const c = cov[i] - ma * mb;
    const s = ((2 * ma * mb + C1) * (2 * c + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    total += s; count++;
  }
  return count ? total / count : 0;
}

/** ImageData → 灰度 Uint8Array（BT.601，四舍五入） */
export function grayFromImageData(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000);
  }
  return out;
}
