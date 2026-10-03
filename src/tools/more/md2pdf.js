// Markdown 转 PDF（更多 · 对齐 PDF24 markdown-to-pdf，已设为默认收藏 defaultFav）：
// 在线编辑器 + 上传载入 + 实时预览（预览即转换产物的 PDF 页面图，所见即所得）+ 内容自动暂存。
// 富渲染：KaTeX 公式 / Mermaid 图形 / markmap 思维导图，全部离线栅格化 → 引擎 text.toPdf
// （文本型 PDF：正文以嵌入字体真实绘制文字，可选中/搜索/复制；公式与图形仍为图片混排）
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button, checkbox } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseToBlocks, decodeText } from '../../core/importers.js';
import { parseMarkdownRich, renderRichBlocks } from '../../core/mdrender.js';
import { PDFJS_ASSET_OPTS } from '../../core/pdfjs-assets.js';

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

const DRAFT_KEY = 'pdftoolkit.md2pdf.draft.v1';
const PV_DEBOUNCE_MS = 1200;
const DRAFT_DEBOUNCE_MS = 400;

let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjsLib;
}

/** PDF 字节 → 逐页 canvas 预览（主线程 pdf.js） */
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

registerTool({
  id: 'md2pdf',
  name: 'Markdown 转 PDF',
  group: 'm-topdf',
  defaultFav: true, // 默认收藏：出现在首页「转换为 PDF」分区
  desc: '在线编辑或上传 Markdown，导出可搜索的文本型 PDF（公式/流程图/思维导图）',
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

    // ---- 编辑器卡 ----
    const edCard = document.createElement('div');
    edCard.className = 'card';
    edCard.style.marginTop = '14px';
    const edBody = document.createElement('div');
    edBody.className = 'card-body';
    const edHead = document.createElement('div');
    edHead.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px';
    edHead.innerHTML = `<b style="font-size:13.5px">Markdown 编辑器</b>
      <span class="muted-sm">上传的文件会载入此处，可直接修改；内容自动暂存本机</span>
      <span style="flex:1"></span>
      <span class="muted-sm" data-md-draft-state>未暂存</span>`;
    const clearBtn = button('清空', 'btn-ghost btn-xs', () => {
      if (!ta.value && !localStorage.getItem(DRAFT_KEY)) return;
      if (!confirm('确定清空编辑器内容与暂存草稿？')) return;
      ta.value = '';
      state.name = '未命名.md';
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      draftStateEl.textContent = '未暂存';
      updateCount();
      goBtn.disabled = true;
      pvPages.replaceChildren();
      pvStatus.textContent = '待输入';
    });
    edHead.appendChild(clearBtn);
    const ta = document.createElement('textarea');
    ta.setAttribute('data-md-text', '');
    ta.rows = 14;
    ta.placeholder = '在此输入或粘贴 Markdown…\n\n支持 $行内公式$、$$独立公式$$、```mermaid 图形、```mindmap 思维导图、表格、代码块等';
    ta.className = 'md-editor-ta';
    const countEl = document.createElement('div');
    countEl.className = 'hint';
    countEl.style.marginTop = '6px';
    edBody.append(edHead, ta, countEl);
    edCard.appendChild(edBody);

    // ---- 参数卡 ----
    const { card, body } = paramsCard();
    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
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

    const goBtn = button('开始转换', 'btn-primary', () => doConvert());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    // ---- 预览卡 ----
    const pvCard = document.createElement('div');
    pvCard.className = 'card';
    pvCard.style.marginTop = '14px';
    const pvBody = document.createElement('div');
    pvBody.className = 'card-body';
    const pvHead = document.createElement('div');
    pvHead.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px';
    pvHead.innerHTML = `<b style="font-size:13.5px">实时预览</b>
      <span class="muted-sm">预览即最终 PDF 页面（所见即所得）</span>
      <span style="flex:1"></span>
      <span class="muted-sm" data-md-pv-status>待输入</span>`;
    const refreshBtn = button('刷新预览', 'btn-outline btn-xs', () => runPreview());
    pvHead.appendChild(refreshBtn);
    const pvPages = document.createElement('div');
    pvPages.className = 'md-pv-pages';
    pvPages.setAttribute('data-md-pv-pages', '');
    pvBody.append(pvHead, pvPages);
    pvCard.appendChild(pvBody);

    const resultBox = document.createElement('div');
    container.append(panel.el, edCard, card, goBtn, pvCard, resultBox);

    // ---- 暂存 ----
    const draftStateEl = edHead.querySelector('[data-md-draft-state]');
    const pvStatus = pvHead.querySelector('[data-md-pv-status]');
    let draftTimer = null;
    const fmtTime = (ts) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const draftSave = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        const data = {
          v: 1, ts: Date.now(), name: state.name, text: ta.value,
          paper: paperSel.value, fontSize: sizeSel.value,
          rich: richCb._input.checked, auto: autoCb._input.checked,
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
      if (d.paper) paperSel.value = d.paper;
      if (d.fontSize) sizeSel.value = d.fontSize;
      richCb._input.checked = d.rich !== false;
      autoCb._input.checked = d.auto !== false;
      if (d.ts) draftStateEl.textContent = `已暂存 ${fmtTime(d.ts)}`;
      return true;
    };

    // ---- 管线（编辑器文本 → PDF 产物） ----
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

    // ---- 实时预览（防抖 + 串行 + 仅保留最新） ----
    let pvTimer = null;
    let pvSeq = 0;
    let pvChain = Promise.resolve();
    function schedulePreview(delay = PV_DEBOUNCE_MS) {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => runPreview(false), delay);
    }
    function runPreview() {
      const seq = ++pvSeq;
      const text = ta.value;
      pvChain = pvChain.then(async () => {
        if (seq !== pvSeq) return; // 已被更新的输入取代
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
          const { res } = await buildPdf(text, () => {});
          if (seq !== pvSeq) return;
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
      const n = await renderPreviewBytes(bytes, pvPages);
      pvStatus.textContent = `共 ${pages || n} 页 · ${fmtTime(Date.now())}`;
    }

    // ---- 手动转换（进度 + 结果卡 + 同步预览） ----
    const doConvert = runWithProgress(resultBox, async (setP) => {
      const text = ta.value;
      if (!text.trim()) throw new Error('请输入 Markdown 内容或上传 .md 文件');
      const { res, warnings, richCount, rich } = await buildPdf(text, setP);
      const modeLabel = String(res.summary.mode || '').startsWith('raster-fallback')
        ? '图片型（回退）'
        : '可选中·可搜索'; // 文本型 PDF 标记（mode='text'）
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: rich
          ? { 页数: res.summary.pages, 公式图形: richCount, 文本型: modeLabel }
          : { 页数: res.summary.pages, 文本型: modeLabel },
        toolId: 'md2pdf', toolName: 'Markdown 转 PDF',
        docNames: [state.name],
        options: { paper: paperSel.value, fontSize: Number(sizeSel.value), rich, source: '在线编辑' },
        warnings,
      }));
      await renderLatest(res.artifacts[0].bytes, res.summary.pages);
      return res;
    });

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
      if (autoCb._input.checked && ta.value.trim()) schedulePreview(400);
    };
    paperSel.addEventListener('change', onParamChange);
    sizeSel.addEventListener('change', onParamChange);
    richCb._input.addEventListener('change', onParamChange);
    autoCb._input.addEventListener('change', onParamChange);

    // ---- 初始化：还原暂存 → 更新计数 → 首次预览 ----
    const restored = draftRestore();
    updateCount();
    goBtn.disabled = !ta.value.trim();
    if (restored && ta.value.trim()) schedulePreview(600);
  },
});
