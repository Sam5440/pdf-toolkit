// 代码块语法高亮 —— 参考三个开源实现后取的标准做法：
//  - md-to-pdf（simonhaenisch，MIT）与 markdown-pdf（alanshaw，MIT）均为 marked + highlight.js，
//    已知语言 hljs.highlight、未知语言降级纯文本；
//  - pandoc/skylighting（GPL-2.0+）为 token 级着色（KeywordTok/StringTok/CommentTok… 各映射颜色）。
// 这里用 highlight.js/core + 常用 25 语言，色板取 highlight.js 官方 github.css（GitHub Light，
// 与内置引擎代码底色 #f3f4f6 同源）；预览暗色用 GitHub Dark 覆盖（见 components.css）。
// 产出两种形态：highlightTokens → [{v,c}]（PDF/Word 引擎逐 token 着色）；highlightHtml → hljs-* span（预览）。
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import ini from 'highlight.js/lib/languages/ini';
import diff from 'highlight.js/lib/languages/diff';
import markdown from 'highlight.js/lib/languages/markdown';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import lua from 'highlight.js/lib/languages/lua';

const LANG_DEFS = {
  javascript, typescript, python, java, c, cpp, csharp, go, rust, bash,
  json, yaml, xml, css, scss, sql, php, ruby, kotlin, swift,
  ini, diff, markdown, dockerfile, lua,
};
for (const [name, def] of Object.entries(LANG_DEFS)) hljs.registerLanguage(name, def);

const AUTO_SUBSET = Object.keys(LANG_DEFS);

/** 围栏信息串 → 语言名（'js {1,3}' → 'js'；'' 表示无语言） */
export function normalizeLang(lang) {
  const m = String(lang ?? '').trim().toLowerCase().match(/^[\w+#.-]+/);
  return m ? m[0] : '';
}

// GitHub Light 色板（highlight.js src/styles/github.css，颜色取自 primer prettylights）
const CLASS_COLORS = {
  keyword: '#d73a49', doctag: '#d73a49', type: '#d73a49',
  'template-tag': '#d73a49', 'template-variable': '#d73a49',
  'variable language_': '#d73a49', 'meta keyword': '#d73a49',
  title: '#6f42c1',
  attr: '#005cc5', attribute: '#005cc5', literal: '#005cc5', meta: '#005cc5',
  number: '#005cc5', operator: '#005cc5', variable: '#005cc5', section: '#005cc5',
  'selector-attr': '#005cc5', 'selector-class': '#005cc5', 'selector-id': '#005cc5',
  string: '#032f62', regexp: '#032f62', 'meta string': '#032f62',
  built_in: '#e36209', symbol: '#e36209',
  comment: '#6a737d', quote: '#6a737d', formula: '#6a737d', code: '#6a737d',
  name: '#22863a', 'selector-tag': '#22863a', 'selector-pseudo': '#22863a', addition: '#22863a',
  deletion: '#b31d28',
  bullet: '#735c0f',
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body) => {
  if (body[0] === '#') {
    const num = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : m;
  }
  return ENTITIES[body] ?? m;
});

/**
 * hljs HTML 输出 → [{v, cls}]（v 为解码后原文，cls 为 hljs 类串或 ''）。
 * 迷你栈式解析：hljs 输出只含良构 span/文本/换行，无需 DOMParser（worker 也可用）。
 */
function parseHljsHtml(html) {
  const out = [];
  const stack = [];
  const re = /<span class="([^"]*)">|<\/span>/g;
  let last = 0, m;
  const pushText = (raw) => {
    if (!raw) return;
    const v = decodeEntities(raw);
    if (!v) return;
    const prev = out[out.length - 1];
    const cls = stack[stack.length - 1] || '';
    if (prev && prev.cls === cls) prev.v += v; // 相同类合并，减少下游 run 数
    else out.push({ v, cls });
  };
  while ((m = re.exec(html))) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) stack.push(m[1]);
    else stack.pop();
  }
  pushText(html.slice(last));
  return out;
}

// 组合类（如 "variable language_"）优先整串匹配，再逐段取首个命中
const colorOfCls = (cls) => {
  if (!cls) return null;
  const names = cls.split(/\s+/).map((c) => c.replace(/^hljs-/, '')).filter(Boolean);
  if (CLASS_COLORS[names.join(' ')]) return CLASS_COLORS[names.join(' ')];
  for (const n of names) if (CLASS_COLORS[n]) return CLASS_COLORS[n];
  return null;
};

/**
 * 代码 → 高亮 token [{v, c?}]（c = 十六进颜色；c 缺省为正文色）。
 * 已知语言 → 精确高亮；无语言 → 自动探测（限长）；未知语言 → null（纯文本，与 md-to-pdf 一致）。
 * token 文本连回恒等于原代码，PDF/Word 端可安全以 token 替代整行文本。
 */
export function highlightTokens(code, lang) {
  const text = String(code ?? '');
  const langName = normalizeLang(lang);
  let html;
  try {
    if (langName) {
      if (!hljs.getLanguage(langName)) return null;
      html = hljs.highlight(text, { language: langName, ignoreIllegals: true }).value;
    } else {
      if (!text.trim() || text.length > 20000) return null;
      html = hljs.highlightAuto(text, AUTO_SUBSET).value;
    }
  } catch {
    return null;
  }
  const toks = parseHljsHtml(html).map((t) => {
    const c = colorOfCls(t.cls);
    return c ? { v: t.v, c } : { v: t.v };
  });
  return toks.length ? toks : null;
}

/** 代码 → 高亮 HTML（hljs-* span，类名配色见 components.css 双色板）；无语言/未知语言回退纯转义 */
export function highlightHtml(code, lang) {
  const text = String(code ?? '');
  const langName = normalizeLang(lang);
  try {
    if (langName && hljs.getLanguage(langName)) {
      const toks = parseHljsHtml(hljs.highlight(text, { language: langName, ignoreIllegals: true }).value);
      return toks.map((t) => (t.cls ? `<span class="${t.cls}">${escapeHtmlText(t.v)}</span>` : escapeHtmlText(t.v))).join('');
    }
  } catch { /* 回退纯文本 */ }
  return escapeHtmlText(text);
}

const escapeHtmlText = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 高亮 token → 视觉行（按 \n 断行；行数与 text.split('\n') 一致，空行保留为空数组） */
export function tokenLines(tokens) {
  const lines = [[]];
  for (const tk of tokens) {
    const parts = String(tk.v ?? '').split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ v: p, c: tk.c });
    });
  }
  return lines;
}
