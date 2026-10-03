// Markdown → HTML 即时预览（交互对标 markdowntoword.io：左编辑器 + 右实时预览 + 滚动同步 + 全屏）。
// 预览样式镜像内置 PDF 引擎的排版基因（代码底 #f3f4f6 / 引用竖条 #cbd5e1 / 表头 #f0f0f0），
// 即「预览即产物」；KaTeX 公式直接用矢量 HTML（预览专用，与 PDF 的栅格化互不影响）。
//
// 用独立 Marked 实例（不污染 PDF 管线的全局 marked，避免脚注/KaTeX 扩展改变 lexer 行为）。
// mdToHtmlSync 为纯字符串函数（vitest node 可跑）；decorate* 需要 DOM，动态 import 图形库。
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import markedKatex from 'marked-katex-extension';
import { highlightHtml, normalizeLang } from './mdhl.js';
import 'katex/dist/katex.min.css';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const md2html = new Marked({ gfm: true, breaks: false });
md2html.use(markedFootnote());
md2html.use(markedKatex({ throwOnError: false, nonStandard: true, output: 'html' }));

const renderer = {
  /** 代码块：mermaid/mindmap/math 走占位 div（decorate 阶段异步渲染），其余深色等宽块 + 语言角标 */
  code({ text, lang }) {
    const langStr = String(lang ?? '').trim().toLowerCase();
    if (langStr === 'mermaid' || langStr === 'mindmap' || langStr === 'markmap') {
      const kind = langStr === 'mermaid' ? 'mermaid' : 'markmap';
      return `<div class="mdx-figure" data-kind="${kind}" data-code="${escapeHtml(text)}"><span class="spinner"></span></div>`;
    }
    if (langStr === 'math' || langStr === 'latex') {
      return `<div class="mdx-figure" data-kind="math" data-code="${escapeHtml(text)}"></div>`;
    }
    const label = langStr ? `<span class="mdx-code-lang">${escapeHtml(langStr)}</span>` : '';
    // 语法高亮（mdhl：已知语言 token 着色 / 未知语言回退纯转义文本）；类名配色见 components.css
    const body = highlightHtml(text, normalizeLang(langStr));
    return `<div class="mdx-code${label ? '' : ' nolang'}">${label}<pre><code class="hljs">${body}</code></pre></div>`;
  },
  /** 外链新窗口打开 */
  link({ href, title, tokens }) {
    const inner = this.parser.parseInline(tokens);
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
  },
  /** 图片：data-URL 直出；远程图直接渲染（离线环境 onerror → 占位框） */
  image({ href, title, text }) {
    const alt = escapeHtml(text ?? '');
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img class="mdx-img" src="${escapeHtml(href)}" alt="${alt}" loading="lazy"${t}>`;
  },
};

md2html.use({ renderer });

/** Markdown 文本 → HTML 字符串（同步；mermaid/mindmap/math 为占位，需 decorate 预览容器） */
export function mdToHtmlSync(text) {
  return md2html.parse(String(text ?? ''));
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

/** 容器内异步图形渲染：mermaid → 内联 SVG；markmap → 交互 SVG；math → KaTeX display；坏图 → 占位框。
 *  返回 {figures, imgFailed} 统计。重复调用只处理未渲染的占位（幂等）。 */
export async function decoratePreview(root) {
  let figures = 0;
  let imgFailed = 0;

  const mermaidEls = [...root.querySelectorAll('[data-kind="mermaid"]:not([data-done])')];
  if (mermaidEls.length) {
    const mermaid = await getMermaid();
    for (const el of mermaidEls) {
      el.setAttribute('data-done', '1');
      try {
        const { svg } = await mermaid.render(`mdx-mmd-${++mermaidSeq}`, el.getAttribute('data-code') || '');
        el.innerHTML = svg;
        const svgEl = el.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('height');
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
        }
        figures += 1;
      } catch {
        el.innerHTML = '<div class="mdx-figure-fail">Mermaid 语法错误，无法渲染图形</div>';
      }
    }
  }

  const markmapEls = [...root.querySelectorAll('[data-kind="markmap"]:not([data-done])')];
  if (markmapEls.length) {
    const { Transformer } = await import('markmap-lib');
    const { Markmap } = await import('markmap-view');
    for (const el of markmapEls) {
      el.setAttribute('data-done', '1');
      try {
        const { root: mmRoot } = new Transformer().transform(el.getAttribute('data-code') || '');
        const SVGNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('width', el.clientWidth > 60 ? String(el.clientWidth) : '640');
        svg.setAttribute('height', '420');
        el.innerHTML = '';
        el.appendChild(svg);
        const mm = Markmap.create(svg, { duration: 0, initialExpandLevel: -1 });
        mm.setData(mmRoot);
        mm.fit();
        figures += 1;
      } catch {
        el.innerHTML = '<div class="mdx-figure-fail">思维导图渲染失败</div>';
      }
    }
  }

  for (const el of root.querySelectorAll('[data-kind="math"]:not([data-done])')) {
    el.setAttribute('data-done', '1');
    try {
      const katex = (await import('katex')).default;
      el.innerHTML = katex.renderToString(el.getAttribute('data-code') || '', {
        displayMode: true, throwOnError: false, output: 'html',
      });
      figures += 1;
    } catch {
      el.innerHTML = '<div class="mdx-figure-fail">公式解析失败</div>';
    }
  }

  for (const img of root.querySelectorAll('img.mdx-img')) {
    if (img.hasAttribute('data-mdx-watch')) continue;
    img.setAttribute('data-mdx-watch', '1');
    img.addEventListener('error', () => {
      const alt = img.getAttribute('alt') || '';
      const box = document.createElement('div');
      box.className = 'mdx-imgfail';
      box.textContent = alt ? `图片不可用：${alt}` : '图片不可用';
      img.replaceWith(box);
      imgFailed += 1;
    }, { once: true });
    if (img.complete && img.naturalWidth === 0) img.dispatchEvent(new Event('error'));
  }

  return { figures, imgFailed };
}

/** 一步式：text → 容器 HTML + 异步图形。返回 {figures, imgFailed} */
export async function renderMarkdownPreview(text, root) {
  root.innerHTML = mdToHtmlSync(text);
  return decoratePreview(root);
}
