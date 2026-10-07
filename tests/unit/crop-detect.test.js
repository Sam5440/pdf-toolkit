import { describe, it, expect } from 'vitest';
import { detectBorders, pxToPt } from '../../src/tools/more/crop-detect.js';

/** 构造 RGBA 测试图：fill(x,y) 返回 [r,g,b] */
function makeImg(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const WHITE = [255, 255, 255];
const BLACK = [8, 8, 8];

describe('crop-detect 白边/黑边检测', () => {
  it('白底 + 居中内容块：四边边距精确', () => {
    // 内容块 left=80 top=60 right=100 bottom=90
    const img = makeImg(400, 300, (x, y) => {
      const inBox = x >= 80 && x < 300 && y >= 60 && y < 210;
      return inBox ? [40, 60, 160] : WHITE;
    });
    const r = detectBorders(img);
    expect(r.left).toBe(80);
    expect(r.top).toBe(60);
    expect(r.right).toBe(100);
    expect(r.bottom).toBe(90);
    expect(r.bg).toBe('white');
    expect(r.uniform).toBe(false);
  });

  it('黑底（扫描黑边）+ 白色内容：bg=black', () => {
    const img = makeImg(300, 200, (x, y) => {
      const inBox = x >= 40 && x < 260 && y >= 30 && y < 170;
      return inBox ? WHITE : BLACK;
    });
    const r = detectBorders(img);
    expect(r.left).toBe(40);
    expect(r.top).toBe(30);
    expect(r.right).toBe(40);
    expect(r.bottom).toBe(30);
    expect(r.bg).toBe('black');
  });

  it('内容顶边（无上边距）→ 其余边照常检出', () => {
    const img = makeImg(200, 200, (x, y) => {
      const inBox = y >= 0 && y < 150 && x >= 30 && x < 170;
      return inBox ? [200, 30, 30] : WHITE;
    });
    const r = detectBorders(img);
    expect(r.top).toBe(0);
    expect(r.left).toBe(30);
    expect(r.right).toBe(30);
    expect(r.bottom).toBe(50);
  });

  it('扫描噪点：边距内少量杂点不阻断（frac 容忍）', () => {
    // 线性索引取模撒噪点（密度约 0.17%，远低于 frac=1%）
    const img = makeImg(300, 300, (x, y) => {
      if (x >= 60 && x < 240 && y >= 50 && y < 250) return [30, 90, 30];
      if ((y * 300 + x) % 601 === 0) return [120, 120, 120];
      return WHITE;
    });
    const r = detectBorders(img);
    expect(r.left).toBe(60);
    expect(r.top).toBe(50);
    expect(r.right).toBe(60);
    expect(r.bottom).toBe(50);
  });

  it('浅色底纹不算背景：边距在底纹处截止', () => {
    // 内容外圈是浅蓝底纹（235,242,255），低于白色阈值 → 不应被当作白边
    const img = makeImg(200, 200, (x, y) => {
      if (x >= 20 && x < 180 && y >= 20 && y < 180) return [235, 242, 255];
      return WHITE;
    });
    const r = detectBorders(img);
    expect(r.left).toBe(20);
    expect(r.top).toBe(20);
    expect(r.right).toBe(20);
    expect(r.bottom).toBe(20);
  });

  it('轻度偏灰的扫描白边（247）在容差内', () => {
    const img = makeImg(100, 100, (x, y) => {
      const inBox = x >= 25 && x < 75 && y >= 25 && y < 75;
      return inBox ? BLACK : [247, 247, 247];
    });
    const r = detectBorders(img);
    expect(r.left).toBe(25);
    expect(r.top).toBe(25);
  });

  it('整页纯白 → uniform=true 且边距归零', () => {
    const img = makeImg(80, 60, () => WHITE);
    const r = detectBorders(img);
    expect(r.uniform).toBe(true);
    expect(r.left).toBe(0);
    expect(r.bottom).toBe(0);
  });

  it('黑底中央小白块：边距停在内容边缘', () => {
    const img = makeImg(200, 100, (x, y) => {
      const inBox = x >= 95 && x < 105 && y >= 45 && y < 55;
      return inBox ? WHITE : BLACK;
    });
    const r = detectBorders(img);
    expect(r.left).toBe(95);
    expect(r.right).toBe(95);
    expect(r.top).toBe(45);
    expect(r.bottom).toBe(45);
    expect(r.bg).toBe('black');
    expect(r.uniform).toBe(false);
  });

  it('pxToPt 按比例换算并保留 1 位小数', () => {
    const m = { left: 80, top: 60, right: 100, bottom: 90 };
    // 96dpi 下 A4 宽 794px ↔ 595pt → 0.7494 pt/px
    const p = pxToPt(m, 595 / 794);
    expect(p.left).toBe(59.9);
    expect(p.top).toBe(45);
    expect(p.right).toBe(74.9);
    expect(p.bottom).toBe(67.4);
  });
});
