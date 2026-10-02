// Markdown 富渲染（主线程）：数学公式（KaTeX）/ Mermaid 图形 / markmap 思维导图 / data-URL 图片
// 全部离线栅格化为 PNG（base64 + pt 尺寸），交引擎 text.toPdf 排版嵌入。
//
// 纯函数 splitInlineMath / parseMarkdownRich 不触碰 DOM / document / window（vitest node 环境可独立 import）；
// 所有 DOM 与 katex / mermaid / markmap 的动态 import 全部位于 renderRichBlocks 及其内部助手函数体内。
// KaTeX 字体离线化：静态引入 katex.min.css 原文与全部 woff2 资产 URL（vite ?raw / ?url），
// 运行时 fetch → base64 data URL 替换，得到自包含 CSS 供 foreignObject 内嵌。
import { marked } from 'marked';
import katexCssRaw from 'katex/dist/katex.min.css?raw';
import font_AMS from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?url';
import font_CaliB from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?url';
import font_Cali from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?url';
import font_FrakB from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?url';
import font_Frak from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?url';
import font_MainB from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?url';
import font_MainBI from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?url';
import font_MainI from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?url';
import font_Main from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import font_MathBI from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?url';
import font_MathI from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?url';
import font_SansB from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?url';
import font_SansI from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?url';
import font_Sans from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?url';
import font_Script from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?url';
import font_Size1 from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?url';
import font_Size2 from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?url';
import font_Size3 from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?url';
import font_Size4 from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?url';
import font_Typo from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?url';

/** 像素/pt 基准倍率（公式与图片栅格化密度） */
export const RS = 3;
/** Mermaid / 思维导图 SVG 输出的质量倍率 */
export const QS = 2;
/** 与 engine-more.js tpFont 一致的正文族（基线测量需与渲染字体一致） */
export const BODY_FONT = "'pdftoolkit-cjk', 'PingFang SC', 'Microsoft YaHei', sans-serif";

const KATEX_FONT_URLS = {
  'KaTeX_AMS-Regular': font_AMS,
  'KaTeX_Caligraphic-Bold': font_CaliB,
  'KaTeX_Caligraphic-Regular': font_Cali,
  'KaTeX_Fraktur-Bold': font_FrakB,
  'KaTeX_Fraktur-Regular': font_Frak,
  'KaTeX_Main-Bold': font_MainB,
  'KaTeX_Main-BoldItalic': font_MainBI,
  'KaTeX_Main-Italic': font_MainI,
  'KaTeX_Main-Regular': font_Main,
  'KaTeX_Math-BoldItalic': font_MathBI,
  'KaTeX_Math-Italic': font_MathI,
  'KaTeX_SansSerif-Bold': font_SansB,
  'KaTeX_SansSerif-Italic': font_SansI,
  'KaTeX_SansSerif-Regular': font_Sans,
  'KaTeX_Script-Regular': font_Script,
  'KaTeX_Size1-Regular': font_Size1,
  'KaTeX_Size2-Regular': font_Size2,
  'KaTeX_Size3-Regular': font_Size3,
  'KaTeX_Size4-Regular': font_Size4,
  'KaTeX_Typewriter-Regular': font_Typo,
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** bytes → base64（分块 fromCharCode.apply，避免大 buffer 栈溢出） */
export function bytesToBase64(u8) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// 行内数学切分（纯函数）
// ---------------------------------------------------------------------------

/** 在 from 起找下一个未转义的 `$`（`\$` 不算定界符） */
function findClosingDollar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '$') return j;
  }
  return -1;
}

/**
 * 把文本按行内数学定界符切分为混合数组：
 * - 文字段 [{t:'s', v:'文字'}]（相邻合并）
 * - 数学段 [{t:'m', tex:'...'}]，支持 `$...$`（非贪婪、内容非空、`\$` 转义）、`$$...$$` 与 `\(...\)`
 * 孤立 `$`（无配对）保持原文字。负号（`$-1$`）与 CJK 紧邻（`$x^2$系数`）均正确。
 */
