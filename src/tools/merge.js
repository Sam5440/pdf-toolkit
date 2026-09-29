// 合并 PDF — 参考实现（其余工具按同样模式开发）
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { addDocument } from '../core/files.js';
import { progressCard, warningsBox, toast, field, textInput, button } from '../components/ui.js';
import { fmtBytes } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact } from '../core/download.js';

const IMG_EXT = /\.(jpe?g|png|webp)$/i;
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

registerTool({
  id: 'merge',
  name: '合并 PDF',
  group: 'pages',
  desc: '多个 PDF 与图片混合按顺序合并为一个文件，PDF 可各自选择页范围',
  accepts: 'pdf',
  multiple: true,
  render(container) {
    const panel = inputPanel({
      multiple: true,
      accept: 'application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
      acceptTest: /\.(pdf|jpe?g|png|webp)$/i,
      acceptHint: '支持多个 PDF 与图片（JPG/PNG/WebP）混合，处理全程在本地浏览器完成',
    });
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';
    const rangeField = field('页范围（可选，每行对应一个文件，留空=全部页；图片项恒为整页）',
      textInput('', '如 1-3,5（多个文件用逗号分隔对应，或留空）'),
      '示例：第一个文件取 1-3 页、第二个文件全部页 → 填 "1-3,"');
    const goBtn = button('开始合并', 'btn-primary', () => doMerge());
    goBtn.style.width = '100%';
    body.append(rangeField, goBtn);
    controls.appendChild(body);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';
    container.append(panel.el, controls, resultBox);

    async function doMerge() {
      let docs = panel.docs();
      resultBox.innerHTML = '';
      if (!docs.length) { toast('请先选择 PDF 或图片文件', 'error'); return; }
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      const t0 = Date.now();
      try {
        const isImg = (d) => IMG_EXT.test(d.name) || (d.type || '').startsWith('image/');
        const imgSlots = new Set(); // 原始列表里图片项的位置（转页后仍占用原槽位，不消耗页范围）
        docs.forEach((d, i) => { if (isImg(d)) imgSlots.add(i); });
        // 图片项先转为"图片即一页"的单页 PDF 文档，再按添加顺序参与合并
        const imgDocs = docs.filter(isImg);
        if (imgDocs.length) {
          let done = 0;
          for (const d of imgDocs) {
            const bytes = new Uint8Array(await d.file.arrayBuffer());
            const m = /\.([a-z0-9]+)$/i.exec(d.name);
            const res = await run('images.toPdf', {
              images: [{ name: d.name, bytes, mime: d.type || (m ? EXT_MIME[m[1].toLowerCase()] : '') || '' }],
              paper: 'auto', fit: 'contain',
            }, {}, new Map());
            const f = new File([res.artifacts[0].bytes], `${d.name.replace(IMG_EXT, '')}.pdf`, { type: 'application/pdf' });
            const nd = addDocument(f);
            docs = docs.map((x) => (x.id === d.id ? nd : x));
            done += 1;
            pc.set(Math.round((done / imgDocs.length) * 40), `图片转页 ${done}/${imgDocs.length}`);
          }
        }
        pc.set(60, '合并中…');
        const ranges = rangeField.querySelector('input').value.trim();
        const rangeList = ranges ? ranges.split(',').map((s) => s.trim()) : [];
        const items = docs.map((d, i) => ({ docId: d.id, pages: imgSlots.has(i) ? 'all' : (rangeList[i] || 'all') }));
        const docsMap = new Map(docs.map((d) => [d.id, d]));
        const res = await run('pages.merge', { items }, {}, docsMap);
        pc.done();
        const [art] = res.artifacts;
        const info = document.createElement('div');
        info.className = 'card';
        const ib = document.createElement('div');
        ib.className = 'card-body';
        ib.innerHTML = `
          <div class="kv">${iconSvg('success')} 合并完成：<b>${res.summary.pages}</b> 页 · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round((Date.now() - t0) / 100) / 10}s</div>`;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
        const dl = button('下载合并结果', 'btn-primary', () => downloadArtifact(art));
        const save = button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'merge', toolName: '合并 PDF',
            docNames: docs.map((d) => d.name),
            options: { ranges: ranges || '全部' },
            outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
          });
          toast('已保存到历史');
        });
        actions.append(dl, save);
        ib.appendChild(actions);
        const w = warningsBox(res.warnings);
        if (w) ib.appendChild(w);
        info.appendChild(ib);
        resultBox.appendChild(info);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      }
    }
  },
});
