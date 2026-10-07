// 二维码生成（主线程）：包装 qrcode-generator（MIT），产出模块矩阵 / canvas / PNG bytes。
import qrcode from 'qrcode-generator';

// 库默认的 Byte 模式把 charCodeAt 截断为单字节，中文会损坏（扫码出乱码）——启用内置 UTF-8 编码器
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

/**
 * 生成 QR 模块矩阵
 * @param {string} text 内容（自动 UTF-8 编码为 Byte 模式）
 * @param {'L'|'M'|'Q'|'H'} ecLevel 纠错级别
 * @param {number} [typeNumber] 版本 1-40；0 = 自动选择
 * @returns {{size:number, modules:boolean[][], version:number}}
 */
export function qrMatrix(text, ecLevel = 'M', typeNumber = 0) {
  const content = String(text ?? '');
  let qr;
  if (typeNumber > 0) {
    qr = qrcode(typeNumber, ecLevel);
    qr.addData(content, 'Byte');
    qr.make();
  } else {
    // 自动选版：从 1 起逐个尝试（库对超容会抛异常）
    let lastErr = null;
    for (let t = 1; t <= 40; t++) {
      try {
        const q = qrcode(t, ecLevel);
        q.addData(content, 'Byte');
        q.make();
        qr = q;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!qr) throw new Error(`内容过长，无法生成二维码（${content.length} 字符）：${lastErr?.message || ''}`);
  }
  const n = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { size: n, modules, version: (qr.getModuleCount() - 17) / 4 };
}

const QUIET = 4; // 静区（模块数）

/** 渲染到 canvas（黑模块/白底，含静区） */
export function qrToCanvas(matrix, { scale = 8, dark = '#000000', light = '#ffffff' } = {}) {
  const n = matrix.size + QUIET * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = dark;
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
    }
  }
  return canvas;
}

/** 渲染为 PNG Uint8Array */
export async function qrPng(text, { ecLevel = 'M', scale = 8 } = {}) {
  const matrix = qrMatrix(text, ecLevel);
  const canvas = qrToCanvas(matrix, { scale });
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), size: matrix.size, version: matrix.version };
}
