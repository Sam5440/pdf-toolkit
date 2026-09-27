// 合并 PDF — 参考实现（其余工具按同样模式开发）
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { progressCard, warningsBox, toast, field, textInput, button } from '../components/ui.js';
import { fmtBytes } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact } from '../core/download.js';

registerTool({
  id: 'merge',
  name: '合并 PDF',
  group: 'pages',
  desc: '多个 PDF 按顺序合并为一个文件，可各自选择页范围',
  accepts: 'pdf',
  multiple: true,
  render(container) {
    const panel = inputPanel({
      multiple: true,
      accept: 'application/pdf,.pdf',
      acceptHint: '支持多个 PDF，处理全程在本地浏览器完成',
    });
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';
    const rangeField = field('页范围（可选，每行对应一个文件，留空=全部页）',
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
      const docs = panel.docs();
      resultBox.innerHTML = '';
      if (!docs.length) { toast('请先选择 PDF 文件', 'error'); return; }
      const ranges = rangeField.querySelector('input').value.trim();
      const rangeList = ranges ? ranges.split(',').map((s) => s.trim()) : [];
      const items = docs.map((d, i) => ({ docId: d.id, pages: rangeList[i] || 'all' }));
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(30, '合并中…');
      const t0 = Date.now();
      try {
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
