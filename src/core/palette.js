// 区块调色板（多巴胺配色中枢）：把六个「区块颜色槽」派生为全套 CSS 语义变量。
// settings.palette = { primary, side, top, bg, card, hi }（十六进制，亮色形态；槽位 null = 跟随主题默认）。
// 右下角 🎨 浮钮单击 = randomizePalette() 一键随机全部区块；双击 = 清除恢复默认。
// 亮/暗两版都在这里派生：暗色不直接使用用户选的浅色 hex，而是按同色相做深色适配（防刺眼）。

/** 多巴胺色池（tailwind 500/600 系，id 与 main.js 的 seed 记录有关联但可独立演化） */
export const DOPAMINE_HUES = [
  { id: 'candy', hex: '#ec4899' },
  { id: 'coral', hex: '#f43f5e' },
  { id: 'citrus', hex: '#f97316' },
  { id: 'mango', hex: '#eab308' },
  { id: 'lime', hex: '#65a30d' },
  { id: 'emerald', hex: '#10b981' },
  { id: 'teal', hex: '#14b8a6' },
  { id: 'sky', hex: '#0ea5e9' },
  { id: 'blue', hex: '#3b82f6' },
  { id: 'grape', hex: '#8b5cf6' },
  { id: 'fuchsia', hex: '#d946ef' },
  { id: 'red', hex: '#ef4444' },
];

export const PALETTE_SLOTS = ['primary', 'side', 'top', 'bg', 'card', 'hi'];

/** 本模块可能写入的全部 CSS 变量键（applyTheme 清除 inline 时用） */
export const PALETTE_VAR_KEYS = [
  '--primary', '--primary-hover', '--primary-soft', '--primary-foreground', '--ring',
  '--side-bg', '--top-bg', '--background', '--card', '--card-hover', '--popover', '--accent', '--accent-foreground',
];

// ---- 颜色工具（hex ↔ hsl；h/s/l 取 0-360 / 0-100 / 0-100） ----

export function hex2hsl(hex) {
  let m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return rgb2hsl(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  m = /^#?([0-9a-f]{3})$/i.exec(String(hex || '').trim());
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16) / 255);
    return rgb2hsl(r, g, b);
  }
  return null;
}

function rgb2hsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hsl2hex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 把 hex 朝黑/白方向按百分比混合（amt 0-100，正数朝 target） */
function mixHex(hex, target, amt) {
  const a = hex2hsl(hex);
  const t = target === '#000000' ? 0 : 100;
  return hsl2hex(a.h, a.s, a.l + (t - a.l) * (amt / 100));
}

// ---- 随机生成（六槽联动，保底协调） ----

function pick(arr, except) {
  const pool = except != null ? arr.filter((x) => x !== except) : arr;
  return pool[Math.floor(Math.random() * pool.length)];
}

function companionHue(h) {
  const r = Math.random();
  if (r < 0.45) return h;                     // 同色系：最稳
  if (r < 0.8) return h + pick([36, -36, 52, -52, 64, -64], null); // 邻近色：活力
  return h + pick([152, -152, 180, 208, -208], null);              // 对撞：多巴胺
}

/**
 * 一键随机全部区块配色。
 * @param {string} [prevSeed] 上一次的 seed（避开主色重复）
 * @returns {{seed:string, slots:{primary:string,side:string,top:string,bg:string,card:string,hi:string}}}
 */
export function randomizePalette(prevSeed) {
  const prevMain = String(prevSeed || '').split('|')[0];
  const main = pick(DOPAMINE_HUES.map((x) => x.id), prevMain || null);
  const mainHex = DOPAMINE_HUES.find((x) => x.id === main).hex;
  const { h, s } = hex2hsl(mainHex);
  const h2 = companionHue(h);
  const slots = {
    primary: mainHex,
    bg: hsl2hex(h, Math.min(s, 62), 98.3),
    card: hsl2hex(h, 42, 99.2),
    side: hsl2hex(h2, 72, 96.2),
    top: hsl2hex(h, 55, 97.5),
    hi: hsl2hex(h2, 78, 93.5),
  };
  return { seed: `${main}|${((h2 % 360) + 360) % 360 | 0}`, slots };
}

// ---- 槽位 → CSS 变量（亮/暗两版派生） ----

/**
 * @param {{primary?:string|null, side?:string|null, top?:string|null, bg?:string|null, card?:string|null, hi?:string|null}} p
 * @param {boolean} dark 当前是否暗色主题
 * @returns {Object<string,string>} 可直接 setProperty 的语义变量表（只含已设置槽位的派生）
 */
export function paletteCssVars(p, dark) {
  const out = {};
  if (!p) return out;
  const set = (k, v) => { if (v) out[k] = v; };

  const hOf = (hex) => (hex2hsl(hex) || { h: 258, s: 80 }).h;
  const sOf = (hex) => (hex2hsl(hex) || { h: 258, s: 80, l: 50 }).s;

  if (p.primary) {
    const hsl = hex2hsl(p.primary) || { h: 258, s: 80, l: 50 };
    const { h, s, l } = hsl;
    if (dark) {
      // 暗色：主色提亮到可读区间（深底上的按钮/链接需要较高 L）
      const lp = Math.max(l, 62);
      set('--primary', hsl2hex(h, s, lp));
      set('--primary-foreground', lp > 66 ? hsl2hex(h, 65, 12) : '#ffffff');
      set('--primary-hover', hsl2hex(h, Math.min(s, 90), Math.min(88, lp + 12)));
      set('--primary-soft', hsl2hex(h, 62, 15));
      set('--ring', hsl2hex(h, s, Math.min(90, lp + 6)));
    } else {
      set('--primary', p.primary);
      set('--primary-foreground', l > 62 ? hsl2hex(h, 60, 12) : '#ffffff');
      set('--primary-hover', hsl2hex(h, s, Math.max(24, l - 9)));
      set('--primary-soft', hsl2hex(h, Math.min(95, s + 8), 93));
      set('--ring', p.primary);
    }
  }
  if (p.side) set('--side-bg', dark ? hsl2hex(hOf(p.side), 32, 10) : p.side);
  if (p.top) set('--top-bg', dark ? hsl2hex(hOf(p.top), 32, 11) : p.top);
  if (p.bg) set('--background', dark ? hsl2hex(hOf(p.bg), 38, 7) : p.bg);
  if (p.card) {
    if (dark) {
      const c = hsl2hex(hOf(p.card), 30, 12);
      set('--card', c);
      set('--popover', c);
      set('--card-hover', hsl2hex(hOf(p.card), 30, 15));
    } else {
      set('--card', p.card);
      set('--popover', p.card);
      set('--card-hover', mixHex(p.card, '#000000', 3));
    }
  }
  if (p.hi) {
    if (dark) {
      set('--accent', hsl2hex(hOf(p.hi), 45, 16));
      set('--accent-foreground', hsl2hex(hOf(p.hi), 80, 84));
    } else {
      set('--accent', p.hi);
      set('--accent-foreground', hsl2hex(hOf(p.hi), Math.max(45, sOf(p.hi)), 24));
    }
  }
  return out;
}
