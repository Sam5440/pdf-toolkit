// Markdown 转 PDF / Word（更多 · 默认收藏 defaultFav）。
// 工作台对标 markdowntoword.io：左侧编辑器 + 右侧双模式预览（即时 HTML 预览 / PDF 版式预览）
// + 滚动同步 + 全屏 + 加载示例 + 内容自动暂存。
// 多引擎输出：
//   PDF：  ① 内置文本引擎（text.toPdf，可选中/搜索）
//          ② Typst 排版引擎（pandoc→typst + typst.ts WASM 编译，杂志级排版）
//          ③ 浏览器打印引擎（styled HTML + window.print()，Chrome 打印排版，另存为 PDF）
//   Word： ① 内置轻量引擎（mddocx 直构 OOXML，毫秒级）
//          ② Pandoc 高保真引擎（pandoc-wasm，脚注/任务列表/完整样式）
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { addResultArtifacts } from '../../core/tray.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button, checkbox, toast, confirmDialog } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseToBlocks, decodeText } from '../../core/importers.js';
import { parseMarkdownRich, renderRichBlocks, getSelfContainedKatexCss } from '../../core/mdrender.js';
import { mdToHtmlSync, renderMarkdownPreview } from '../../core/mdhtml.js';
import { markdownToDocx } from '../../core/mddocx.js';
import { pandocToDocx } from '../../core/mdpandoc.js';
import { markdownToPdfTypst } from '../../core/mdtypst.js';
import { PDFJS_ASSET_OPTS } from '../../core/pdfjs-assets.js';
import { setEngineStatus } from '../../core/wasm-registry.js';
import { buildOutputName, paramsToken } from '../../core/naming.js';

const PAPER_OPTS = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'a5', label: 'A5' },
  { value: 'a3', label: 'A3' },
  { value: 'legal', label: 'Legal' },
];
const FONT_OPTS = [
  { value: '10', label: '10pt（紧凑）' },
  { value: '11', label: '11pt（标准）' },
  { value: '12', label: '12pt（大）' },
  { value: '14', label: '14pt（更大）' },
];
const FORMAT_OPTS = [
  { value: 'pdf', label: 'PDF 文档' },
  { value: 'docx', label: 'Word 文档（.docx）' },
];
const ENGINE_OPTS = {
  pdf: [
    { value: 'builtin', label: '内置文本引擎（快速 · 可选中可搜索）' },
    { value: 'typst', label: 'Typst 排版引擎（WASM · 首次加载约 28MB）' },
    { value: 'print', label: '浏览器打印引擎（Chrome 排版 · 打印对话框另存为 PDF）' },
  ],
  docx: [
    { value: 'builtin', label: '内置轻量引擎（毫秒级 · 版式对齐内置 PDF）' },
    { value: 'pandoc', label: 'Pandoc 高保真引擎（WASM · 首次加载约 58MB）' },
  ],
};
const ENGINE_HINTS = {
  'pdf/builtin': '自研排版管线：嵌入 Noto Sans SC 子集，正文可选中/搜索/复制，公式与图形栅格化混排',
  'pdf/typst': 'pandoc 转 Typst 源 + Typst 编译器（WASM）出 PDF：专业排版、公式原生矢量；首次需加载 28MB 引擎',
  'pdf/print': '渲染样式化 HTML 后调起浏览器打印（与 markdowntoword 同款 Chrome 打印排版），在打印对话框选「另存为 PDF」',
  'docx/builtin': '直构 OOXML（真 Word 结构，非 HTML 壳）：标题大纲/表格跨页表头/代码底纹，图形与公式栅格化嵌入',
  'docx/pandoc': 'pandoc docx writer：脚注/任务列表/完整引用样式，保真度最高；首次需加载 58MB 引擎',
};

