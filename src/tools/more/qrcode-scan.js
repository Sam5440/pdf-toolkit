// 识别二维码（更多 · 与「生成二维码」配对）：jsQR 纯本地解码图片中的二维码，全程无网络
import { registerTool } from '../core.js';
import jsQR from 'jsqr';
import { inputPanel } from '../../components/input.js';
import { button, toast } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';

const MAX_SIDE = 1600; // 解码前等比缩放的最大边长，防超大图卡顿

async function decodeQrFromDoc(doc) {
  let bmp;
  try {
    bmp = await createImageBitmap(doc.file);
  } catch {
    throw new Error('浏览器无法解码该图片');
  }
  let canvas;
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  } finally {
    bmp.close();
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!code) throw new Error('未在图片中找到二维码');
  return code.data || '';
}

registerTool({
  id: 'qrcode-scan',
  name: '识别二维码',
  group: 'm-util',
  desc: '从图片中识别二维码内容，纯本地解码，支持批量',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const state = { docs: [] };

    const panel = inputPanel({
      multiple: true,
      accept: 'image/png,image/jpeg,image/webp,image/bmp,image/gif,.png,.jpg,.jpeg,.webp,.bmp,.gif',
      acceptTest: /\.(png|jpe?g|webp|bmp|gif)$/i,
      acceptHint: '可多选含二维码的图片，全部在本地解码，不联网',
      onAdd() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
      onRemove() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
    });

    const goBtn = button('开始识别', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, goBtn, resultBox);

    function resultRow(text) {
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.style.wordBreak = 'break-all';
      nm.textContent = text;
      info.appendChild(nm);
      line.appendChild(info);
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
      right.appendChild(button('复制', 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
        catch { toast('复制失败，请手动选择文本复制', 'error'); }
      }));
      if (/^https?:\/\//i.test(text)) {
        right.appendChild(button('打开链接', 'btn-outline btn-sm', () => {
          window.open(text, '_blank', 'noopener');
        }));
      }
      line.appendChild(right);
      return line;
    }

    async function exec() {
      const docs = [...state.docs];
      resultBox.replaceChildren();
      if (!docs.length) { toast('请先选择图片', 'error'); return; }
      const card = document.createElement('div');
      card.className = 'card';
      const body = document.createElement('div');
      body.className = 'card-body';
      const list = document.createElement('div');
      list.style.marginTop = '4px';
      const texts = [];
      const fails = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const head = document.createElement('div');
        head.className = 'hint';
        head.style.marginTop = i ? '10px' : '2px';
        head.textContent = `${doc.name}`;
        list.appendChild(head);
        try {
          const text = await decodeQrFromDoc(doc);
          texts.push(text);
          list.appendChild(resultRow(text));
        } catch (e) {
          fails.push(`${doc.name}：${e.message}`);
          const err = document.createElement('div');
          err.className = 'alert alert-error';
          err.style.marginTop = '4px';
          err.textContent = e.message;
          list.appendChild(err);
        }
      }
      body.appendChild(list);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      if (texts.length && fails.length) {
        const note = document.createElement('div');
        note.className = 'note';
        note.style.cssText = 'margin-top:8px;width:100%';
        note.textContent = `其余 ${fails.length} 张图片未能识别`;
        body.appendChild(note);
      }
      recordTaskOrButton({
        tool: 'qrcode-scan', toolName: '识别二维码',
        docNames: docs.map((d) => d.name),
        options: { 识别: texts.length, 失败: fails.length },
        docs,
        outputs: [],
        form: capturePageForm(),
      }).then((btn) => {
        if (btn) actions.appendChild(btn);
        else body.appendChild(recordNote());
      }).catch(() => { /* 记录失败不阻塞结果展示 */ });
      body.appendChild(actions);
      card.appendChild(body);
      resultBox.appendChild(card);
      if (!texts.length) toast('所有图片均未识别到二维码', 'error');
    }
  },
});
