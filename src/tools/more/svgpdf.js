// SVG 转 PDF（更多 · 对齐 PDF24 svg-to-pdf）：多选 SVG → Image 光栅化（2x）→ images.toPdf
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'svgpdf',
  name: 'SVG 转 PDF',
  group: 'more',
  desc: 'SVG 矢量图转换为 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { docs: [] };

    const panel = inputPanel({
      multiple: true,
      accept: '.svg,image/svg+xml',
      acceptTest: /\.svg$/i,
      acceptHint: '可多选 .svg 文件（每个 SVG 一页，光栅化后合并为 PDF）',
      onAdd(added) {
        state.docs = panel.docs();
        goBtn.disabled = !state.docs.length;
      },
      onRemove() {
        state.docs = panel.docs();
        goBtn.disabled = !state.docs.length;
      },
    });

    const { card, body } = paramsCard();
    const fitSel = select([
      { value: 'contain', label: '完整放入页面（留白）' },
      { value: 'cover', label: '填充页面（裁切超界）' },
    ], 'contain');
    body.appendChild(field('适应方式', fitSel));
    const paperSel = select([
      { value: 'auto', label: '随图片尺寸（推荐）' },
      { value: 'a4', label: 'A4' },
      { value: 'letter', label: 'Letter' },
      { value: 'a3', label: 'A3' },
      { value: 'a5', label: 'A5' },
    ], 'auto');
    body.appendChild(field('纸张', paperSel));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    /** 单个 SVG → PNG bytes（2x 光栅化；上限 4096px 防超大画布） */
    async function svgToPng(doc) {
      const url = URL.createObjectURL(doc.file);
      try {
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch {
          throw new Error(`无法解析 SVG：${doc.name}（文件可能损坏或不是有效 SVG）`);
        }
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error(`SVG ${doc.name} 缺少 width/height 或 viewBox，无法确定尺寸`);
        const k = Math.min(2, 4096 / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * k));
        canvas.height = Math.max(1, Math.round(h * k));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        if (!blob) throw new Error(`SVG ${doc.name} 光栅化失败`);
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', name: doc.name };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const exec = runWithProgress(resultBox, async (setP) => {
      const docs = [...state.docs];
      if (!docs.length) throw new Error('请先选择 SVG 文件');
      const images = [];
      for (let i = 0; i < docs.length; i++) {
        setP((i / docs.length) * 60, `光栅化 ${docs[i].name}（${i + 1}/${docs.length}）`);
        images.push(await svgToPng(docs[i]));
      }
      const res = await run('images.toPdf', {
        images,
        paper: paperSel.value,
        orientation: 'auto',
        margin: 24,
        fit: fitSel.value,
      }, {
        onProgress: (p) => setP(p.total ? 60 + (p.done / p.total) * 40 : 80, p.stage),
      }, new Map());
      res.artifacts = res.artifacts.map((a) => ({ ...a, name: docs.length > 1 ? 'SVG合并.pdf' : 'SVG转换.pdf' }));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, 图: images.length },
        toolId: 'svgpdf', toolName: 'SVG 转 PDF',
        docNames: docs.map((d) => d.name),
        options: { paper: paperSel.value, fit: fitSel.value },
        extraNote: 'SVG 以 2x 分辨率光栅化后嵌入（保证清晰度）；文字不作为矢量保留。',
      }));
      return res;
    });
  },
});
