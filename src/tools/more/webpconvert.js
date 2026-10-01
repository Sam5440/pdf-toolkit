// WebP 转 JPG/PNG（更多 · 对齐 PDF24 webp-to-jpg）：多选重编码，多产物（resultCard 自带 ZIP）
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { field, select, numberInput, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'webpconvert',
  name: 'WebP 转 JPG/PNG',
  group: 'more',
  desc: '批量 WebP 图像格式转换',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { docs: [] };

    const panel = inputPanel({
      multiple: true,
      accept: '.webp,image/webp',
      acceptTest: /\.webp$/i,
      acceptHint: '可多选 .webp 文件（批量转换，完成后可打包 ZIP）',
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
      if (!docs.length) throw new Error('请先选择 WebP 文件');
      const fmt = fmtSel.value === 'png' ? 'png' : 'jpeg';
      const quality = Math.min(100, Math.max(1, Number(qInp.value) || 90)) / 100;
      const artifacts = [];
      const warnings = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        setP((i / docs.length) * 95, `转换 ${doc.name}（${i + 1}/${docs.length}）`);
        let bmp;
        try {
          bmp = await createImageBitmap(doc.file);
        } catch {
          warnings.push(`${doc.name}：浏览器无法解码该 WebP 文件，已跳过`);
          continue;
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
            name: `${doc.name.replace(/\.webp$/i, '')}.${fmt === 'png' ? 'png' : 'jpg'}`,
            mime: type,
            bytes: new Uint8Array(await blob.arrayBuffer()),
          });
        } finally {
          bmp.close();
        }
      }
      if (!artifacts.length) {
        throw new Error(`没有可转换的文件：${warnings.join('；') || '未知原因'}`);
      }
      resultBox.appendChild(resultCard({
        arts: artifacts,
        summary: { 转换: artifacts.length, 格式: fmt.toUpperCase() },
        toolId: 'webpconvert', toolName: 'WebP 转 JPG/PNG',
        docNames: docs.map((d) => d.name),
        options: { format: fmt, quality: Math.round(quality * 100) },
        warnings,
      }));
      return { artifacts };
    });
  },
});
