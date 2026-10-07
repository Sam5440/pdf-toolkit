// 区块调色板单测：hex/hsl 往返、一键随机结构、六槽 → CSS 变量派生（亮/暗）
import { describe, it, expect } from 'vitest';
import {
  hex2hsl, hsl2hex, randomizePalette, paletteCssVars, PALETTE_VAR_KEYS, DOPAMINE_HUES,
} from '../../src/core/palette.js';

describe('颜色工具', () => {
  it('hex ↔ hsl 往返（多巴胺池全部色值）', () => {
    for (const { hex } of DOPAMINE_HUES) {
      const { h, s, l } = hex2hsl(hex);
      const back = hsl2hex(h, s, l);
      // 派生误差允许 ±2/255 每通道（等价 hex 逐位差 ≤ 0x020202 掩码内）
      const a = parseInt(hex.slice(1), 16), b = parseInt(back.slice(1), 16);
      const dr = Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
      const dg = Math.abs(((a >> 8) & 255) - ((b >> 8) & 255));
      const db = Math.abs((a & 255) - (b & 255));
      expect(Math.max(dr, dg, db), `${hex} → ${back}`).toBeLessThanOrEqual(4);
    }
  });

  it('非法输入返回 null / 安全值', () => {
    expect(hex2hsl('nope')).toBeNull();
    expect(hex2hsl('')).toBeNull();
    expect(hsl2hex(400, 120, 150)).toMatch(/^#[0-9a-f]{6}$/); // 越界被钳制
  });
});

describe('一键随机（多巴胺）', () => {
  it('六槽齐全且都是合法 hex', () => {
    const { seed, slots } = randomizePalette('');
    expect(seed).toMatch(/^[a-z]+\|\d+$/);
    for (const k of ['primary', 'side', 'top', 'bg', 'card', 'hi']) {
      expect(slots[k]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(DOPAMINE_HUES.some((x) => x.hex === slots.primary)).toBe(true);
  });

  it('主色避开上一次的 seed', () => {
    const prev = randomizePalette('');
    const seen = new Set([prev.seed.split('|')[0]]);
    for (let i = 0; i < 40; i++) {
      const next = randomizePalette(prev.seed);
      expect(next.seed.split('|')[0]).not.toBe(prev.seed.split('|')[0]);
    }
  });

  it('背景/卡片保持近白（浅色可读），侧边栏/高亮有染色', () => {
    for (let i = 0; i < 12; i++) {
      const { slots } = randomizePalette('');
      const bg = hex2hsl(slots.bg), card = hex2hsl(slots.card);
      expect(bg.l).toBeGreaterThanOrEqual(97);
      expect(card.l).toBeGreaterThanOrEqual(98);
      expect(hex2hsl(slots.side).l).toBeLessThanOrEqual(97);
      expect(hex2hsl(slots.hi).l).toBeLessThanOrEqual(95);
    }
  });
});

describe('槽位 → CSS 变量派生', () => {
  it('浅色：主色槽派生 primary/hover/soft/ring/foreground', () => {
    const vars = paletteCssVars({ primary: '#2563eb' }, false);
    expect(vars['--primary']).toBe('#2563eb');
    expect(vars['--primary-hover']).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars['--ring']).toBe('#2563eb');
    expect(Object.keys(vars)).toHaveLength(5);
  });

  it('只派生设置过的槽；空对象/null 不产生任何变量', () => {
    expect(paletteCssVars({}, false)).toEqual({});
    expect(paletteCssVars(null, false)).toEqual({});
    const only = paletteCssVars({ side: '#e0f2fe' }, false);
    expect(Object.keys(only)).toEqual(['--side-bg']);
  });

  it('暗色：背景/卡片转深色（亮度 ≤ 16），主色提亮', () => {
    const vars = paletteCssVars({
      primary: '#2563eb', bg: '#eef6ff', card: '#ffffff', side: '#e0f2fe', hi: '#bae6fd',
    }, true);
    expect(hex2hsl(vars['--background']).l).toBeLessThanOrEqual(16);
    expect(hex2hsl(vars['--card']).l).toBeLessThanOrEqual(16);
    expect(hex2hsl(vars['--side-bg']).l).toBeLessThanOrEqual(16);
    expect(hex2hsl(vars['--primary']).l).toBeGreaterThanOrEqual(62);
    expect(hex2hsl(vars['--accent']).l).toBeLessThanOrEqual(20);
  });

  it('派生键都在 PALETTE_VAR_KEYS 白名单内（applyTheme 可完整清除）', () => {
    const vars = paletteCssVars(randomizePalette('').slots, true);
    for (const k of Object.keys(vars)) expect(PALETTE_VAR_KEYS).toContain(k);
    const full = paletteCssVars({
      primary: '#000', side: '#000', top: '#000', bg: '#000', card: '#000', hi: '#000',
    }, false);
    for (const k of Object.keys(full)) expect(PALETTE_VAR_KEYS).toContain(k);
  });
});
