// 图片文字识别（更多 · 与 OCR 文字识别配对）：直接上传 JPG/PNG 等图片，
// 走引擎 Worker 内同一 Tesseract 管线（ocr.image op），语言包本地加载，不联网。
import { registerTool } from '../core.js';
import { run, abort } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, checkbox, select, button, toast, progressCard, warningsBox } from '../../components/ui.js';
import { paramsCard, resultCard } from './common.js';

const LANGS = [
  ['chi_sim', '简体中文'],
  ['chi_tra', '繁体中文'],
  ['eng', '英文'],
];

registerTool({
  id: 'imgocr',
  name: '图片文字识别',
  group: 'm-util',
  desc: 'JPG/PNG/WebP 等图片直接 OCR 出文本（.txt），中英繁多语言，本地识别',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const state = { docs: [] };

    const panel = inputPanel({
      multiple: true,
      accept: 'image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp',
      acceptTest: /\.(png|jpe?g|webp|bmp)$/i,
      acceptHint: '可多选图片；识别在本地 WASM 内完成，语言包随站点本地加载',
      onAdd() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
      onRemove() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
    });

    const { card, body } = paramsCard();

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

    body.appendChild(field('输出', select([
      { value: 'perfile', label: '每张图片一个 TXT' },
      { value: 'merged', label: '合并为一个 TXT' },
    ], 'perfile')));

    const goBtn = button('开始识别', 'btn-primary', () => doOcr());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;
    const cancelBtn = button('取消', 'btn-outline', () => { if (opId) abort(opId); });
    cancelBtn.style.display = 'none';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px';
    goBtn.style.flex = '1';
    btnRow.append(goBtn, cancelBtn);

    const resultBox = document.createElement('div');
    container.append(panel.el, card, btnRow, resultBox);

    let opId = null;

    async function doOcr() {
      const docs = [...state.docs];
      resultBox.replaceChildren();
      if (!docs.length) { toast('请先选择图片', 'error'); return; }
      const langs = Object.entries(langChecks).filter(([, c]) => c.checked).map(([k]) => k);
      if (!langs.length) { toast('请至少选择一种语言', 'error'); return; }
      const merged = body.querySelectorAll('select')[0].value === 'merged';

      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      cancelBtn.style.display = '';
      try {
        const arts = [];
        const warns = [];
        for (let i = 0; i < docs.length; i++) {
          const doc = docs[i];
          pc.set((i / docs.length) * 95, `识别 ${doc.name}（${i + 1}/${docs.length}）`);
          const bytes = new Uint8Array(await doc.file.arrayBuffer());
          const res = await run('ocr.image', {
            name: doc.name, bytes, langs: langs.join('+'),
          }, {
            onProgress(p) { if (p.total) pc.set(Math.min(99, ((i + p.done / p.total) / docs.length) * 95), p.stage); },
            onSpawn(id) { opId = id; },
          }, new Map());
          if (res.warnings) warns.push(...res.warnings);
          arts.push(...res.artifacts);
        }
        pc.done();
        const outArts = merged ? [{
          name: '图片文字识别.txt',
          mime: 'text/plain;charset=utf-8',
          bytes: new TextEncoder().encode(arts.map((a) => new TextDecoder().decode(a.bytes)).join('\n\n')),
        }] : arts;
        resultBox.appendChild(resultCard({
          arts: outArts,
          summary: { 图片: docs.length, 文本: outArts.length },
          toolId: 'imgocr', toolName: '图片文字识别',
          docNames: docs.map((d) => d.name),
          options: { langs: langs.join('+'), merged },
          warnings: warns,
        }));
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
        cancelBtn.style.display = 'none';
        opId = null;
      }
    }
  },
});
