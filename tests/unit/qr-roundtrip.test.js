// 生成二维码（含中文 UTF-8 修复）往返锁：qrMatrix → 位图（RGBA，含静区）→ jsQR 解码
import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix } from '../../src/core/qr.js';

function matrixToRgba(matrix, scale = 6) {
  const quiet = 4;
  const n = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255); // 白底
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const y = (r + quiet) * scale + dy;
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const i = (y * n + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0; // 黑模块
        }
      }
    }
  }
  return { data, width: n, height: n };
}

describe('二维码生成 → 解码往返', () => {
  it('中英文与 URL（中文 UTF-8 编码正确，扫码不再乱码）', () => {
    for (const text of ['你好，世界 hello', 'https://pdftools.isam.top/', 'A1 #测试 2026']) {
      const img = matrixToRgba(qrMatrix(text, 'M'));
      const code = jsQR(img.data, img.width, img.height);
      expect(code).not.toBeNull();
      expect(code.data).toBe(text);
    }
  });

  it('不同纠错级别均可往返', () => {
    for (const ec of ['L', 'M', 'Q', 'H']) {
      const img = matrixToRgba(qrMatrix('qr-roundtrip-42', ec));
      expect(jsQR(img.data, img.width, img.height)?.data).toBe('qr-roundtrip-42');
    }
  });
});
