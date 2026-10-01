// 生成二维码（更多 · 对齐 PDF24 qr-code-generator）：qrMatrix/qrToCanvas 预览 + PNG 下载
import { registerTool } from '../core.js';
import { field, select, numberInput, textInput, button, toast } from '../../components/ui.js';
import { paramsCard, resultCard } from './common.js';
import { qrMatrix, qrToCanvas } from '../../core/qr.js';

registerTool({
  id: 'qrcode',
  name: '生成二维码',
  group: 'more',
  desc: '文本/网址生成二维码 PNG（可选嵌入 PDF）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const { card, body } = paramsCard();

    const txtInp = textInput('', '输入文字、网址或任意内容');
    txtInp.setAttribute('data-qr-text', '');
    body.appendChild(field('内容', txtInp));

    const ecSel = select([
      { value: 'L', label: 'L（容错 7%，容量最大）' },
      { value: 'M', label: 'M（容错 15%，推荐）' },
      { value: 'Q', label: 'Q（容错 25%）' },
      { value: 'H', label: 'H（容错 30%）' },
    ], 'M');
    body.appendChild(field('纠错级别', ecSel));

    const scaleInp = numberInput(8, { min: 4, max: 16, step: 1 });
    body.appendChild(field('缩放（像素/模块）', scaleInp, '越大图片越清晰，4-16'));

    const genBtn = button('生成二维码', 'btn-primary', () => generate());
    genBtn.style.cssText = 'width:100%;margin-top:14px';
    genBtn.disabled = true;
    txtInp.addEventListener('input', () => { genBtn.disabled = !txtInp.value.trim(); });

    const preview = document.createElement('div');
    preview.setAttribute('data-qr-preview', '');
    preview.style.cssText = 'display:flex;justify-content:center;padding:12px;margin-top:14px';
    const resultBox = document.createElement('div');

    container.append(card, genBtn, preview, resultBox);

    async function generate() {
      const text = txtInp.value.trim();
      if (!text) { toast('请输入内容', 'error'); return; }
      const scale = Math.min(16, Math.max(4, Math.round(Number(scaleInp.value) || 8)));
      try {
        const matrix = qrMatrix(text, ecSel.value);
        const canvas = qrToCanvas(matrix, { scale });
        canvas.style.cssText = 'max-width:260px;max-height:260px;width:auto;height:auto;image-rendering:pixelated;border:1px solid var(--border);border-radius:8px';
        preview.replaceChildren(canvas);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const art = {
          name: '二维码.png',
          mime: 'image/png',
          bytes: new Uint8Array(await blob.arrayBuffer()),
        };
        resultBox.replaceChildren(resultCard({
          arts: [art],
          summary: { 版本: matrix.version, 纠错: ecSel.value },
          toolId: 'qrcode', toolName: '生成二维码',
          docNames: [],
          options: { ecLevel: ecSel.value, scale },
        }));
      } catch (e) {
        preview.replaceChildren();
        resultBox.replaceChildren();
        toast(e.message || '生成失败', 'error', 5000);
      }
    }
  },
});
