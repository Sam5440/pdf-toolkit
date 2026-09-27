import { describe, it, expect } from 'vitest';
import { ssimGray, grayFromImageData } from '../../src/core/ssim.js';
import { lineDiff, pageTextDiffs } from '../../src/core/textdiff.js';
import { planCandidates, refineCandidates, candidateId, pickBest, labelOf } from '../../src/core/compress-planner.js';
import { fmtBytes, sanitizeFilename, esc } from '../../src/core/format.js';
import { sanitizeOptions } from '../../src/core/history.js';

describe('SSIM', () => {
  it('相同图像 = 1', () => {
    const w = 64, h = 64;
    const a = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = (i * 7) % 256;
    expect(ssimGray(a, a, w, h)).toBeCloseTo(1, 5);
  });
  it('无关图像 < 相关图像', () => {
    const w = 64, h = 64;
    const base = new Uint8Array(w * h);
    const noisy = new Uint8Array(w * h);
    const other = new Uint8Array(w * h);
    for (let i = 0; i < base.length; i++) {
      base[i] = (i * 7) % 256;
      noisy[i] = Math.min(255, base[i] + (Math.random() * 10 - 5));
      other[i] = (i * 37 + 11) % 256;
    }
    const sNoisy = ssimGray(base, noisy, w, h);
    const sOther = ssimGray(base, other, w, h);
    expect(sNoisy).toBeGreaterThan(0.9);
    expect(sOther).toBeLessThan(sNoisy);
  });
  it('grayFromImageData BT.601', () => {
    const g = grayFromImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
    expect(g[0]).toBe(76);
    expect(g[1]).toBe(150);
  });
});

describe('lineDiff', () => {
  it('新增/删除/相同', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc');
    const add = d.find((x) => x.type === 'add');
    const del = d.find((x) => x.type === 'del');
    expect(add.lines.join()).toContain('x');
    expect(del.lines.join()).toContain('b');
  });
  it('空白归一化后视为相同', () => {
    const d = lineDiff('hello   world', 'hello world');
    expect(d.every((x) => x.type === 'same')).toBe(true);
  });
  it('pageTextDiffs 汇总', () => {
    const r = pageTextDiffs([{ pageA: 0, pageB: 0, textA: 'a\nb', textB: 'a\nc' }]);
    expect(r[0].added).toBe(1);
    expect(r[0].removed).toBe(1);
    expect(r[0].same).toBe(false);
  });
});

describe('compress-planner', () => {
  it('候选生成与去重', () => {
    const plan = planCandidates({ smart: true, raster: true, structural: true }, 10e6, 2e6);
    const ids = plan.map((c) => candidateId(c.mode, c.params));
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.some((c) => c.mode === 'structural')).toBe(true);
  });
  it('精搜不重复已试候选', () => {
    const tried = new Set();
    const best = { mode: 'smart', params: { scale: 0.6, q: 54 } };
    tried.add(candidateId(best.mode, best.params));
    const refs = refineCandidates(best, tried);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(candidateId(r.mode, r.params)).not.toBe(candidateId(best.mode, best.params));
  });
  it('pickBest：达标优先质量，未达标回退最小', () => {
    const rows = [
      { id: 'a', ok: true, size: 900, ssim: 0.97 },
      { id: 'b', ok: true, size: 800, ssim: 0.95 },
      { id: 'c', ok: true, size: 700, ssim: 0.70 },
      { id: 'd', ok: false, size: 100, ssim: null },
    ];
    const r = pickBest(rows, { targetBytes: 1000, minSsim: 0.9 });
    expect(r.bestId).toBe('a'); // 质量最高
    expect(r.minId).toBe('c');
    const r2 = pickBest(rows, { targetBytes: 850, minSsim: 0.9 });
    expect(r2.bestId).toBe('b'); // 900 超目标、700 质量不足，只有 b 达标
    const r3 = pickBest(rows, { targetBytes: 100, minSsim: 0.99 });
    expect(r3.bestId).toBe(null);
    expect(r3.minId).toBe('c');
  });
  it('labelOf 可读', () => {
    expect(labelOf('smart', { scale: 0.7, q: 60 })).toContain('70%');
    expect(labelOf('raster', { dpi: 120, q: 80 })).toContain('120DPI');
  });
});

describe('format 安全渲染', () => {
  it('esc 阻断 XSS', () => {
    expect(esc('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(esc('')).toBe('');
  });
  it('sanitizeFilename', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFilename('a*b?c<d')).toBe('a_b_c_d');
    expect(sanitizeFilename('')).toBe('未命名');
  });
  it('fmtBytes', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(null)).toBe('—');
  });
});

describe('history 脱敏', () => {
  it('移除敏感键', () => {
    const c = sanitizeOptions({ userPassword: 'x', ownerPassword: 'y', dpi: 200, note: null });
    expect(Object.keys(c)).toEqual(['dpi', 'note']);
  });
});
