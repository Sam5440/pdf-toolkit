// PDF 签署（更多 · 对齐 PDF24 sign-pdf）：手绘/文字签名生成 PNG，盖章到指定页
// 引擎缺陷绕过（详见最终报告，与 edit.js 同类处理）：
//  1) page.addContent 产物缺 bytes/mime；
//  2) engine.run 每次调用都会重发 doc.open，替换 worker 内文档条目——
//     「addContent 盖章 + pages.extract 物化」的两步链路会取到未盖章副本。
// 故盖章在本地用 pdf-lib + core/geometry.js 以与 worker 完全相同的绘制语义写入；
// 引擎修复后可改回 run('page.addContent', {docId, edits})。
import * as pdfLib from 'pdf-lib';
import * as geometry from '../../core/geometry.js';
import { registerTool } from '../core.js';
import { ensureDoc } from '../../core/engine.js';
import { addResultArtifacts } from '../../core/tray.js';
import { inputPanel } from '../../components/input.js';
import {
  field, numberInput, textInput, select, button, toast,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

const POS9 = {
  'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
  'middle-left': [0, 0.5], 'middle-center': [0.5, 0.5], 'middle-right': [1, 0.5],
  'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1],
};

registerTool({
  id: 'sign',
  name: 'PDF 签署',
  group: 'm-edit',
  desc: '手绘或输入签名并盖章到 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0, hasInk: false };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch { /* 上层已 toast */ }
        rebuildPageSelect();
        updateEnable();
      },
      onRemove() { state.doc = null; state.pageCount = 0; rebuildPageSelect(); updateEnable(); },
    });

    const { card, body } = paramsCard();

    // ---- 模式 radio ----
    const modeBox = document.createElement('div');
    const mkRadio = (value, label, checked) => {
      const l = document.createElement('label');
      l.className = 'checkbox-row';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'sign-mode';
      r.value = value;
      r.checked = checked;
      const s = document.createElement('span');
      s.textContent = label;
      l.append(r, s);
      modeBox.appendChild(l);
      return r;
    };
    const drawRadio = mkRadio('draw', '手绘签名', true);
    const textRadio = mkRadio('text', '文字签名', false);
    body.appendChild(field('签名方式', modeBox));

    // ---- 手绘板 ----
    const drawBox = document.createElement('div');
    const signCanvas = document.createElement('canvas');
    signCanvas.setAttribute('data-sign-canvas', '');
    signCanvas.width = 480;
    signCanvas.height = 180;
    signCanvas.style.cssText = 'display:block;max-width:100%;border:1px dashed var(--border,#bbb);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair';
    const sctx = signCanvas.getContext('2d');
    const clearBtn = button('清除重写', 'btn-outline btn-sm', () => {
      sctx.clearRect(0, 0, signCanvas.width, signCanvas.height);
      state.hasInk = false;
    });
    clearBtn.setAttribute('data-sign-clear', '');
    clearBtn.style.marginTop = '8px';
    drawBox.append(signCanvas, clearBtn);
    const drawField = field('签名区（按住鼠标书写）', drawBox);
    body.appendChild(drawField);

    // 手绘：pointer 事件画线
    let drawing = false;
    let last = null;
    const ptOf = (e) => {
      const rect = signCanvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (signCanvas.width / rect.width),
        y: (e.clientY - rect.top) * (signCanvas.height / rect.height),
      };
    };
    signCanvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      state.hasInk = true;
      last = ptOf(e);
      signCanvas.setPointerCapture?.(e.pointerId);
    });
    signCanvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = ptOf(e);
      sctx.strokeStyle = '#1a1a1a';
      sctx.lineWidth = 3;
      sctx.lineCap = 'round';
      sctx.lineJoin = 'round';
      sctx.beginPath();
      sctx.moveTo(last.x, last.y);
      sctx.lineTo(p.x, p.y);
      sctx.stroke();
      last = p;
    });
    const stopDraw = () => { drawing = false; };
    signCanvas.addEventListener('pointerup', stopDraw);
    signCanvas.addEventListener('pointerleave', stopDraw);

    // ---- 文字签名 ----
    const textBox = document.createElement('div');
    const nameInp = textInput('', '输入姓名或抬头');
    nameInp.setAttribute('data-sign-text', '');
    textBox.appendChild(nameInp);
    const textField = field('签名文字', textBox, '将以手写体样式渲染为图片');
    textField.style.display = 'none';
    body.appendChild(textField);

    const syncMode = () => {
      const isDraw = drawRadio.checked;
      drawField.style.display = isDraw ? '' : 'none';
      textField.style.display = isDraw ? 'none' : '';
    };
    drawRadio.addEventListener('change', syncMode);
    textRadio.addEventListener('change', syncMode);

    // ---- 盖章参数 ----
    const pageSel = select([{ value: '1', label: '第 1 页' }], '1');
    pageSel.setAttribute('data-sign-page', '');
    body.appendChild(field('盖章页码', pageSel));

    const posSel = select([
      { value: 'top-left', label: '左上' },
      { value: 'top-center', label: '顶部居中' },
      { value: 'top-right', label: '右上' },
      { value: 'middle-left', label: '左侧居中' },
      { value: 'middle-center', label: '页面居中' },
      { value: 'middle-right', label: '右侧居中' },
      { value: 'bottom-left', label: '左下' },
      { value: 'bottom-center', label: '底部居中' },
      { value: 'bottom-right', label: '右下' },
    ], 'top-left');
    posSel.setAttribute('data-sign-pos', '');
    body.appendChild(field('盖章位置', posSel));

    const wInp = numberInput(30, { min: 5, max: 100, step: 1 });
    wInp.setAttribute('data-sign-width', '');
    body.appendChild(field('签名宽度（页宽 %）', wInp));

    function rebuildPageSelect() {
      pageSel.textContent = '';
      const n = Math.max(1, state.pageCount || 1);
      for (let i = 1; i <= n; i++) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `第 ${i} 页`;
        pageSel.appendChild(o);
      }
    }

    // ---- 签名 PNG 生成 ----
    async function handwritePng() {
      const blob = await new Promise((res) => signCanvas.toBlob(res, 'image/png'));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), ratio: signCanvas.height / signCanvas.width };
    }

    async function textPng(text) {
      const px = 120;
      const probe = document.createElement('canvas').getContext('2d');
      const font = `italic 400 ${px}px 'Snell Roundhand', 'Brush Script MT', 'Segoe Script', 'Xingkai SC', cursive`;
      probe.font = font;
      const w = Math.ceil(probe.measureText(text).width) + 24;
      const h = Math.ceil(px * 1.5);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx2 = c.getContext('2d');
      ctx2.font = font;
      ctx2.fillStyle = '#1a1a1a';
      ctx2.textBaseline = 'middle';
      ctx2.fillText(text, 12, h / 2);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), ratio: h / w };
    }

    const applyBtn = button('落章到 PDF', 'btn-primary', () => exec());
    applyBtn.setAttribute('data-sign-apply', '');
    applyBtn.style.cssText = 'width:100%;margin-top:14px';
    applyBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, applyBtn, resultBox);

    function updateEnable() { applyBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      // 1. 生成签名 PNG
      let sig;
      if (drawRadio.checked) {
        if (!state.hasInk) { toast('请先在签名区书写签名', 'error'); throw new Error('请先在签名区书写签名'); }
        sig = await handwritePng();
      } else {
        const t = nameInp.value.trim();
        if (!t) { toast('请输入签名文字', 'error'); throw new Error('请输入签名文字'); }
        sig = await textPng(t);
      }
      setP(30, '盖章写入…');

      // 2. 计算视觉坐标
      const pageNo = Math.max(0, (Number(pageSel.value) || 1) - 1);
      const pm = state.doc.info?.pages?.[pageNo];
      const vw = pm?.visualW || 595;
      const vh = pm?.visualH || 842;
      const pct = Math.min(100, Math.max(5, Number(wInp.value) || 30)) / 100;
      const w = vw * pct;
      const h = w * sig.ratio;
      const m = 28;
      const [fx, fy] = POS9[posSel.value] || POS9['top-left'];
      const x = fx === 0 ? m : fx === 1 ? vw - w - m : (vw - w) / 2;
      const y = fy === 0 ? m : fy === 1 ? vh - h - m : (vh - h) / 2;

      // 3. 盖章：视觉坐标（y 向下）→ 用户空间，本地 pdf-lib 写入（引擎缺陷绕过，见文件头）
      const crop = {
        x: pm?.crop?.x ?? 0,
        y: pm?.crop?.y ?? 0,
        width: pm?.crop?.width ?? pm?.visualW ?? 595,
        height: pm?.crop?.height ?? pm?.visualH ?? 842,
      };
      const rot = ((pm?.rot ?? 0) % 360 + 360) % 360;
      const c = geometry.visualToUser(x + w / 2, y + h / 2, crop, rot);
      const bytes = new Uint8Array(await state.doc.file.arrayBuffer());
      let pdf;
      try {
        pdf = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      } catch {
        throw new Error('该 PDF 无法解析（可能已损坏），请先尝试「修复 PDF」工具');
      }
      const img = await pdf.embedPng(sig.bytes);
      const page = pdf.getPage(pageNo);
      page.drawImage(img, {
        x: c.x - w / 2, y: c.y - h / 2, width: w, height: h,
        opacity: 1,
        rotate: pdfLib.degrees(geometry.userAngleForVisual(0, rot)),
      });
      const outBytes = await pdf.save({ useObjectStreams: true });
      const res = {
        artifacts: [{
          name: `${state.doc.name.replace(/\.pdf$/i, '')}_已签署.pdf`,
          mime: 'application/pdf',
          bytes: outBytes,
        }],
        summary: { pages: state.pageCount },
      };
      // 本地 pdf-lib 产出（未经引擎 run）：显式镜像到右侧暂存区
      addResultArtifacts(res.artifacts);

      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, 位置: posSel.selectedOptions[0]?.textContent || posSel.value },
        toolId: 'sign', toolName: 'PDF 签署',
        docNames: [state.doc.name],
        options: { page: pageSel.value, pos: posSel.value, widthPct: wInp.value, mode: drawRadio.checked ? 'draw' : 'text' },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