export function splitInlineMath(text) {
  const s = String(text ?? '');
  const segs = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { segs.push({ t: 's', v: buf }); buf = ''; } };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '$') { buf += '$'; i += 2; continue; } // 转义美元
    if (ch === '\\' && s[i + 1] === '(') {
      const end = s.indexOf('\\)', i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        segs.push({ t: 'm', tex: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '$') {
      if (s[i + 1] === '$') { // 行内 $$ 对
        const end = s.indexOf('$$', i + 2);
        if (end !== -1 && end > i + 2) {
          flush();
          segs.push({ t: 'm', tex: s.slice(i + 2, end) });
          i = end + 2;
          continue;
        }
      } else {
        const end = findClosingDollar(s, i + 1);
        if (end !== -1 && end > i + 1) {
          flush();
          segs.push({ t: 'm', tex: s.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return segs;
}

// ---------------------------------------------------------------------------
// Markdown → 富块模型（纯函数）
// ---------------------------------------------------------------------------

const LIST_MARKERS = ['•', '◦', '▪'];

/** 在 from 起找下一个未转义的 `$`（`\$` 不算定界符）——与 splitInlineMath 同规则，供预提取复用 */
function findClosingDollarLine(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '$') return j;
  }
  return -1;
}

/**
 * 预提取数学片段（$...$ / $$...$$ / \(...\)，跳过 fenced code），替换为纯字母数字占位符。
 * marked 会把 LaTeX 转义（\, \{ \; 等）当 Markdown escape 吞掉反斜杠——先藏起来，展平后再还原。
 */
function stashMathSpans(src) {
  const stash = [];
  const placeholder = (content) => {
    stash.push(content);
    return `zzmdmath${stash.length - 1}zz`;
  };
  const lines = String(src ?? '').split('\n');
  const outLines = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let displayOpen = false;
  let displayBuf = '';
  for (const line of lines) {
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (displayOpen) {
      const end = line.indexOf('$$');
      if (end === -1) { displayBuf += `${line}\n`; continue; }
      displayBuf += line.slice(0, end);
      outLines[outLines.length - 1] += placeholder(`$$${displayBuf}$$`) + line.slice(end + 2);
      displayOpen = false;
      continue;
    }
    if (inFence) {
      outLines.push(line);
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) { inFence = false; }
      continue;
    }
    if (fm) {
      inFence = true;
      fenceChar = fm[1][0];
      fenceLen = fm[1].length;
      outLines.push(line);
      continue;
    }
    let res = '';
    let i = 0;
    let brokeDisplay = false;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\' && line[i + 1] === '$') { res += line.slice(i, i + 2); i += 2; continue; }
      if (ch === '\\' && line[i + 1] === '(') {
        const end = line.indexOf('\\)', i + 2);
        if (end !== -1 && end > i + 2) { res += placeholder(line.slice(i, end + 2)); i = end + 2; continue; }
      }
      if (ch === '$' && line[i + 1] === '$') {
        const end = line.indexOf('$$', i + 2);
        if (end !== -1 && end > i + 2) { res += placeholder(line.slice(i, end + 2)); i = end + 2; continue; }
        displayOpen = true; // 同行无闭合 → 跨行 display 数学
        displayBuf = line.slice(i + 2);
        brokeDisplay = true;
        break;
      }
      if (ch === '$') {
        const end = findClosingDollarLine(line, i + 1);
        if (end !== -1 && end > i + 1) { res += placeholder(line.slice(i, end + 1)); i = end + 1; continue; }
      }
      res += ch;
      i++;
    }
    outLines.push(res);
    if (brokeDisplay) outLines.push(''); // display 起始行：占位符稍后追加到末行
  }
  return { text: outLines.join('\n'), stash };
}

/** 还原占位符为原始数学片段 */
function restoreMathStash(s, stash) {
  return String(s ?? '').replace(/zzmdmath(\d+)zz/g, (m0, idx) => stash[Number(idx)] ?? m0);
}

/**
 * marked.lexer 解析 Markdown 为扩展块模型：
 * {type:'h1'|'h2'|'h3'|'p'|'li'|'quote'|'code'|'hr'|'pagebreak'|'table', text?/rows?/segs?/level?/marker?}
 * 图形块 {type:'img', kind:'mermaid'|'mindmap'|'math'|'image', code?/tex?/src?/display?}
 * 返回 { title?, blocks, warnings }。
 */
export function parseMarkdownRich(text) {
  const { text: stashed, stash } = stashMathSpans(String(text ?? '').replace(/\r\n?/g, '\n'));
  const tokens = marked.lexer(stashed);
  const blocks = [];
  const warnings = [];
  let title = null;

  /** 行内 token 展平为纯文本（em/strong/link 只取文本，codespan 保留反引号原文），图片 token 收集进 imgs */
  const inlineTextRaw = (toks, imgs) => {
    let out = '';
    for (const tk of toks ?? []) {
      switch (tk.type) {
        case 'text': out += tk.tokens ? inlineText(tk.tokens, imgs) : (tk.text ?? tk.raw ?? ''); break;
        case 'escape': out += tk.text ?? ''; break;
        case 'em': case 'strong': case 'del': case 'link': out += inlineText(tk.tokens, imgs); break;
        case 'codespan': out += `\`${tk.text ?? ''}\``; break;
        case 'br': out += '\n'; break;
        case 'image': imgs?.push(tk); break;
        case 'html': break; // 行内 HTML 丢弃
        default: out += tk.text ?? tk.raw ?? ''; break;
      }
    }
    return out;
  };
  /** 展平后还原数学占位符（占位符为纯字母数字，marked 不会改写） */
  const inlineText = (toks, imgs) => restoreMathStash(inlineTextRaw(toks, imgs), stash);

  const pushImage = (im) => {
    const src = im.href ?? im.src ?? '';
    if (/^data:/i.test(src)) blocks.push({ type: 'img', kind: 'image', src });
    else warnings.push(`离线模式不抓取远程图片: ${src}`);
  };

  /** 段落/标题/列表项文本块：含数学 → segs，否则 → text（向后兼容） */
  const pushTextBlock = (type, txt, extra) => {
    const t = String(txt ?? '').replace(/\s+\n/g, '\n');
    if (!t.trim()) return;
    const segs = splitInlineMath(t);
    if (segs.some((sg) => sg.t === 'm')) blocks.push({ type, segs, ...extra });
    else blocks.push({ type, text: t, ...extra });
  };

  /** 段落：整段仅一张图 → 图片块；整段仅一个 $$...$$ → display 数学块；其余行内处理 */
  const pushParagraph = (token) => {
    const imgs = [];
    const txt = inlineText(token.tokens ?? [], imgs);
    if (imgs.length && !txt.trim()) {
      imgs.forEach(pushImage);
      return;
    }
    for (const im of imgs) pushImage(im); // 行内混排图片按远程/跳过处理
    const t = txt.trim();
    const dm = /^\$\$([\s\S]+)\$\$$/.exec(t);
    if (dm && !dm[1].includes('$$')) {
      blocks.push({ type: 'img', kind: 'math', tex: dm[1].trim(), display: true });
      return;
    }
    pushTextBlock('p', txt);
  };

  /** 列表：嵌套扁平化，level 从 0 起；无序 marker 按层级 •/◦/▪，有序 null */
  const walkList = (token, level) => {
    for (const item of token.items ?? []) {
      const parts = [];
      for (const tk of item.tokens ?? []) {
        if (tk.type === 'list') continue; // 嵌套列表单独递归
        if (tk.type === 'text' || tk.type === 'paragraph') {
          const imgs = [];
          const t = inlineText(tk.tokens ?? [], imgs);
          if (t.trim()) parts.push(t);
        }
      }
      const extra = { level, marker: token.ordered ? null : LIST_MARKERS[Math.min(level, LIST_MARKERS.length - 1)] };
      pushTextBlock('li', parts.join(' '), extra);
      for (const tk of item.tokens ?? []) {
        if (tk.type === 'list') walkList(tk, level + 1);
      }
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const imgs = [];
        const txt = inlineText(token.tokens ?? [], imgs);
        for (const im of imgs) pushImage(im);
        if (token.depth === 1 && title == null && txt.trim()) title = txt.trim();
        pushTextBlock(`h${Math.min(3, Math.max(1, token.depth))}`, txt);
        break;
      }
      case 'paragraph': pushParagraph(token); break;
      case 'list': walkList(token, 0); break;
      case 'blockquote': {
        const parts = [];
        for (const tk of token.tokens ?? []) {
          if (tk.type === 'paragraph' || tk.type === 'text') {
            const imgs = [];
            const t = inlineText(tk.tokens ?? [], imgs);
            if (t.trim()) parts.push(t.trim());
          }
        }
        if (parts.length) blocks.push({ type: 'quote', text: parts.join('\n') });
        break;
      }
      case 'code': {
        const lang = String(token.lang ?? '').trim().toLowerCase();
        if (lang === 'mermaid') blocks.push({ type: 'img', kind: 'mermaid', code: token.text ?? '' });
        else if (lang === 'mindmap' || lang === 'markmap') blocks.push({ type: 'img', kind: 'mindmap', code: token.text ?? '' });
        else if (lang === 'math' || lang === 'latex') blocks.push({ type: 'img', kind: 'math', tex: token.text ?? '' });
        else blocks.push({ type: 'code', text: token.text ?? '' });
        break;
      }
      case 'table': {
        const cellText = (c) => (c && typeof c === 'object' ? inlineText(c.tokens ?? [], null) : String(c ?? ''));
        const rows = [
          (token.header ?? []).map(cellText),
          ...(token.rows ?? []).map((r) => (r ?? []).map(cellText)),
        ].filter((r) => r.length);
        if (rows.length) blocks.push({ type: 'table', rows });
        break;
      }
      case 'hr': blocks.push({ type: 'hr' }); break;
      case 'image': pushImage(token); break;
      case 'html':
        warnings.push(`跳过 HTML 块: ${String(token.raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}`);
        break;
      case 'space': break;
      default: break;
    }
  }
  return { title: title ?? undefined, blocks, warnings };
}

// ---------------------------------------------------------------------------
// 富块渲染（主线程 DOM）：img 块与 segs 内数学原子 → PNG base64
// ---------------------------------------------------------------------------

/** SVG 字符串（必须带显式 width/height）→ Image → canvas → PNG {bytes, b64}。
 *  warmup=true 时解码两次：第一次预热 SVG 内嵌 data URL 字体缓存，保证第二次栅格化字形正确。 */
async function svgToPng(svgStr, wPx, hPx, { warmup = false } = {}) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
  const load = async () => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  };
  const first = await load();
  const img = warmup ? await load() : first;
  const canvas = document.createElement('canvas');
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, wPx, hPx);
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas.toBlob 失败'))), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, b64: bytesToBase64(bytes) };
}

