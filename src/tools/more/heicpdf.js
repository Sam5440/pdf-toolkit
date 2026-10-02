// HEIC 转 PDF（更多 · 对齐 PDF24 heic-to-pdf）：createImageBitmap 解码（Chromium 不支持 HEIC 时给明确提示）
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

const HEIC_HINT = '当前浏览器不支持 HEIC 解码，请用 Safari 或先转换格式';

/** HEIC File → PNG bytes（解码失败抛出带明确提示的错误） */
async function heicToPng(doc) {
  const bytes = new Uint8Array(await doc.file.arrayBuffer());
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }));
  } catch {
    throw new Error(`${HEIC_HINT}（文件：${doc.name}）`);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    // HEIC 常带 EXIF 方向，createImageBitmap 已按 from-image 处理
    ctx.drawImage(bmp, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', name: doc.name };
  } finally {
    bmp.close();
  }
}

registerTool({
  id: 'heicpdf',
  name: 'HEIC 转 PDF',
  group: 'm-topdf',
  desc: 'iPhone HEIC 照片转换为 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { docs: [] };

    const panel = inputPanel({
      multiple: true,
      accept: '.heic,.heif,image/heic,image/heif',
      acceptTest: /\.(heic|heif)$/i,
      acceptHint: '可多选 .heic / .heif 照片（Chrome/Firefox 通常不支持 HEIC，Safari 可直接解码）',
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
      const docs = [...state.docs];
      if (!docs.length) throw new Error('请先选择 HEIC 文件');
      const images = [];
      const warnings = [];
      for (let i = 0; i < docs.length; i++) {
        setP((i / docs.length) * 70, `解码 ${docs[i].name}（${i + 1}/${docs.length}）`);
        try {
          images.push(await heicToPng(docs[i]));
        } catch (e) {
          if (/不支持 HEIC/.test(e.message)) throw e; // 浏览器能力问题直接终止并提示
          warnings.push(`${docs[i].name} 解码失败：${e.message}`);
        }
      }
      const res = await run('images.toPdf', {
        images,
        paper: paperSel.value,
        orientation: 'auto',
        margin: 0,
        fit: 'contain',
      }, {
        onProgress: (p) => setP(p.total ? 70 + (p.done / p.total) * 30 : 85, p.stage),
      }, new Map());
      res.artifacts = res.artifacts.map((a) => ({ ...a, name: 'HEIC照片.pdf' }));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'heicpdf', toolName: 'HEIC 转 PDF',
        docNames: docs.map((d) => d.name),
        options: { paper: paperSel.value },
        warnings,
      }));
      return res;
    });
  },
});
