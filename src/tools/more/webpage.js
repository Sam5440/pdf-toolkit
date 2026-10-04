// 网页/HTML 转 PDF（更多 · 对齐 PDF24 webpage-to-pdf）。
// 三种来源一键出「HTML 文件 + PDF」：① 粘贴 HTML 源码 ② 输入网址直抓（受 CORS 限制）③ 上传 .html 文件。
// 三种来源统一载入编辑器（可检视/修改），一键转换优先用编辑器内容；编辑器为空且有网址时自动抓取。
// PDF 双引擎：
//   ① 内置文本引擎（parseHtml 正文抽取 → text.toPdf，文字可选中可搜索，自动产出 PDF 文件）
//   ② 浏览器打印引擎（源码净化去脚本 → 注入 @page → 隐藏 iframe → window.print()，Chrome 排版高保真，打印对话框另存）
// 隐私模型：全部处理在本地浏览器完成，不经任何服务器抓取或解析网页。
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { addResultArtifacts } from '../../core/tray.js';
import { inputPanel } from '../../components/input.js';
import { field, select, textInput, button, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseHtml, decodeText } from '../../core/importers.js';

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
];
const ENGINE_OPTS = [
  { value: 'builtin', label: '内置文本引擎（自动产出 PDF · 正文可选中可搜索）' },
  { value: 'print', label: '浏览器打印引擎（高保真原样式 · 打印对话框另存为 PDF）' },
];
const ENGINE_HINTS = {
  builtin: '内置引擎抽取 HTML 正文（文字/标题/列表/表格）重排为可选中文字 PDF；字号与纸张在重排时生效。HTML 文件为完整源码快照。',
  print: '打印引擎按原页面样式用 Chrome 排版生成：转换后调起打印对话框，请在目标打印机选「另存为 PDF」（建议勾选背景图形）；正文字号不参与。',
};

/** 确保是完整 HTML 文档：用户粘贴的片段自动包壳，完整文档原样保留 */
function ensureFullHtml(src) {
  const t = String(src ?? '');
  if (/<!doctype\s+html/i.test(t) || /<html[\s>]/i.test(t)) return t;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${t}</body></html>`;
}

/** 从 HTML 中派生安全文件名：<title> 优先，其次 fallback（如主机名/文件名） */
function deriveName(html, fallback) {
  let title = '';
  try {
    title = new DOMParser().parseFromString(html, 'text/html').querySelector('title')?.textContent?.trim() || '';
  } catch { /* 解析失败回退 fallback */ }
  const base = String(title || fallback || '网页').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || '网页';
}

/** 打印前净化不受信 HTML：去脚本/事件属性/子文档/自动跳转（printer 主线程渲染的安全前提） */
function sanitizeForPrint(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, noscript, iframe, frame, object, embed, meta[http-equiv="refresh" i]').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** 打印引擎：注入 @page 纸张与精确色彩打印 CSS → 隐藏 iframe → window.print()（用户在对话框里另存为 PDF） */
async function printViaIframe(html, { paper }) {
  const paperCss = { a4: 'A4', letter: 'Letter', a5: 'A5', a3: 'A3', legal: 'Legal' }[paper] || 'A4';
  const inject = `<style>@page{size:${paperCss} portrait;margin:12mm}`
    + 'html{-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    + 'img,table,pre{break-inside:auto}h1,h2,h3{break-after:avoid}</style>';
  let out = sanitizeForPrint(html);
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${inject}</head>`);
  else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, (m) => m + inject);
  else out = inject + out;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden';
  iframe.srcdoc = out;
  const loaded = new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  document.body.appendChild(iframe);
  await loaded;
  await new Promise((r) => setTimeout(r, 800)); // 字体/图片宽限
  try {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  } finally {
    setTimeout(() => iframe.remove(), 90_000); // 兜底清理
  }
}

