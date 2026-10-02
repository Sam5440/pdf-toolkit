// 网页转 PDF（更多 · 对齐 PDF24 webpage-to-pdf）：网址直抓（受 CORS 限制）或上传 HTML → parseHtml → text.toPdf
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, textInput, button, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseHtml, parseToBlocks } from '../../core/importers.js';

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

registerTool({
  id: 'webpage',
  name: '网页转 PDF',
  group: 'm-topdf',
  desc: '输入网址或上传 HTML 转为 PDF（浏览器本地渲染，受 CORS 限制）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    // 隐私与限制说明（置顶）
    const note = document.createElement('div');
    note.className = 'note';
    note.style.marginBottom = '12px';
    note.textContent = '隐私模型：全部处理在本地浏览器完成，不会经服务器抓取网页。直接抓取网址受目标站点 CORS 限制，'
      + '多数网站会拒绝跨域读取；推荐将网页另存为 HTML 文件后上传转换。';

    const panel = inputPanel({
      multiple: false,
      accept: '.html,.htm,text/html',
      acceptTest: /\.(html?|xhtml)$/i,
      acceptHint: '推荐：上传 1 个 .html / .htm 文件（网页另存为的全文）',
      onAdd(added) {
        state.doc = added.length ? added[added.length - 1] : null;
        goBtn.disabled = !state.doc;
      },
      onRemove() {
        if (!panel.docs().length) { state.doc = null; goBtn.disabled = true; }
      },
    });

    const { card, body } = paramsCard();

    const urlInp = textInput('', 'https://example.com/page');
    urlInp.setAttribute('data-web-url', '');
    body.appendChild(field('网址（可选）', urlInp));
    const fetchBtn = button('尝试获取', 'btn-outline', () => fetchExec());
    fetchBtn.style.marginTop = '8px';
    body.appendChild(fetchBtn);

    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
    const sizeSel = select(FONT_OPTS, '11');
    body.appendChild(field('正文字号', sizeSel));

    const goBtn = button('转换上传的 HTML', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(note, panel.el, card, goBtn, resultBox);

    async function htmlToPdf(setP, html, fallbackName) {
      const { blocks, title } = parseHtml(html);
      if (!blocks.length) throw new Error('页面中没有可提取的文字');
      const name = String(title || fallbackName || '网页').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '网页';
      const res = await run('text.toPdf', {
        name,
        blocks,
        paper: paperSel.value,
        margin: 48,
        fontSize: Number(sizeSel.value) || 11,
        title,
      }, {
        onProgress: (p) => setP(p.total ? 30 + (p.done / p.total) * 70 : 60, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'webpage', toolName: '网页转 PDF',
        docNames: [fallbackName || urlInp.value.trim() || '网页'],
        options: { paper: paperSel.value, fontSize: Number(sizeSel.value) },
        extraNote: '仅提取文字内容重新排版（图片/布局/脚本不保留）。',
      }));
      return res;
    }

    const fetchExec = runWithProgress(resultBox, async (setP) => {
      const url = urlInp.value.trim();
      if (!url) throw new Error('请输入网址');
      const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      setP(15, `抓取 ${target} …`);
      let html;
      try {
        const resp = await fetch(target, { redirect: 'follow' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        html = await resp.text();
      } catch (e) {
        toast('无法直接抓取该网址（CORS 或网络限制），建议改用上传 HTML 文件', 'error', 5000);
        throw new Error(`抓取失败：${e.message}。多数网站禁止跨域读取（CORS），请将网页另存为 HTML 后上传转换。`);
      }
      setP(30, '解析 HTML…');
      let host = '网页';
      try { host = new URL(target).hostname; } catch { /* 忽略 */ }
      return htmlToPdf(setP, html, host);
    });

    const exec = runWithProgress(resultBox, async (setP) => {
      const doc = state.doc;
      if (!doc) throw new Error('请先上传 HTML 文件或输入网址');
      setP(15, '读取 HTML…');
      const bytes = new Uint8Array(await doc.file.arrayBuffer());
      const html = new TextDecoder('utf-8').decode(bytes);
      setP(30, '解析 HTML…');
      return htmlToPdf(setP, html, doc.name.replace(/\.(html?|xhtml)$/i, ''));
    });
  },
});