const EXAMPLE_MD = [
  '# Markdown 多引擎转换示例',
  '',
  '这是示例文档：**编辑左侧源码**，右侧即时预览；下方选择格式与引擎后导出 *PDF* 或 **Word**。',
  '',
  '## 常用语法',
  '',
  '- 无序列表项',
  '- 嵌套缩进项',
  '',
  '1. 有序列表一',
  '2. 有序列表二',
  '',
  '- [x] 任务列表（已完成）',
  '- [ ] 任务列表（待办）',
  '',
  '> 引用块：全浏览器端处理，文件不出浏览器。',
  '',
  '| 功能 | 内置引擎 | Typst | Pandoc |',
  '|:---|:---:|:---:|:---:|',
  '| 中文排版 | 支持 | 支持 | 支持 |',
  '| 数学公式 | KaTeX | 原生矢量 | 原生 |',
  '| 脚注 | — | 支持 | 支持 |',
  '',
  '`行内代码` 与代码块：',
  '',
  '```python',
  'def hello(name: str) -> str:',
  '    return f"你好，{name}"',
  '```',
  '',
  '## 数学公式',
  '',
  '行内公式 $E = mc^2$，独立公式：',
  '',
  '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$',
  '',
  '## 图形',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Markdown] --> B{选择引擎}',
  '  B --> C[导出 PDF]',
  '  B --> D[导出 Word]',
  '```',
  '',
  '脚注示例[^1]，分隔线：',
  '',
  '---',
  '',
  '[^1]: 这是一个脚注，Word（Pandoc 引擎）里是真脚注结构。',
].join('\n');

const DRAFT_KEY = 'pdftoolkit.md2pdf.draft.v2';
const PV_HTML_DEBOUNCE_MS = 300;
const PV_PDF_DEBOUNCE_MS = 1500;
const DRAFT_DEBOUNCE_MS = 400;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    setEngineStatus('pdfjs', 'ready', `v${pdfjsLib.version || '?'} · 主线程预览`);
  }
  return pdfjsLib;
}

/** PDF 字节 → 逐页 canvas 预览（主线程 pdf.js）。返回页数 */
async function renderPreviewBytes(bytes, pagesBox) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, ...PDFJS_ASSET_OPTS }).promise;
  pagesBox.replaceChildren();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1.1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.className = 'md-pv-page';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    pagesBox.appendChild(canvas);
  }
  return doc.numPages;
}

/** 打印排版 CSS（镜像 .mdx-paper 排版基因 + @page） */
function printDocCss(paper, fontSizePt) {
  const paperCss = { a4: 'A4', letter: 'Letter', a5: 'A5', a3: 'A3', legal: 'Legal' }[paper] || 'A4';
  return `
@page { size: ${paperCss} portrait; margin: 17mm; }
html, body { margin: 0; padding: 0; }
body { font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  font-size: ${fontSizePt * 1.3333}px; line-height: 1.72; color: #111; }
h1, h2, h3 { font-weight: 700; line-height: 1.35; color: #111; margin: 1.2em 0 0.5em; break-after: avoid; }
h1 { font-size: 2em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
h2 { font-size: 1.55em; } h3 { font-size: 1.25em; }
p { margin: 0.55em 0; }
a { color: #2563eb; text-decoration: underline; }
ul, ol { margin: 0.5em 0; padding-left: 1.7em; }
li { margin: 0.22em 0; }
li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.25em; }
blockquote { margin: 0.7em 0; padding: 0.15em 0.9em; color: #545b66;
  border-left: 3px solid #cbd5e1; background: #f8fafc; }
hr { border: none; border-top: 1px solid #9ca3af; margin: 1.3em 0; }
table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
th, td { border: 1px solid #aaa; padding: 5px 10px; }
th { background: #f0f0f0; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
pre { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; padding: 11px 13px;
  white-space: pre-wrap; word-break: break-all; }
code { font-family: Menlo, Consolas, 'Courier New', monospace; font-size: 0.92em; }
code { background: #f3f4f6; border-radius: 3px; padding: 0.12em 0.35em; }
pre code { background: none; padding: 0; }
img { max-width: 100%; }
figure, .mdx-figure { margin: 0.9em auto; text-align: center; }
.mdx-figure svg, .mdx-img { max-width: 100%; height: auto; }
.mdx-imgfail, .mdx-figure-fail { padding: 10px; text-align: center; color: #94a3b8;
  border: 1px dashed #cbd5e1; margin: 0.7em auto; max-width: 85%; }
.footnotes { margin-top: 1.6em; padding-top: 0.7em; border-top: 1px solid #e5e7eb; font-size: 0.9em; }
.footnotes h2.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
sup a { text-decoration: none; }
`;
}