/** KaTeX 自包含 CSS（字体 → data URL），模块级惰性缓存 */
let katexCssPromise = null;
function getKatexCss() {
  if (!katexCssPromise) {
    katexCssPromise = (async () => {
      let css = katexCssRaw;
      await Promise.all(Object.entries(KATEX_FONT_URLS).map(async ([name, url]) => {
        const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
        css = css.split(`fonts/${name}.woff2`).join(`data:font/woff2;base64,${bytesToBase64(buf)}`);
      }));
      return css;
    })().catch((err) => { katexCssPromise = null; throw err; });
  }
  return katexCssPromise;
}

/** 把 KaTeX CSS（含 data URL 字体）装入 head 并预加载全部字体面。
 *  必须在测量前完成：否则测量与 SVG 栅格化都会用回退字体，公式被截断/变形。 */
let katexFontsReady = null;
function installKatexFonts() {
  if (!katexFontsReady) {
    katexFontsReady = (async () => {
      const css = await getKatexCss();
      const st = document.createElement('style');
      st.setAttribute('data-katex-rich-render', '');
      st.textContent = css;
      document.head.appendChild(st);
      const SPECS = [
        'normal 400 16px KaTeX_AMS',
        'normal 400 16px KaTeX_Caligraphic', 'normal 700 16px KaTeX_Caligraphic',
        'normal 400 16px KaTeX_Fraktur', 'normal 700 16px KaTeX_Fraktur',
        'normal 400 16px KaTeX_Main', 'normal 700 16px KaTeX_Main',
        'italic 400 16px KaTeX_Main', 'italic 700 16px KaTeX_Main',
        'italic 400 16px KaTeX_Math', 'italic 700 16px KaTeX_Math',
        'normal 400 16px KaTeX_SansSerif', 'normal 700 16px KaTeX_SansSerif', 'italic 400 16px KaTeX_SansSerif',
        'normal 400 16px KaTeX_Script',
        'normal 400 16px KaTeX_Size1', 'normal 400 16px KaTeX_Size2',
        'normal 400 16px KaTeX_Size3', 'normal 400 16px KaTeX_Size4',
        'normal 400 16px KaTeX_Typewriter',
      ];
      await Promise.all(SPECS.map((s) => document.fonts.load(s, 'Ax1=').catch(() => {})));
      await document.fonts.ready;
    })().catch((err) => { katexFontsReady = null; throw err; });
  }
  return katexFontsReady;
}

