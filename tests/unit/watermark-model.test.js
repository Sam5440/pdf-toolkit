import { describe, it, expect } from 'vitest';
import {
  sanitizeLayer, resolveLayerPages, applyTemplateVars, tileLayout, fullscreenLayout, hexToRgb01, normalizeColor,
} from '../../src/core/watermark-model.js';

describe('sanitizeLayer', () => {
  const base = { type: 'text', text: '机密', fontSize: 48, opacity: 0.4 };
  it('默认值与合法化', () => {
    const l = sanitizeLayer(base);
    expect(l.anchor).toBe('mc');
    expect(l.placement).toBe('single');
    expect(l.pages).toBe('all');
    expect(l.layerSide).toBe('over');
    expect(l.opacity).toBeCloseTo(0.4);
  });
  it('范围钳制', () => {
    const l = sanitizeLayer({ ...base, opacity: 5, fontSize: 999, rotation: 999 });
    expect(l.opacity).toBe(1);
    expect(l.fontSize).toBe(300);
    expect(l.rotation).toBe(180);
  });
  it('空文本拒绝', () => {
    expect(() => sanitizeLayer({ type: 'text', text: '  ' })).toThrow();
  });
  it('非法锚点回退中心', () => {
    expect(sanitizeLayer({ ...base, anchor: 'xx' }).anchor).toBe('mc');
  });
});

describe('resolveLayerPages', () => {
  it('奇偶页', () => {
    expect(resolveLayerPages({ pages: 'odd' }, 5)).toEqual([0, 2, 4]);
    expect(resolveLayerPages({ pages: 'even' }, 5)).toEqual([1, 3]);
  });
  it('自定义范围', () => {
    expect(resolveLayerPages({ pages: 'custom', customRange: '1,3' }, 5)).toEqual([0, 2]);
    expect(() => resolveLayerPages({ pages: 'custom', customRange: '99' }, 5)).toThrow(/超出/);
  });
});

describe('applyTemplateVars', () => {
  it('替换白名单变量', () => {
    const out = applyTemplateVars('第{页码}页/共{总页数} {文件名} {日期} {时间}', {
      pageNo: 2, pageCount: 9, docName: '合同.pdf', date: '2026-01-01', time: '08:00:00',
    });
    expect(out).toBe('第2页/共9 合同.pdf 2026-01-01 08:00:00');
  });
  it('未知变量原样保留（不执行代码）', () => {
    const out = applyTemplateVars('${process.env}', {});
    expect(out).toBe('${process.env}');
    expect(applyTemplateVars('{foo}', {})).toBe('{foo}');
  });
});

describe('tileLayout', () => {
  it('基本平铺数量与首格位置', () => {
    const pos = tileLayout({ vw: 595, vh: 842, cellW: 100, cellH: 40, spacingX: 40, spacingY: 40, stagger: false, marginX: 20, marginY: 20 });
    expect(pos.length).toBeGreaterThan(1);
    expect(pos[0].cx).toBeCloseTo(70, 6);
    expect(pos[0].cy).toBeCloseTo(40, 6);
  });
  it('超大单元格 → 单个居中', () => {
    const pos = tileLayout({ vw: 100, vh: 100, cellW: 300, cellH: 300, spacingX: 10, spacingY: 10, stagger: true, marginX: 5, marginY: 5 });
    expect(pos).toHaveLength(1);
    expect(pos[0]).toEqual({ cx: 50, cy: 50 });
  });
  it('交错行有偏移', () => {
    const pos = tileLayout({ vw: 500, vh: 400, cellW: 50, cellH: 50, spacingX: 30, spacingY: 30, stagger: true, marginX: 10, marginY: 10 });
    const row0 = pos.filter((p) => p.cy === pos[0].cy);
    const row1 = pos.filter((p) => p.cy > pos[0].cy && p.cy < pos[0].cy + 200);
    if (row0.length && row1.length) {
      expect(row1[0].cx - row0[0].cx).toBeCloseTo((50 + 30) / 2, 6);
    }
  });
});

describe('颜色', () => {
  it('hex 归一化与转换', () => {
    expect(normalizeColor('#FFF', '#000000')).toBe('#ffffff');
    expect(hexToRgb01('#FF0000')).toEqual({ r: 1, g: 0, b: 0 });
    expect(hexToRgb01('bad-input')).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('fullscreenLayout', () => {
  it('覆盖四角：最外圈格子中心可越出页面边界（出血）', () => {
    const pos = fullscreenLayout({ vw: 595, vh: 842, density: 4, stagger: false });
    // A4 595×842 密度4：stepX≈148.75，rows=round(842/148.75)=6
    const xs = pos.map((p) => p.cx);
    const ys = pos.map((p) => p.cy);
    expect(Math.min(...xs)).toBeLessThan(0);       // 左出血
    expect(Math.max(...xs)).toBeGreaterThan(595);  // 右出血
    expect(Math.min(...ys)).toBeLessThan(0);       // 上出血
    expect(Math.max(...ys)).toBeGreaterThan(842);  // 下出血
    // 页面中心附近有格子
    const center = pos.find((p) => Math.abs(p.cx - 595 / 2) < 80 && Math.abs(p.cy - 842 / 2) < 80);
    expect(center).toBeTruthy();
  });

  it('密度决定列数，行数按纵横比自动推得', () => {
    const pos = fullscreenLayout({ vw: 595, vh: 842, density: 4, stagger: false });
    const rows = new Set(pos.map((p) => Math.round(p.cy)));
    // 中间行的格子数应为 cols+2（左右各一圈出血）
    expect(pos.length).toBeGreaterThan(4 * 6);
    expect(rows.size).toBeGreaterThan(6);
  });

  it('交错使奇数行水平偏移半格', () => {
    const a = fullscreenLayout({ vw: 595, vh: 842, density: 4, stagger: false });
    const b = fullscreenLayout({ vw: 595, vh: 842, density: 4, stagger: true });
    expect(a.length).toBe(b.length);
    const stepX = 595 / 4;
    // 同一行（取 y 最接近页顶中部的行）对比 x
    const ya = a.map((p) => p.cy);
    const rowY = ya[3];
    const xa = a.filter((p) => p.cy === rowY).map((p) => p.cx).sort((m, n) => m - n);
    const xb = b.filter((p) => p.cy === rowY).map((p) => p.cx).sort((m, n) => m - n);
    expect(xb[1] - xa[1]).toBeCloseTo(stepX / 2, 6);
  });

  it('sanitizeLayer 接受 fullscreen 与 density，并兼容 layer/layerSide 两种键', () => {
    const l = sanitizeLayer({ type: 'text', text: 'x', placement: 'fullscreen', density: 6, layerSide: 'under' });
    expect(l.placement).toBe('fullscreen');
    expect(l.density).toBe(6);
    expect(l.layerSide).toBe('under');
    const l2 = sanitizeLayer({ type: 'text', text: 'x', layer: 'under' });
    expect(l2.layerSide).toBe('under');
    const l3 = sanitizeLayer({ type: 'text', text: 'x', layerSide: 'over' });
    expect(l3.layerSide).toBe('over');
  });
});