/** 浏览器打印引擎：渲染装饰后的 HTML → 隐藏 iframe → window.print() */
async function printViaBrowser(text, { paper, fontSize, title }) {
  const holder = document.createElement('div');
  await renderMarkdownPreview(text, holder);
  const katexCss = await getSelfContainedKatexCss();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>${katexCss}</style><style>${printDocCss(paper, fontSize)}</style></head>`
    + `<body>${holder.innerHTML}</body></html>`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write(html);
  doc.close();
  await new Promise((r) => setTimeout(r, 350)); // 等字体/图形就绪
  iframe.contentWindow.addEventListener('afterprint', () => setTimeout(() => iframe.remove(), 500));
  iframe.contentWindow.focus();
  iframe.contentWindow.print();
}

registerTool({
  id: 'md2pdf',
  name: 'Markdown 转 PDF/Word',
  group: 'm-topdf',
  defaultFav: true, // 默认收藏：出现在首页「转换为 PDF」分区
  desc: '在线编辑或上传 Markdown，导出 PDF 或 Word（.docx），多引擎可选',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { name: '未命名.md' };

    // ---- 上传（载入编辑器） ----
    const panel = inputPanel({
      multiple: false,
      accept: '.md,.markdown,text/markdown',
      acceptTest: /\.(md|markdown)$/i,
      acceptHint: '选择 1 个 .md / .markdown 文件（会载入下方编辑器，可继续修改）',
      onAdd(added) {
        const doc = added.length ? added[added.length - 1] : null;
        if (!doc) return;
        state.name = doc.name;
        doc.file.arrayBuffer().then((buf) => {
          const text = decodeText(new Uint8Array(buf));
          ta.value = text;
          updateCount();
          draftSave();
          goBtn.disabled = !ta.value.trim();
          schedulePreview(300);
        });
      },
      onRemove() {
        if (!panel.docs().length) state.name = '未命名.md';
      },
    });

    // ---- 工作台卡（编辑器 + 双模式预览） ----
    const wsCard = document.createElement('div');
    wsCard.className = 'card md-workspace';
    wsCard.style.marginTop = '14px';
    const wsBody = document.createElement('div');
    wsBody.className = 'card-body';
    const wsHead = document.createElement('div');
    wsHead.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px';
    wsHead.innerHTML = `<b style="font-size:13.5px">Markdown 编辑器</b>
      <span class="muted-sm">上传的文件会载入此处；右侧实时预览，内容自动暂存本机</span>
      <span style="flex:1"></span>
      <span class="muted-sm" data-md-draft-state>未暂存</span>`;
    const exampleBtn = button('加载示例', 'btn-ghost btn-xs', () => {
      ta.value = EXAMPLE_MD;
      state.name = '示例文档.md';
      updateCount();
      goBtn.disabled = false;
      draftSave();
      schedulePreview(200);
    });
    const clearBtn = button('清空', 'btn-ghost btn-xs', async () => {
      if (!ta.value && !localStorage.getItem(DRAFT_KEY)) return;
      if (!(await confirmDialog({
        title: '清空编辑器',
        message: '确定清空编辑器内容与暂存草稿？',
        confirmText: '清空',
        destructive: true,
      }))) return;
      ta.value = '';
      state.name = '未命名.md';
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      draftStateEl.textContent = '未暂存';
      updateCount();
      goBtn.disabled = true;
      pvPaper.replaceChildren();
      pvPages.replaceChildren();
      pvStatus.textContent = '待输入';
    });
    const fsBtn = button('全屏', 'btn-ghost btn-xs', () => toggleFullscreen());
    wsHead.append(exampleBtn, clearBtn, fsBtn);

    const split = document.createElement('div');
    split.className = 'md-split';
    const ta = document.createElement('textarea');
    ta.setAttribute('data-md-text', '');
    ta.placeholder = '在此输入或粘贴 Markdown…\n\n支持 $行内公式$、$$独立公式$$、```mermaid 图形、```mindmap 思维导图、表格、脚注、代码块等';
    ta.className = 'md-editor-ta';
    const countEl = document.createElement('div');
    countEl.className = 'hint';
    countEl.style.marginTop = '6px';
    const edPane = document.createElement('div');
    edPane.style.cssText = 'display:flex;flex-direction:column;min-width:0';
    edPane.append(ta, countEl);

    // 预览面板（双模式）
    const pvHead = document.createElement('div');
    pvHead.className = 'md-pane-head';
    const tabHtml = button('即时', 'btn-outline btn-xs', () => setPreviewMode('html'));
    const tabPdf = button('PDF 版式', 'btn-ghost btn-xs', () => setPreviewMode('layout'));
    pvHead.innerHTML = '<b>实时预览</b><span class="muted-sm">即时=网页排版 · 版式=最终 PDF 页面</span>';
    const tabWrap = document.createElement('span');
    tabWrap.style.cssText = 'display:inline-flex;gap:4px';
    tabWrap.append(tabHtml, tabPdf);
    const pvStatus = document.createElement('span');
    pvStatus.className = 'muted-sm';
    pvStatus.setAttribute('data-md-pv-status', '');
    pvStatus.textContent = '待输入';
    pvHead.append(tabWrap, document.createElement('span'), pvStatus);
    const pvPages = document.createElement('div');
    pvPages.className = 'md-pv-pages';
    pvPages.setAttribute('data-md-pv-pages', '');
    const pvDoc = document.createElement('div');
    pvDoc.className = 'mdx-doc';
    const pvPaper = document.createElement('div');
    pvPaper.className = 'mdx-paper';
    pvDoc.appendChild(pvPaper);
    const pvPane = document.createElement('div');
    pvPane.style.cssText = 'display:flex;flex-direction:column;min-width:0;flex:1';
    pvPane.append(pvHead, pvDoc, pvPages);

    split.append(edPane, pvPane);
    wsBody.append(wsHead, split);
    wsCard.appendChild(wsBody);

    // ---- 参数卡 ----
    const { card, body } = paramsCard();
    const formatSel = select(FORMAT_OPTS, 'pdf');
    body.appendChild(field('输出格式', formatSel));
    const engineSel = select(ENGINE_OPTS.pdf, 'builtin');
    const engineHint = document.createElement('div');
    engineHint.className = 'hint';
    engineHint.style.marginBottom = '10px';
    body.appendChild(field('转换引擎', engineSel));
    body.appendChild(engineHint);
    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
    // Typst 引擎正文族：默认 Noto Sans SC，可选设置 → 外挂字体 里上传/订阅的字体
    const familyField = field('正文字体（Typst 引擎）', (() => {
      const sel = select([{ value: '', label: '默认（Noto Sans SC）' }], '');
      sel.setAttribute('aria-label', '正文字体（Typst 引擎）');
      return sel;
    })(), '外挂字体来自设置 → 外挂字体（上传或远程订阅）');
    familyField.style.display = 'none';
    body.appendChild(familyField);
    const familySel = familyField.querySelector('select');
    const refreshFamilyOpts = async () => {
      try {
        const { listUserFonts } = await import('../../core/userfonts.js');
        const fonts = await listUserFonts();
        const cur = familySel.value;
        familySel.replaceChildren();
        const def = document.createElement('option');
        def.value = '';
        def.textContent = '默认（Noto Sans SC）';
        familySel.appendChild(def);
        for (const f of fonts) {
          const o = document.createElement('option');
          o.value = f.family || f.name;
          o.textContent = `外挂：${f.family || f.name}`;
          familySel.appendChild(o);
        }
        familySel.value = [...familySel.options].some((o) => o.value === cur) ? cur : '';
      } catch { /* 无外挂字体即仅默认 */ }
    };
    refreshFamilyOpts();
    const sizeSel = select(FONT_OPTS, '11');
    body.appendChild(field('正文字号', sizeSel));
    const richCb = checkbox('渲染数学公式 / Mermaid 图形 / 思维导图', true);
    richCb._input.setAttribute('data-md-rich', '');
    richCb.style.marginTop = '10px';
    body.appendChild(richCb);
    const autoCb = checkbox('内容变化后自动刷新预览', true);
    autoCb._input.setAttribute('data-md-autopv', '');
    autoCb.style.marginTop = '6px';
    body.appendChild(autoCb);
    const syncCb = checkbox('编辑器与预览滚动同步', true);
    syncCb.style.marginTop = '6px';
    body.appendChild(syncCb);

    const goBtn = button('开始转换', 'btn-primary', () => doConvert());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, wsCard, card, goBtn, resultBox);

    const hint = (s) => { engineHint.textContent = s || ''; };
    const setEngineHint = () => hint(ENGINE_HINTS[`${formatSel.value}/${engineSel.value}`] || '');
    const richVisible = () => {
      const show = engineSel.value === 'builtin';
      richCb.style.display = show ? '' : 'none';
      // WASM 引擎全特性直转，富渲染勾选仅影响内置引擎
      familyField.style.display = formatSel.value === 'pdf' && engineSel.value === 'typst' ? '' : 'none';
      if (formatSel.value === 'pdf' && engineSel.value === 'typst') refreshFamilyOpts();
    };
    const syncGoLabel = () => {
      goBtn.textContent = formatSel.value === 'pdf' && engineSel.value === 'print' ? '调起打印' : '开始转换';
    };

    // ---- 预览模式 ----
    let previewMode = 'html'; // 'html' | 'layout'
    function setPreviewMode(mode) {
      previewMode = mode;
      pvDoc.style.display = mode === 'html' ? '' : 'none';
      pvPages.style.display = mode === 'html' ? 'none' : '';
      tabHtml.className = mode === 'html' ? 'btn-primary btn-xs' : 'btn-ghost btn-xs';
      tabPdf.className = mode === 'layout' ? 'btn-primary btn-xs' : 'btn-ghost btn-xs';
      if (mode === 'html') schedulePreview(50);
      else if (ta.value.trim()) schedulePdfPreview(50);
      else pvStatus.textContent = '待输入';
    }

    // ---- 暂存 ----
    const draftStateEl = wsHead.querySelector('[data-md-draft-state]');
    let draftTimer = null;
    const fmtTime = (ts) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const draftSave = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        const data = {
          v: 2, ts: Date.now(), name: state.name, text: ta.value,
          format: formatSel.value, engine: engineSel.value,
          paper: paperSel.value, fontSize: sizeSel.value,
          rich: richCb._input.checked, auto: autoCb._input.checked, sync: syncCb._input.checked,
          pvMode: previewMode,
        };
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch { /* ignore */ }
        draftStateEl.textContent = `已暂存 ${fmtTime(data.ts)}`;
      }, DRAFT_DEBOUNCE_MS);
    };
    const draftRestore = () => {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore */ }
      if (!d) return false;
      ta.value = typeof d.text === 'string' ? d.text : '';
      state.name = d.name || '未命名.md';
      if (d.format === 'docx' || d.format === 'pdf') formatSel.value = d.format;
      rebuildEngines(d.engine);
      if (d.paper) paperSel.value = d.paper;
      if (d.fontSize) sizeSel.value = d.fontSize;
      richCb._input.checked = d.rich !== false;
      autoCb._input.checked = d.auto !== false;
      syncCb._input.checked = d.sync !== false;
      if (d.ts) draftStateEl.textContent = `已暂存 ${fmtTime(d.ts)}`;
      return { pvMode: d.pvMode };
    };

    // ---- 管线：内置 PDF（编辑器文本 → PDF 产物） ----
    async function buildPdf(text, setP) {
      const rich = richCb._input.checked;
      const fontSize = Number(sizeSel.value) || 11;
      const baseName = state.name.replace(/\.(md|markdown)$/i, '') || '文档';
      setP(15, '解析 Markdown…');
      const bytesIn = new TextEncoder().encode(text);
      let blocks, warnings = [], docTitle = baseName, richCount = 0;
      if (rich) {
        const parsed = parseMarkdownRich(text);
        if (!parsed.blocks.length) throw new Error('没有可排版的内容');
        setP(18, '渲染公式与图形…');
        const rendered = await renderRichBlocks(parsed.blocks, { fontSize });
        blocks = rendered.blocks;
        warnings = [...parsed.warnings, ...rendered.warnings];
        docTitle = parsed.title || baseName;
        richCount = blocks.filter((b) => b.type === 'img' && b.b64).length;
      } else {
        blocks = parseToBlocks(state.name, bytesIn).blocks;
        if (!blocks.length) throw new Error('没有可排版的内容');
      }
      const res = await run('text.toPdf', {
        name: baseName,
        blocks,
        paper: paperSel.value,
        margin: 48,
        fontSize,
        title: docTitle,
      }, {
        onProgress: (p) => setP(rich ? 30 + (p.done / p.total) * 70 : 20 + (p.done / p.total) * 80, p.stage),
      }, new Map());
      return { res, warnings, richCount, rich };
    }

    // ---- PDF 版式预览（防抖 + 串行 + 仅保留最新） ----
    let pvTimer = null;
    let pvSeq = 0;
    let pvChain = Promise.resolve();
    function schedulePreview(delay = PV_HTML_DEBOUNCE_MS) {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => (previewMode === 'html' ? runHtmlPreview() : runPdfPreview()), delay);
    }
    function schedulePdfPreview(delay = PV_PDF_DEBOUNCE_MS) {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => runPdfPreview(), delay);
    }
    async function runHtmlPreview() {
      const seq = ++pvSeq;
      const text = ta.value;
      pvChain = pvChain.then(async () => {
        if (seq !== pvSeq || previewMode !== 'html') return;
        if (!text.trim()) {
          pvPaper.replaceChildren();
          pvStatus.textContent = '待输入';
          return;
        }
        pvStatus.textContent = '渲染中…';
        try {
          const { figures, imgFailed } = await renderMarkdownPreview(text, pvPaper);
          if (seq !== pvSeq || previewMode !== 'html') return;
          pvStatus.textContent = `${figures ? `${figures} 图形 · ` : ''}${imgFailed ? `${imgFailed} 图失败 · ` : ''}网页排版 · ${fmtTime(Date.now())}`;
        } catch (e) {
          if (seq !== pvSeq) return;
          pvStatus.textContent = `预览失败：${e.message}`;
        }
      });
    }
    function runPdfPreview() {
      const seq = ++pvSeq;
      const text = ta.value;
      pvChain = pvChain.then(async () => {
        if (seq !== pvSeq || previewMode !== 'layout') return;
        if (!text.trim()) {
          pvPages.replaceChildren();
          pvStatus.textContent = '待输入';
          return;
        }
        pvStatus.textContent = '渲染中…';
        pvPages.replaceChildren();
        const sp = document.createElement('span');
        sp.className = 'spinner';
        pvPages.appendChild(sp);
        try {
          if (formatSel.value !== 'pdf' || engineSel.value !== 'builtin') {
            pvPages.replaceChildren();
            pvStatus.textContent = '版式预览仅支持内置 PDF 引擎（当前组合转换后展示）';
            return;
          }
          const { res } = await buildPdf(text, () => {});
          if (seq !== pvSeq || previewMode !== 'layout') return;
          const pages = await renderPreviewBytes(res.artifacts[0].bytes, pvPages);
          if (seq !== pvSeq) return;
          pvStatus.textContent = `共 ${pages} 页 · ${fmtTime(Date.now())}`;
        } catch (e) {
          if (seq !== pvSeq) return;
          pvPages.replaceChildren();
          pvStatus.textContent = `预览失败：${e.message}`;
        }
      });
    }

    async function renderLatest(bytes, pages) {
      pvSeq++;
      setPreviewMode('layout');
      const n = await renderPreviewBytes(bytes, pvPages);
      pvStatus.textContent = `共 ${pages || n} 页 · ${fmtTime(Date.now())}`;
    }

    // ---- 手动转换（进度 + 结果卡 + 同步预览） ----
    const doConvert = runWithProgress(resultBox, async (setP) => {
      const text = ta.value;
      if (!text.trim()) throw new Error('请输入 Markdown 内容或上传 .md 文件');
      const baseName = state.name.replace(/\.(md|markdown)$/i, '') || '文档';
      const fontSize = Number(sizeSel.value) || 11;
      const fmt = formatSel.value;
      const eng = engineSel.value;

      if (fmt === 'pdf' && eng === 'print') {
        setP(20, '渲染样式化 HTML…');
        await printViaBrowser(text, { paper: paperSel.value, fontSize, title: baseName });
        setP(90, '已调起打印');
        toast('已在打印对话框打开：选择「另存为 PDF」即可导出');
        return null;
      }
      if (fmt === 'pdf' && eng === 'typst') {
        setP(10, '准备引擎…');
        const { bytes } = await markdownToPdfTypst(text, {
          paper: paperSel.value, fontSize, title: baseName,
          fontFamily: familySel.value || undefined,
          onStage: (s) => setP(35, s),
        });
        const art = { name: `${buildOutputName({ name: baseName, op: 'Markdown转PDF', params: paramsToken({ engine: 'typst', paper: paperSel.value }) })}.pdf`, bytes, mime: 'application/pdf' };
        addResultArtifacts([art]); // 不走 engine.run()，入架对齐内置引擎分支
        resultBox.appendChild(resultCard({
          arts: [art],
          summary: { 引擎: 'Typst 排版', 纸张: paperSel.value.toUpperCase(), 字号: `${fontSize}pt` },
          toolId: 'md2pdf', toolName: 'Markdown 转 PDF/Word',
          docNames: [state.name],
          options: { format: 'pdf', engine: 'typst', paper: paperSel.value, fontSize, source: '在线编辑' },
        }));
        await renderLatest(bytes, undefined);
        return { pages: undefined };
      }
      if (fmt === 'docx' && eng === 'pandoc') {
        setP(10, '准备引擎…');
        const { bytes } = await pandocToDocx(text, { onStage: (s) => setP(35, s) });
        const art = { name: `${buildOutputName({ name: baseName, op: 'Markdown转Word', params: paramsToken({ engine: 'pandoc' }) })}.docx`, bytes, mime: DOCX_MIME };
        resultBox.appendChild(resultCard({
          arts: [art],
          summary: { 引擎: 'Pandoc 高保真', 格式: 'Word .docx' },
          toolId: 'md2pdf', toolName: 'Markdown 转 PDF/Word',
          docNames: [state.name],
          options: { format: 'docx', engine: 'pandoc', source: '在线编辑' },
        }));
        setPreviewMode('html');
        schedulePreview(50);
        return { docx: true };
      }

      // 内置引擎
      if (fmt === 'docx') {
        setP(15, '解析 Markdown…');
        const { bytes, warnings, richCount } = await markdownToDocx(text, {
          fontSize, paper: paperSel.value, name: baseName,
        });
        const art = { name: `${buildOutputName({ name: baseName, op: 'Markdown转Word', params: paramsToken({ engine: 'builtin', paper: paperSel.value }) })}.docx`, bytes, mime: DOCX_MIME };
        resultBox.appendChild(resultCard({
          arts: [art],
          summary: { 引擎: '内置轻量', 图形公式: richCount, 格式: 'Word .docx' },
          toolId: 'md2pdf', toolName: 'Markdown 转 PDF/Word',
          docNames: [state.name],
          options: { format: 'docx', engine: 'builtin', fontSize, rich: richCb._input.checked, source: '在线编辑' },
          warnings,
        }));
        setPreviewMode('html');
        schedulePreview(50);
        return { docx: true };
      }
      const { res, warnings, richCount, rich } = await buildPdf(text, setP);
      const modeLabel = String(res.summary.mode || '').startsWith('raster-fallback')
        ? '图片型（回退）'
        : '可选中·可搜索'; // 文本型 PDF 标记（mode='text'）
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: rich
          ? { 页数: res.summary.pages, 公式图形: richCount, 文本型: modeLabel }
          : { 页数: res.summary.pages, 文本型: modeLabel },
        toolId: 'md2pdf', toolName: 'Markdown 转 PDF/Word',
        docNames: [state.name],
        options: { format: 'pdf', engine: 'builtin', paper: paperSel.value, fontSize: Number(sizeSel.value), rich, source: '在线编辑' },
        warnings,
      }));
      await renderLatest(res.artifacts[0].bytes, res.summary.pages);
      return res;
    });

    // ---- 引擎选项随格式切换 ----
    function rebuildEngines(prefEngine) {
      const fmt = formatSel.value;
      const opts = ENGINE_OPTS[fmt];
      engineSel.replaceChildren(...opts.map((o) => {
        const el = document.createElement('option');
        el.value = o.value;
        el.textContent = o.label;
        return el;
      }));
      if (prefEngine && opts.some((o) => o.value === prefEngine)) engineSel.value = prefEngine;
      richVisible();
      setEngineHint();
      syncGoLabel();
    }

    // ---- 全屏 ----
    function toggleFullscreen() {
      const on = !wsCard.classList.contains('fs');
      wsCard.classList.toggle('fs', on);
      document.body.style.overflow = on ? 'hidden' : '';
      fsBtn.textContent = on ? '退出全屏' : '全屏';
    }
    const onFsKey = (e) => { if (e.key === 'Escape' && wsCard.classList.contains('fs')) toggleFullscreen(); };
    document.addEventListener('keydown', onFsKey);

    // ---- 滚动同步（比例同步 + 防回环） ----
    let syncLock = 0;
    const activePv = () => (previewMode === 'html' ? pvDoc : pvPages);
    function bindSync(src, dstGetter) {
      src.addEventListener('scroll', () => {
        if (!syncCb._input.checked || syncLock > 0) return;
        syncLock += 1;
        const dst = dstGetter();
        const sMax = src.scrollHeight - src.clientHeight;
        const dMax = dst.scrollHeight - dst.clientHeight;
        if (sMax > 0 && dMax > 0) dst.scrollTop = (src.scrollTop / sMax) * dMax;
        requestAnimationFrame(() => { syncLock -= 1; });
      });
    }
    bindSync(ta, activePv);
    bindSync(pvDoc, () => ta);
    bindSync(pvPages, () => ta);

    // ---- 事件绑定 ----
    const updateCount = () => {
      const n = ta.value.length;
      countEl.textContent = n ? `${n} 字符` : '';
    };
    ta.addEventListener('input', () => {
      updateCount();
      goBtn.disabled = !ta.value.trim();
      draftSave();
      if (autoCb._input.checked) schedulePreview();
    });
    const onParamChange = () => {
      draftSave();
      if (autoCb._input.checked && ta.value.trim()) {
        if (previewMode === 'layout' && (formatSel.value !== 'pdf' || engineSel.value !== 'builtin')) return;
        schedulePreview(400);
      }
    };
    formatSel.addEventListener('change', () => {
      rebuildEngines();
      draftSave();
    });
    engineSel.addEventListener('change', () => {
      richVisible();
      setEngineHint();
      syncGoLabel();
      draftSave();
      onParamChange();
    });
    paperSel.addEventListener('change', onParamChange);
    sizeSel.addEventListener('change', onParamChange);
    richCb._input.addEventListener('change', onParamChange);
    autoCb._input.addEventListener('change', onParamChange);

    // ---- 初始化：还原暂存 → 更新计数 → 首次预览 ----
    const restored = draftRestore();
    updateCount();
    goBtn.disabled = !ta.value.trim();
    richVisible();
    setEngineHint();
    syncGoLabel();
    setPreviewMode(restored?.pvMode === 'layout' ? 'layout' : 'html');
    if (restored && ta.value.trim()) schedulePreview(600);
  },
});
