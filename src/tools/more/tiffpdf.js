// TIFF 转 PDF（更多 · 对齐 PDF24 tiff-to-pdf）：decodeTiff 主线程解码 → 每页 PNG → images.toPdf
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { decodeTiff } from '../../core/tiff.js';

registerTool({
  id: 'tiffpdf',
  name: 'TIFF 转 PDF',
  group: 'more',
  desc: '多页 TIFF 转换为 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: '.tif,.tiff,image/tiff',
      acceptTest: /\.(tif|tiff)$/i,
      acceptHint: '选择 1 个 .tif / .tiff 文件（多页 TIFF 每页转为 PDF 一页）',
      onAdd(added) {
        state.doc = added.length ? added[added.length - 1] : null;
        goBtn.disabled = !state.doc;
      },
      onRemove() {
        if (!panel.docs().length) { state.doc = null; goBtn.disabled = true; }
      },
    });

    const { card, body } = paramsCard();
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

    const exec = runWithProgress(resultBox, async (setP) => {
      const doc = state.doc;
      if (!doc) throw new Error('请先选择文件');
      setP(10, '解码 TIFF…');
      const bytes = new Uint8Array(await doc.file.arrayBuffer());
      let pages;
      try {
        pages = await decodeTiff(bytes);
      } catch (e) {
        throw new Error(`TIFF 解码失败：${e.message}（支持的压缩：无压缩/LZW/PackBits/Deflate）`);
      }
      const images = [];
      for (let i = 0; i < pages.length; i++) {
        const pg = pages[i];
        const canvas = document.createElement('canvas');
        canvas.width = pg.w;
        canvas.height = pg.h;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(pg.data, pg.w, pg.h), 0, 0);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', name: doc.name });
        setP(10 + ((i + 1) / pages.length) * 50, `第 ${i + 1}/${pages.length} 页转 PNG`);
      }
      const res = await run('images.toPdf', {
        images,
        paper: paperSel.value,
        orientation: 'auto',
        margin: 0,
        fit: 'contain',
      }, {
        onProgress: (p) => setP(p.total ? 60 + (p.done / p.total) * 40 : 80, p.stage),
      }, new Map());
      res.artifacts = res.artifacts.map((a) => ({ ...a, name: `${doc.name.replace(/\.(tif|tiff)$/i, '') || 'TIFF'}.pdf` }));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'tiffpdf', toolName: 'TIFF 转 PDF',
        docNames: [doc.name],
        options: { paper: paperSel.value },
      }));
      return res;
    });
  },
});