registerTool({
  id: 'webpage',
  name: '网页转 PDF',
  group: 'm-topdf',
  desc: '粘贴 HTML 源码 / 输入网址 / 上传 .html 文件，一键导出 HTML 文件与 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { name: '网页' };

    // 隐私与限制说明（置顶）
    const note = document.createElement('div');
    note.className = 'note';
    note.style.marginBottom = '12px';
    note.textContent = '隐私模型：全部处理在本地浏览器完成，不会经服务器抓取网页。直接抓取网址受目标站点 CORS 限制，'
      + '多数网站会拒绝跨域读取；此时请打开网页后复制源码粘贴，或在浏览器「另存为完整 HTML」后上传。';

    // ---- 上传（载入编辑器） ----
    const panel = inputPanel({
      multiple: false,
      accept: '.html,.htm,text/html',
      acceptTest: /\.(html?|xhtml)$/i,
      acceptHint: '可选：上传 1 个 .html / .htm 文件（网页另存为的全文，会载入下方编辑器）',
      onAdd(added) {
        const doc = added.length ? added[added.length - 1] : null;
        if (!doc) return;
        state.name = doc.name.replace(/\.(html?|xhtml)$/i, '');
        doc.file.arrayBuffer().then((buf) => {
          setText(new TextDecoder('utf-8').decode(new Uint8Array(buf)), '上传文件');
        });
      },
      onRemove() {
        if (!panel.docs().length && !ta.value.trim()) state.name = '网页';
      },
    });

    // ---- HTML 编辑器（统一的中转站：上传/抓取都载入这里改） ----
    const wsCard = document.createElement('div');
    wsCard.className = 'card';
    wsCard.style.marginTop = '14px';
    const wsBody = document.createElement('div');
    wsBody.className = 'card-body';
    const wsHead = document.createElement('div');
    wsHead.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px';
    wsHead.innerHTML = '<b style="font-size:13.5px">HTML 源码</b>'
      + '<span class="muted-sm edit-hint">粘贴网页源码，或用网址/上传自动载入</span>'
      + '<span style="flex:1"></span>'
      + '<button type="button" class="btn-clear">清空</button>';
    const ta = document.createElement('textarea');
    ta.setAttribute('data-web-ta', '');
    ta.placeholder = '在此粘贴完整或片段 HTML 源码…（也可以在下方输入网址直接转换）';
    ta.spellcheck = false;
    ta.style.cssText = 'width:100%;min-height:220px;max-height:60vh;resize:vertical;box-sizing:border-box;'
      + 'font:12.5px/1.6 Menlo,Consolas,"Courier New",monospace;';
    const clearBtn = wsHead.querySelector('.btn-clear');
    clearBtn.className = 'btn-ghost btn-xs';
    clearBtn.style.padding = '2px 10px';
    const countEl = document.createElement('div');
    countEl.className = 'hint';
    countEl.style.marginTop = '6px';
    wsBody.append(wsHead, ta, countEl);
    wsCard.appendChild(wsBody);

    // ---- 静态预览（sandbox 禁脚本，安全展示粘贴的源码效果） ----
    const pvCard = document.createElement('div');
    pvCard.className = 'card';
    const pvBody = document.createElement('div');
    pvBody.className = 'card-body';
    const pvHead = document.createElement('div');
    pvHead.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:10px';
    pvHead.innerHTML = '<b style="font-size:13.5px">效果预览</b><span class="muted-sm pv-status">待输入</span>';
    const pvFrame = document.createElement('iframe');
    pvFrame.setAttribute('sandbox', ''); // 全禁脚本：仅渲染 HTML/CSS/图片
    pvFrame.title = 'HTML 预览';
    pvFrame.style.cssText = 'width:100%;height:320px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:#fff;display:none';
    pvBody.append(pvHead, pvFrame);
    pvCard.appendChild(pvBody);

    // ---- 参数卡 ----
    const { card, body } = paramsCard();
    const urlInp = textInput('', 'https://example.com/page');
    body.appendChild(field('网址（可选，直接转换或抓取到编辑器）', urlInp));
    const fetchBtn = button('抓取到编辑器', 'btn-outline', () => fetchIntoEditor());
    fetchBtn.style.marginTop = '8px';
    body.appendChild(fetchBtn);
    const engineSel = select(ENGINE_OPTS, 'builtin');
    const engineHint = document.createElement('div');
    engineHint.className = 'hint';
    engineHint.style.marginTop = '6px';
    body.appendChild(field('PDF 转换引擎', engineSel));
    body.appendChild(engineHint);
    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
    const sizeSel = select(FONT_OPTS, '11');
    body.appendChild(field('正文字号（仅内置引擎生效）', sizeSel));

    const goBtn = button('一键转换（HTML 文件 + PDF）', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(note, panel.el, wsCard, pvCard, card, goBtn, resultBox);

    // ---- 编辑器状态 ----
    const editHint = wsHead.querySelector('.edit-hint');
    const pvStatus = pvHead.querySelector('.pv-status');
    function setText(text, source) {
      ta.value = text;
      editHint.textContent = source ? `来源：${source} · 可在下方修改后再转换` : '粘贴网页源码，或用网址/上传自动载入';
      countEl.textContent = text.length ? `${text.length} 字符` : '';
      goBtn.disabled = !text.trim();
      schedulePreview();
    }
    let pvTimer = null;
    function schedulePreview(delay = 500) {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(refreshPreview, delay);
    }
    function refreshPreview() {
      const text = ta.value.trim();
      if (!text) {
        pvFrame.style.display = 'none';
        pvFrame.srcdoc = '';
        pvStatus.textContent = '待输入';
        return;
      }
      pvFrame.style.display = '';
      pvFrame.srcdoc = ensureFullHtml(ta.value);
      pvStatus.textContent = `已更新 ${new Date().toTimeString().slice(0, 5)}`;
    }
    ta.addEventListener('input', () => {
      const n = ta.value.length;
      countEl.textContent = n ? `${n} 字符` : '';
      editHint.textContent = '来源：手动粘贴 · 可在下方修改后再转换';
      goBtn.disabled = !ta.value.trim();
      schedulePreview();
    });
    clearBtn.addEventListener('click', () => {
      panel.clear();
      setText('', '');
      state.name = '网页';
      urlInp.value = '';
    });

    // ---- 网址抓取（载入编辑器让用户检视/修改，不直接转换） ----
    async function fetchIntoEditor() {
      const url = urlInp.value.trim();
      if (!url) { toast('请输入网址', 'error'); return; }
      const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      fetchBtn.disabled = true;
      fetchBtn.textContent = '抓取中…';
      try {
        const resp = await fetch(target, { redirect: 'follow' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = decodeText(new Uint8Array(await resp.arrayBuffer()));
        const host = new URL(target).hostname;
        state.name = host;
        setText(html, '网址直抓');
        toast('已载入编辑器，可修改后转换');
      } catch (e) {
        toast(`抓取失败：${e.message}。多数网站禁止跨域读取（CORS），请复制源码粘贴或上传 HTML 文件`, 'error', 8000);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '抓取到编辑器';
      }
    }

    // ---- 一键转换：产出 HTML 文件 + PDF ----
    const exec = runWithProgress(resultBox, async (setP) => {
      const engine = engineSel.value;
      let finalHtml;
      let source;
      let baseName;
      if (ta.value.trim()) {
        setP(15, '解析 HTML 源码…');
        finalHtml = ensureFullHtml(ta.value);
        source = '编辑器源码';
        baseName = deriveName(finalHtml, state.name);
      } else {
        const url = urlInp.value.trim();
        if (!url) throw new Error('请先粘贴 HTML 源码、输入网址或上传 HTML 文件');
        const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        setP(15, `抓取 ${target} …`);
        try {
          const resp = await fetch(target, { redirect: 'follow' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          finalHtml = decodeText(new Uint8Array(await resp.arrayBuffer()));
        } catch (e) {
          throw new Error(`抓取失败：${e.message}。多数网站禁止跨域读取（CORS），请打开网页复制源码粘贴，或「另存为完整 HTML」后上传。`);
        }
        source = '网址直抓';
        let host = '网页';
        try { host = new URL(target).hostname; } catch { /* 忽略 */ }
        baseName = deriveName(finalHtml, host);
        setP(40, '解析 HTML…');
      }

      // 产物 1：HTML 文件（源码快照，片段自动包壳保证可直接打开）
      const htmlArt = { name: `${baseName}.html`, bytes: new TextEncoder().encode(finalHtml), mime: 'text/html' };
      addResultArtifacts([htmlArt]);

      // 引擎二：浏览器打印引擎（高保真，PDF 在对话框另存）
      if (engine === 'print') {
        setP(60, '渲染打印页面…');
        await printViaIframe(finalHtml, { paper: paperSel.value });
        setP(95, '已调起打印');
        resultBox.appendChild(resultCard({
          arts: [htmlArt],
          summary: { 输出: 'HTML 文件已生成', PDF: '请在打印对话框另存' },
          toolId: 'webpage', toolName: '网页转 PDF',
          docNames: [source],
          options: { source, engine: 'print', paper: paperSel.value },
          extraNote: 'PDF 由浏览器打印引擎生成：打印对话框中目标打印机选「另存为 PDF」，建议勾选「背景图形」。脚本已剔除，样式保真。',
        }));
        toast('已调起打印：选择「另存为 PDF」导出');
        return {};
      }

      // 引擎一：内置文本引擎（正文抽取 → 可选中文字 PDF）
      const { blocks, title } = parseHtml(finalHtml);
      if (!blocks.length) throw new Error('页面中没有可提取的文字');
      const res = await run('text.toPdf', {
        name: baseName,
        blocks,
        paper: paperSel.value,
        margin: 48,
        fontSize: Number(sizeSel.value) || 11,
        title: title || baseName,
      }, {
        onProgress: (p) => setP(45 + (p.done / p.total) * 50, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: [...res.artifacts, htmlArt], // PDF 第一个：结果卡首行即主产物
        summary: { 页数: res.summary.pages, 输出: 'HTML 文件 + PDF' },
        toolId: 'webpage', toolName: '网页转 PDF',
        docNames: [source],
        options: { source, engine: 'builtin', paper: paperSel.value, fontSize: Number(sizeSel.value) || 11 },
        extraNote: 'PDF 为正文重排（去除脚本样式，文字可选中可复制）；HTML 文件为完整源码快照，双击可直接打开。',
      }));
      return {};
    });
  },
});
