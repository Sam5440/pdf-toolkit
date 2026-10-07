// 提取文本 — 从 PDF 提取原生文字层，按页范围输出 .txt
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run, abort } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { progressCard, warningsBox, toast, field, textInput, checkbox, button } from '../components/ui.js';
import { baseName } from '../core/format.js';
import { buildOutputName, paramsToken } from '../core/naming.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { downloadArtifact } from '../core/download.js';

registerTool({
  id: 'text',
  name: '提取文本',
  group: 'content',
  desc: '从 PDF 提取原生文字层，按页输出 .txt',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '仅提取原生文字层；扫描件（图像页）请使用 OCR 工具',
    });

    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';
    const pagesInput = textInput('', '如 1-3,5；留空 = 全部页');
    body.appendChild(field('页范围', pagesInput));
    const sepCheck = checkbox('按页分隔（每页前插入 "--- 第 N 页 ---"）', true);
    body.appendChild(field('输出格式', sepCheck));
    const goBtn = button('开始提取', 'btn-primary', () => doExtract());
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
    let lastResult = null;

    async function doExtract() {
      const docs = panel.docs();
      resultBox.innerHTML = '';
      if (!docs.length) { toast('请先选择 PDF 文件', 'error'); return; }
      const doc = docs[0];
      const pages = pagesInput.value.trim() || 'all';
      const sep = sepCheck._input.checked;
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      cancelBtn.style.display = '';
      try {
        const docsMap = new Map([[doc.id, doc]]);
        const res = await run('text.extract', { docId: doc.id, pages }, {
          onProgress(p) { if (p.total) pc.set((p.done / p.total) * 100, p.stage); else pc.indeterminate(p.stage); },
          onSpawn(id) { opId = id; },
        }, docsMap);
        pc.done();
        lastResult = { res, doc, sep };
        renderText(res, doc, sep, pages);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
        cancelBtn.style.display = 'none';
        opId = null;
      }
    }

    function buildTxt(res, sep) {
      const chunks = res.pages.map((p) => (sep ? `--- 第 ${p.page + 1} 页 ---\n${p.text}` : p.text));
      return chunks.join(sep ? '\n\n' : '\n');
    }

    function renderText(res, doc, sep, pages = 'all') {
      const total = res.pages.reduce((s, p) => s + p.chars, 0);
      const full = buildTxt(res, sep);
      const card = document.createElement('div');
      card.className = 'card';
      const cb = document.createElement('div');
      cb.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.innerHTML = `${iconSvg('success')} 提取完成：<b>${res.pages.length}</b> 页 · 共 ${total} 字符`;
      cb.appendChild(kv);

      const emptyPages = res.pages.filter((p) => !p.chars).length;
      if (emptyPages) {
        const tip = document.createElement('div');
        tip.className = 'alert alert-warn';
        tip.style.marginTop = '8px';
        tip.textContent = `${emptyPages} 页未提取到文字（可能是扫描件，请用「OCR 文字识别」工具处理扫描件）。`;
        cb.appendChild(tip);
      }

      const pre = document.createElement('pre');
      pre.className = 'text-preview';
      pre.style.cssText = 'max-height:320px;overflow:auto;background:var(--surface-2,#f6f7f9);padding:12px;border-radius:8px;font-size:12.5px;white-space:pre-wrap;word-break:break-word;margin-top:10px';
      pre.textContent = full.length > 2000 ? `${full.slice(0, 2000)}\n…（完整内容见下载文件）` : full;
      cb.appendChild(pre);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
      const art = {
        name: `${buildOutputName({ name: doc.name, op: '提取文字', params: paramsToken({ pages, sep }) })}.txt`,
        mime: 'text/plain;charset=utf-8',
        bytes: new TextEncoder().encode(full),
      };
      actions.appendChild(button('下载 TXT', 'btn-primary', () => downloadArtifact(art)));
      cb.appendChild(actions);
      recordTaskOrButton({
        tool: 'text', toolName: '提取文本',
        docNames: [doc.name],
        options: { pages, sep },
        docs: [doc],
        outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
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
