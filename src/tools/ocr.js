// OCR 文字识别 — Tesseract.js 本地语言包，输出可搜索 PDF（图像页+不可见文字层）与 .txt
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run, abort } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { progressCard, warningsBox, toast, field, textInput, select, checkbox, row, button } from '../components/ui.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { downloadArtifact, downloadZip } from '../core/download.js';

const LANGS = [
  ['chi_sim', '简体中文'],
  ['chi_tra', '繁体中文'],
  ['eng', '英文'],
];

registerTool({
  id: 'ocr',
  name: 'OCR 文字识别',
  group: 'content',
  desc: '扫描件识别为可搜索 PDF 与文本，支持中英繁等多语言',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '扫描件/图片型 PDF；识别在本地 WASM 内完成，语言包随站点本地加载',
    });

    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    // 语言多选
    const langBox = document.createElement('div');
    langBox.className = 'field';
    const ll = document.createElement('label');
    ll.textContent = '识别语言（可多选）';
    langBox.appendChild(ll);
    const langChecks = {};
    for (const [code, label] of LANGS) {
      const c = checkbox(label, code === 'eng' || code === 'chi_sim');
      langChecks[code] = c._input;
      langBox.appendChild(c);
    }
    body.appendChild(langBox);

    body.appendChild(field('渲染 DPI（越高越准、越慢）', select([
      { value: '150', label: '150（快）' }, { value: '200', label: '200（推荐）' }, { value: '300', label: '300（精）' },
    ], '200')));
    body.appendChild(field('输出', select([
      { value: 'both', label: '可搜索 PDF + 纯文本 TXT' },
      { value: 'searchable', label: '仅可搜索 PDF' },
      { value: 'text', label: '仅纯文本 TXT' },
    ], 'both')));
    body.appendChild(field('页范围', textInput('', '如 1-3,5；留空 = 全部页')));
    body.appendChild(field('文字探测模式', select([
      { value: 'auto', label: '自动（已含文字层的页直接提取，不重复 OCR）' },
      { value: 'ocr', label: '强制 OCR（每页都识别）' },
      { value: 'searchable', label: '仅可搜索 PDF 模式' },
    ], 'auto')));

    const goBtn = button('开始识别', 'btn-primary', () => doOcr());
    goBtn.style.width = '100%';
    const cancelBtn = button('取消', 'btn-outline', () => { if (opId) abort(opId); });
    cancelBtn.style.display = 'none';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px';
    btnRow.append(goBtn, cancelBtn);
    goBtn.style.flex = '1';
    body.appendChild(btnRow);
    controls.appendChild(body);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';
    container.append(panel.el, controls, resultBox);

    let opId = null;

    async function doOcr() {
      const docs = panel.docs();
      resultBox.innerHTML = '';
      if (!docs.length) { toast('请先选择 PDF 文件', 'error'); return; }
      const doc = docs[0];
      const langs = Object.entries(langChecks).filter(([, c]) => c.checked).map(([k]) => k);
      if (!langs.length) { toast('请至少选择一种语言', 'error'); return; }
      const dpi = parseInt(body.querySelectorAll('select')[0].value, 10);
      const output = body.querySelectorAll('select')[1].value;
      const pages = body.querySelector('input[type=text]').value.trim() || 'all';
      const mode = body.querySelectorAll('select')[2].value;

      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      cancelBtn.style.display = '';
      try {
        const docsMap = new Map([[doc.id, doc]]);
        const res = await run('ocr.run', {
          docId: doc.id, pages, langs: langs.join('+'), dpi, mode,
        }, {
          onProgress(p) { if (p.total) pc.set((p.done / p.total) * 100, p.stage); else pc.indeterminate(p.stage); },
          onSpawn(id) { opId = id; },
        }, docsMap);
        pc.done();
        renderResult(res, doc, { langs: langs.join('+'), dpi, output, pages, mode });
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
        cancelBtn.style.display = 'none';
        opId = null;
      }
    }

    function renderResult(res, doc, options) {
      const { ocrPages, nativePages } = res.summary;
      // 引擎恒产出两种产物，按用户选择的输出类型过滤
      const arts = res.artifacts.filter((a) => options.output === 'both'
        || (options.output === 'searchable' ? a.name.endsWith('.pdf') : a.name.endsWith('.txt')));
      const card = document.createElement('div');
      card.className = 'card';
      const cb = document.createElement('div');
      cb.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.innerHTML = `${iconSvg('success')} 识别完成：OCR ${ocrPages} 页 · 原生文字直接提取 ${nativePages} 页${res.summary.wordCount != null ? ` · 识别词数 ${res.summary.wordCount}` : ''}${res.summary.fontErr ? ` · 字体错误:${res.summary.fontErr}` : ''}${res.summary.drawErr ? ` · 绘制错误:${res.summary.drawErr}` : ''}`;
      cb.appendChild(kv);

      if (nativePages > 0 && ocrPages === 0) {
        const tip = document.createElement('div');
        tip.className = 'alert alert-info';
        tip.style.marginTop = '8px';
        tip.textContent = '该文档已含文字层，已直接提取未 OCR；如需强制重新识别请把模式改为「强制 OCR」。';
        cb.appendChild(tip);
      }
      const w = warningsBox(res.warnings);
      if (w) { w.style.marginTop = '8px'; cb.appendChild(w); }

      // 产物行
      for (const art of arts) {
        const line = document.createElement('div');
        line.className = 'result-artifact';
        const info = document.createElement('div');
        info.className = 'kv';
        info.innerHTML = `${iconSvg('doc')} ${art.name} · ${art.bytes.byteLength.toLocaleString()} 字节`;
        const right = document.createElement('div');
        right.appendChild(button('下载', 'btn-outline btn-sm', () => downloadArtifact(art)));
        line.append(info, right);
        cb.appendChild(line);
      }
      if (arts.length > 1) {
        const line = document.createElement('div');
        line.className = 'result-artifact';
        const info = document.createElement('div');
        info.textContent = '打包下载全部产物';
        const right = document.createElement('div');
        right.appendChild(button('ZIP 打包下载', 'btn-outline btn-sm', () => downloadZip(arts, 'OCR结果.zip')));
        line.append(info, right);
        cb.appendChild(line);
      }

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
      cb.appendChild(actions);
      recordTaskOrButton({
        tool: 'ocr', toolName: 'OCR 文字识别',
        docNames: [doc.name],
        options,
        docs: [doc],
        outputs: arts.map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.byteLength, blob: new Blob([a.bytes], { type: a.mime }) })),
        form: capturePageForm(),
      }).then((recBtn) => {
        if (recBtn) actions.appendChild(recBtn);
        else cb.appendChild(recordNote());
      });
      card.appendChild(cb);
      resultBox.appendChild(card);
    }
  },
});
