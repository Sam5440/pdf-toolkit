// HEIC 转 JPG/PNG（更多 · 对齐 PDF24 heic-to-jpg）：createImageBitmap 解码（Chromium 通常不支持，给明确提示）
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { field, select, numberInput, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { addResultArtifacts } from '../../core/tray.js';
import { buildOutputName, paramsToken } from '../../core/naming.js';

const HEIC_HINT = '当前浏览器不支持 HEIC 解码，请用 Safari 或先转换格式';

registerTool({
  id: 'heicconvert',
  name: 'HEIC 转 JPG/PNG',
  group: 'm-img',
  desc: 'HEIC 照片格式转换',
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
    const fmtSel = select([
      { value: 'jpeg', label: 'JPG（有损，体积小）' },
      { value: 'png', label: 'PNG（无损，支持透明）' },
    ], 'jpeg');
    body.appendChild(field('目标格式', fmtSel));
    const qInp = numberInput(90, { min: 1, max: 100, step: 1 });
    body.appendChild(field('JPG 质量（%）', qInp, '仅 JPG 有效；PNG 忽略'));

    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const docs = [...state.docs];
      if (!docs.length) throw new Error('请先选择 HEIC 文件');
      const fmt = fmtSel.value === 'png' ? 'png' : 'jpeg';
      const quality = Math.min(100, Math.max(1, Number(qInp.value) || 90)) / 100;
      const artifacts = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        setP((i / docs.length) * 95, `转换 ${doc.name}（${i + 1}/${docs.length}）`);
        const bytes = new Uint8Array(await doc.file.arrayBuffer());
        let bmp;
        try {
          bmp = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }));
        } catch {
          // 浏览器解码能力缺失（Chromium 不带 HEIC 解码器），终止并给明确指引
          throw new Error(`${HEIC_HINT}（文件：${doc.name}）`);
        }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext('2d').drawImage(bmp, 0, 0);
          const type = fmt === 'png' ? 'image/png' : 'image/jpeg';
          const blob = await new Promise((r) => canvas.toBlob(r, type, quality));
          if (!blob) throw new Error('画布导出失败');
          artifacts.push({
            name: `${buildOutputName({ name: doc.name, op: '格式转换', params: paramsToken({ fmt, quality }) })}.${fmt === 'png' ? 'png' : 'jpg'}`,
            mime: type,
            bytes: new Uint8Array(await blob.arrayBuffer()),
          });
        } finally {
          bmp.close();
        }
      }
      // 本地构建的产物（不走引擎 run()）显式入暂存区：多产物归档到文件夹
      if (artifacts.length) {
        addResultArtifacts(artifacts, { folder: `HEIC 转换 · ${docs.length > 1 ? `${docs.length} 个文件` : docs[0].name.replace(/\.(heic|heif)$/i, '')}` });
      }
      resultBox.appendChild(resultCard({
        arts: artifacts,
        summary: { 转换: artifacts.length, 格式: fmt.toUpperCase() },
        toolId: 'heicconvert', toolName: 'HEIC 转 JPG/PNG',
        docNames: docs.map((d) => d.name),
        options: { format: fmt, quality: Math.round(quality * 100) },
      }));
      return { artifacts };
    });
  },
});