/**
 * KaTeX tex → PNG。测量（隐藏但不 display:none 的容器）→ foreignObject SVG（内嵌自包含 CSS）→ PNG。
 * inline=true 时额外测 baselinePt（数学原子顶到文本基线的距离，pt）。
 * 返回 { b64, wPt, hPt, baselinePt? }（px/RS = pt）。
 */
async function katexPng(tex, { displayMode = false, fontSizePt = 11, inline = false } = {}) {
  const katex = (await import('katex')).default;
  await installKatexFonts(); // 字体就绪后测量/栅格化才准确
  const css = await getKatexCss();
  const html = katex.renderToString(tex, { displayMode, output: 'html', throwOnError: false });
  const px = fontSizePt * RS;
  const holder = document.createElement('div');
  holder.setAttribute('style', `position:fixed;left:-99999px;top:0;visibility:hidden;white-space:nowrap;line-height:normal;`);
  const ref = document.createElement('span');
  ref.setAttribute('style', `font:${px}px ${BODY_FONT}`);
  ref.textContent = 'H';
  holder.appendChild(ref);
  const box = document.createElement('span');
  box.setAttribute('style', `font-size:${px}px;display:inline-block;`);
  box.innerHTML = html;
  holder.appendChild(box);
  document.body.appendChild(holder);
  let w, h, baselinePt;
  try {
    w = Math.max(2, Math.ceil(box.offsetWidth) + 2);
    h = Math.max(2, Math.ceil(box.offsetHeight) + 2);
    if (inline) {
      const kSpan = box.querySelector('.katex') ?? box;
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${px}px ${BODY_FONT}`;
      const ascent = ctx.measureText('H').fontBoundingBoxAscent || px * 0.8;
      const refTop = ref.getBoundingClientRect().top;
      const mathTop = kSpan.getBoundingClientRect().top;
      baselinePt = clamp((refTop + ascent - mathTop) / RS, 0, h / RS);
    }
  } finally {
    holder.remove();
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>`
    + `<span style="font-size:${px}px;display:inline-block;">${html}</span></div></foreignObject></svg>`;
  const { b64 } = await svgToPng(svg, w, h, { warmup: true });
  return inline ? { b64, wPt: w / RS, hPt: h / RS, baselinePt } : { b64, wPt: w / RS, hPt: h / RS };
}

/** 重写 SVG 根标签尺寸：按 viewBox × scale 设 width/height，去掉 max-width（属性不可重复，viewBox 以现有为准） */
function rescaleSvg(svgStr, scale) {
  const vbM = /viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(svgStr);
  const vx = vbM ? parseFloat(vbM[1]) : 0;
  const vy = vbM ? parseFloat(vbM[2]) : 0;
  const vw = vbM ? parseFloat(vbM[3]) : 600;
  const vh = vbM ? parseFloat(vbM[4]) : 400;
  const wPx = Math.max(2, Math.round(vw * scale));
  const hPx = Math.max(2, Math.round(vh * scale));
  const open = /<svg[^>]*>/.exec(svgStr);
  if (!open) throw new Error('SVG 缺少根元素');
  let attrs = open[0].slice(4, -1);
  attrs = attrs.replace(/\s(width|height|viewBox)="[^"]*"/g, '');
  attrs = attrs.replace(/\sstyle="([^"]*)"/g, (m0, s0) => ` style="${s0.replace(/max-width:[^;"']*/g, '')}"`);
  attrs += ` width="${wPx}" height="${hPx}" viewBox="${vx} ${vy} ${vw} ${vh}"`;
  return { svg: svgStr.slice(0, open.index) + `<svg${attrs}>` + svgStr.slice(open.index + open[0].length), wPx, hPx, wPt: vw, hPt: vh };
}

let mermaidReady = null;
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'neutral' });
      return mermaid;
    })().catch((err) => { mermaidReady = null; throw err; });
  }
  return mermaidReady;
}

let mermaidSeq = 0;
/** Mermaid code → SVG（自增 id）→ 强制尺寸 ×QS → PNG */
async function mermaidPng(code) {
  const mermaid = await getMermaid();
  const id = `mmd-svg-${++mermaidSeq}`;
  const { svg } = await mermaid.render(id, code);
  const n = rescaleSvg(svg, QS);
  const { b64 } = await svgToPng(n.svg, n.wPx, n.hPx);
  return { b64, wPt: n.wPt, hPt: n.hPt };
}

/** markmap 思维导图 code → 挂载渲染 → bbox 重设尺寸 ×QS → PNG */
async function markmapPng(code) {
  const { Transformer } = await import('markmap-lib');
  const { Markmap } = await import('markmap-view');
  const { root } = new Transformer().transform(code);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '1000');
  svg.setAttribute('height', '700');
  svg.setAttribute('style', 'position:fixed;left:-99999px;top:0;visibility:hidden');
  document.body.appendChild(svg);
  try {
    const mm = Markmap.create(svg, { duration: 0, initialExpandLevel: -1 });
    mm.setData(root);
    mm.fit();
    // markmap 外链样式在序列化后的独立 SVG 文档中失效：把 head 中 markmap 样式克隆进 svg 内
    for (const st of document.querySelectorAll('head style')) {
      if ((st.textContent || '').includes('markmap')) {
        const cl = document.createElementNS(SVGNS, 'style');
        cl.textContent = st.textContent;
        svg.appendChild(cl);
      }
    }
    await new Promise((r) => requestAnimationFrame(r));
    const bbox = svg.getBBox();
    const pad = 10;
    const wPt = Math.max(2, Math.ceil(bbox.width) + pad * 2);
    const hPt = Math.max(2, Math.ceil(bbox.height) + pad * 2);
    svg.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${wPt} ${hPt}`);
    svg.setAttribute('width', String(wPt * QS));
    svg.setAttribute('height', String(hPt * QS));
    svg.removeAttribute('style'); // 序列化进独立 SVG 文档前去掉 offscreen 定位样式（visibility:hidden 会带进图片导致空白）
    const svgStr = new XMLSerializer().serializeToString(svg);
    const { b64 } = await svgToPng(svgStr, wPt * QS, hPt * QS);
    return { b64, wPt, hPt };
  } finally {
    svg.remove();
  }
}

/** data: URL 图片 → 解码 → canvas → PNG */
async function dataUrlPng(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const w = Math.max(1, img.naturalWidth || 1);
  const h = Math.max(1, img.naturalHeight || 1);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas.toBlob 失败'))), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { b64: bytesToBase64(bytes), wPt: w / RS, hPt: h / RS };
}

/** 单个 img 块栅格化 */
async function renderImgBlock(b, fontSize) {
  if (b.kind === 'math') {
    const png = await katexPng(b.tex, { displayMode: !!b.display, fontSizePt: fontSize });
    return { type: 'img', kind: 'math', b64: png.b64, wPt: png.wPt, hPt: png.hPt };
  }
  if (b.kind === 'mermaid') {
    const png = await mermaidPng(b.code ?? '');
    return { type: 'img', kind: 'mermaid', b64: png.b64, wPt: png.wPt, hPt: png.hPt };
  }
  if (b.kind === 'mindmap') {
    const png = await markmapPng(b.code ?? '');
    return { type: 'img', kind: 'mindmap', b64: png.b64, wPt: png.wPt, hPt: png.hPt };
  }
  if (b.kind === 'image') {
    const png = await dataUrlPng(b.src);
    return { type: 'img', kind: 'image', b64: png.b64, wPt: png.wPt, hPt: png.hPt };
  }
  return b;
}

/**
 * 富块渲染入口：img 块与 segs 内数学原子就地栅格化（b64/wPt/hPt/baselinePt）。
 * 每块独立 try/catch：mermaid/mindmap 失败降级为原文 code 块，其余失败替换为错误提示 p 块——绝不让单块失败炸整体。
 * 返回 { blocks, warnings }。
 */
export async function renderRichBlocks(blocks, { fontSize = 11 } = {}) {
  const warnings = [];
  const out = [];
  for (const b of blocks) {
    try {
      if (b.type === 'img') {
        out.push(await renderImgBlock(b, fontSize));
        continue;
      }
      if (Array.isArray(b.segs)) {
        const segs = [];
        for (const seg of b.segs) {
          if (seg.t !== 'm') { segs.push(seg); continue; }
          try {
            const png = await katexPng(seg.tex, { displayMode: false, fontSizePt: fontSize, inline: true });
            segs.push({ t: 'm', tex: seg.tex, b64: png.b64, wPt: png.wPt, hPt: png.hPt, baselinePt: png.baselinePt });
          } catch (err) {
            warnings.push(`[公式渲染失败: ${err?.message || err}]`);
            segs.push({ t: 's', v: `$${seg.tex}$` });
          }
        }
        out.push({ ...b, segs });
        continue;
      }
      out.push(b);
    } catch (err) {
      const msg = err?.message || String(err);
      warnings.push(`[图形/公式渲染失败: ${msg}]`);
      if (b.type === 'img' && (b.kind === 'mermaid' || b.kind === 'mindmap')) {
        out.push({ type: 'code', text: b.code ?? '' });
      } else if (b.type === 'img') {
        out.push({ type: 'p', text: `[图形/公式渲染失败: ${msg}]` });
      } else {
        out.push(b);
      }
    }
  }
  return { blocks: out, warnings };
}
