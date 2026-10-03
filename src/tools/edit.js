// 页面编辑（subagent A）：canvas 页面视图 + 叠加对象（文字/图片/高亮/矩形/椭圆）拖动缩放删除
// 限制（诚实标注）：仅添加新内容，不修改 PDF 既有文字与排版。
//
// 引擎缺陷绕过（详见最终报告）：engine-worker 的 pageMeta() 产出 crop={x,y,w,h}，
// 而 geometry.normBox()/visualToUser() 仅支持 {x,y,width,height} / {x0,y0,x1,y1}，
// 导致 page.addContent（以及 wm.apply/preview、overlay.apply）的所有视觉坐标绘制为 NaN。
// 因此本工具在本地用 pdf-lib + core/geometry.js 以与 worker 完全相同的绘制语义写入内容；
// 待 core 修复后可改回 run('page.addContent', {docId, edits})（edits 结构保持兼容）。
import { iconNode } from '../components/icons.js';
import * as pdfLib from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as geometry from '../core/geometry.js';
import { getFontBytes, isCJKText } from '../core/fonts.js';
import { registerTool } from './core.js';
import { run, ensureDoc } from '../core/engine.js';
import { addResultArtifacts } from '../core/tray.js';
import { inputPanel } from '../components/input.js';
import {
  progressCard, warningsBox, toast, field, numberInput, button, openModal,
} from '../components/ui.js';
import { fmtBytes, baseName } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact } from '../core/download.js';

const DPI = 110;

/** 估算多行文字宽度（pt）：CJK 字符按 1em，其余按 0.55em */
function estimateTextW(text, fontSize) {
  const lines = String(text).split('\n');
  return Math.max(20, ...lines.map((l) => [...l]
    .reduce((acc, ch) => acc + (/[\u2E80-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.55), 0)));
}

// ---------------------------------------------------------------------------
// 本地绘制（与 engine-worker page.addContent 同语义）
// ---------------------------------------------------------------------------

function hexToRgb01(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** 与 worker pageMeta 等价，但 crop 使用 normBox 支持的 {x,y,width,height} */
function localPageMeta(page) {
  const size = page.getSize();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  let crop;
  try {
    const cb = page.getCropBox();
    crop = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
  } catch {
    crop = { x: 0, y: 0, width: size.width, height: size.height };
  }
  return { rot, crop };
}

async function resolveFontLocal(doc, fontId, bold, text) {
  if (fontId === 'auto' || !fontId) fontId = isCJKText(text) ? 'noto-sc' : 'helvetica';
  if (fontId === 'helvetica') return doc.embedFont(pdfLib.StandardFonts.Helvetica);
  if (fontId === 'times') return doc.embedFont(bold ? pdfLib.StandardFonts.TimesRomanBold : pdfLib.StandardFonts.TimesRoman);
  if (fontId === 'courier') return doc.embedFont(pdfLib.StandardFonts.Courier);
  const bytes = await getFontBytes(fontId, { bold });
  doc.registerFontkit(fontkit);
  return doc.embedFont(bytes, { subset: true });
}

/** 与 worker drawTextLayerDirect 同语义：以块中心为锚的多行文字绘制 */
function drawTextLayerLocal(page, font, lines, opts) {
  const { fontSize, color01, opacity, angleUser, align } = opts;
  const rad = (angleUser * Math.PI) / 180;
  const lh = fontSize * 1.3;
  const widthOf = (s) => { try { return font.widthOfTextAtSize(s, fontSize); } catch { return s.length * fontSize * 0.6; } };
  const maxW = Math.max(...lines.map(widthOf));
  const n = lines.length;
  const color = pdfLib.rgb(color01.r, color01.g, color01.b);
  lines.forEach((line, i) => {
    const offVx = align === 'left' ? -(maxW / 2 - widthOf(line) / 2)
      : align === 'right' ? (maxW / 2 - widthOf(line) / 2) : 0;
    const offVy = ((i - (n - 1) / 2)) * lh;
    const vec = geometry.visualVecToUser(offVx, offVy, opts.pageRotation);
    const ux = opts.cx + vec.dx;
    const uy = opts.cy + vec.dy;
    const w = widthOf(line);
    const baseVec = geometry.visualVecToUser(-w / 2, fontSize * 0.36, opts.pageRotation);
    page.drawText(line, {
      x: ux + baseVec.dx, y: uy + baseVec.dy,
      size: fontSize, font, color, opacity,
      rotate: pdfLib.degrees(angleUser),
    });
  });
  return { width: maxW, height: n * lh };
}

/** 与 worker embedImageAny 同语义：jpg/png 直嵌，其余浏览器解码后重编码 */
async function embedImageLocal(doc, bytes, mime) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const type = (mime || '').toLowerCase();
  const isJpg = type.includes('jpeg') || type.includes('jpg') || (u8[0] === 0xFF && u8[1] === 0xD8);
  const isPng = type.includes('png') || (u8[0] === 0x89 && u8[1] === 0x50);
  if (isJpg) { try { return await doc.embedJpg(u8); } catch { /* 走解码路径 */ } }
  if (isPng) { try { return await doc.embedPng(u8); } catch { /* 走解码路径 */ } }
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([u8], { type: type || 'application/octet-stream' }), { imageOrientation: 'from-image' });
  } catch {
    throw new Error('浏览器无法解码该图片格式（TIFF 等请先转换为 PNG/JPG）');
  }
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { hasAlpha = true; break; }
  const outType = hasAlpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, 0.92));
  const outBytes = new Uint8Array(await blob.arrayBuffer());
  return outType === 'image/jpeg' ? doc.embedJpg(outBytes) : doc.embedPng(outBytes);
}

/**
 * 本地执行页面编辑：加载原始字节 → 逐页绘制对象 → 保存。
 * 与 worker page.addContent 的绘制语义一致（文字/图片/矩形/高亮/椭圆，视觉坐标）。
 */
async function applyEditsLocal(doc, edits, onProgress) {
  const bytes = new Uint8Array(await doc.file.arrayBuffer());
  let pdf;
  try {
    pdf = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    throw new Error('该 PDF 已加密或损坏，请先解密（密码保护工具）后再编辑');
  }
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const page = pdf.getPage(edit.page);
    const pm = localPageMeta(page);
    for (const obj of edit.objects) {
      const rot = pm.rot;
      if (obj.type === 'text') {
        const font = await resolveFontLocal(pdf, obj.fontId, obj.bold, obj.text);
        const lines = String(obj.text ?? '').split('\n');
        const c = geometry.visualToUser(obj.x + (obj.w || 0) / 2, obj.y + (obj.h || lines.length * obj.fontSize * 1.3) / 2, pm.crop, rot);
        drawTextLayerLocal(page, font, lines, {
          cx: c.x, cy: c.y, fontSize: obj.fontSize || 14,
          color01: hexToRgb01(obj.color || '#111111'),
          opacity: obj.opacity ?? 1,
          angleUser: geometry.userAngleForVisual(obj.rotation || 0, rot),
          align: obj.align || 'left',
          pageRotation: rot,
        });
      } else if (obj.type === 'image') {
        const img = await embedImageLocal(pdf, obj.bytes, obj.mime);
        const c = geometry.visualToUser(obj.x + obj.w / 2, obj.y + obj.h / 2, pm.crop, rot);
        page.drawImage(img, {
          x: c.x - obj.w / 2, y: c.y - obj.h / 2,
          width: obj.w, height: obj.h,
          opacity: obj.opacity ?? 1,
          rotate: pdfLib.degrees(geometry.userAngleForVisual(obj.rotation || 0, rot)),
        });
      } else if (obj.type === 'rect' || obj.type === 'highlight') {
        const c01 = hexToRgb01(obj.color || (obj.type === 'highlight' ? '#ffe066' : '#2563eb'));
        const p1 = geometry.visualToUser(obj.x, obj.y + obj.h, pm.crop, rot);
        page.drawRectangle({
          x: p1.x, y: p1.y, width: obj.w, height: obj.h,
          color: obj.fill === false ? undefined : pdfLib.rgb(c01.r, c01.g, c01.b),
          opacity: obj.opacity ?? (obj.type === 'highlight' ? 0.4 : 1),
          borderColor: obj.stroke ? pdfLib.rgb(c01.r, c01.g, c01.b) : undefined,
          borderWidth: obj.stroke ? (obj.strokeWidth || 1) : 0,
          rotate: pdfLib.degrees(geometry.userAngleForVisual(0, rot)),
        });
      } else if (obj.type === 'ellipse') {
        const c01 = hexToRgb01(obj.color || '#2563eb');
        const c = geometry.visualToUser(obj.x + obj.w / 2, obj.y + obj.h / 2, pm.crop, rot);
        page.drawEllipse({
          x: c.x, y: c.y, xScale: obj.w / 2, yScale: obj.h / 2,
          color: obj.fill === false ? undefined : pdfLib.rgb(c01.r, c01.g, c01.b),
          opacity: obj.opacity ?? 1,
          borderColor: obj.stroke ? pdfLib.rgb(c01.r, c01.g, c01.b) : undefined,
          borderWidth: obj.stroke ? (obj.strokeWidth || 1) : 0,
        });
      }
    }
    onProgress?.(i + 1, edits.length);
  }
  const out = await pdf.save({ useObjectStreams: true });
  return out;
}

registerTool({
  id: 'edit',
  name: '页面编辑',
  group: 'pages',
  desc: '添加文字/图片/高亮/形状，移动缩放删除，导出真实 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = {
      doc: null, pageCount: 0, cur: 0, running: false,
      visualW: 0, visualH: 0, selectedId: null, counter: 0,
      objs: new Map(), // page(0基) → object[]
    };
    let renderToken = 0;

    const info = document.createElement('div');
    info.className = 'alert alert-info';
    info.style.marginBottom = '14px';
    info.textContent = '页面级编辑：添加/移动/删除添加的内容（文字框、图片、高亮、形状）；不修改 PDF 既有文字与排版。对象坐标为页面视觉 pt，导出与预览同源换算。';

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        state.cur = 0;
        state.objs.clear();
        state.selectedId = null;
        try {
          const inf = await ensureDoc(state.doc);
          state.doc.info = inf;
          state.pageCount = inf.pageCount;
        } catch (e) {
          toast(e.message, 'error');
        }
        await renderPage();
        updateGoState();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        state.objs.clear();
        state.selectedId = null;
        overlay.textContent = '';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pageLabel.textContent = '未选择文件';
        updateNav();
        updateGoState();
      },
    });

    // ---- 编辑器卡片 ----
    const editorCard = document.createElement('div');
    editorCard.className = 'card';
    editorCard.style.marginTop = '14px';
    const eBody = document.createElement('div');
    eBody.className = 'card-body';

    // 工具栏
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px';
    const addTextBtn = button('文字框', 'btn-outline btn-sm', () => openTextModal());
    const addImgBtn = button('图片', 'btn-outline btn-sm', () => pickImage());
    const addHlBtn = button('高亮矩形', 'btn-outline btn-sm', () => addShape('highlight'));
    const addRectBtn = button('矩形', 'btn-outline btn-sm', () => addShape('rect'));
    const addEllipseBtn = button('椭圆', 'btn-outline btn-sm', () => addShape('ellipse'));
    const delBtn = button('删除所选', 'btn-outline btn-sm', () => deleteSelected());
    delBtn.style.color = 'var(--no)';
    const prevBtn = button('上一页', 'btn-ghost btn-sm', () => gotoPage(state.cur - 1));
    const nextBtn = button('下一页', 'btn-ghost btn-sm', () => gotoPage(state.cur + 1));
    const pageLabel = document.createElement('span');
    pageLabel.className = 'muted-sm';
    pageLabel.setAttribute('data-edit', 'pageLabel');
    pageLabel.textContent = '未选择文件';
    bar.append(addTextBtn, addImgBtn, addHlBtn, addRectBtn, addEllipseBtn, delBtn, prevBtn, pageLabel, nextBtn);

    // 画布 + 叠加层
    const stage = document.createElement('div');
    stage.setAttribute('data-edit', 'stage');
    stage.style.cssText = 'position:relative;display:inline-block;max-width:100%;box-shadow:var(--shadow);background:#fff';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-edit', 'canvas');
    canvas.style.cssText = 'display:block;max-width:100%';
    const ctx = canvas.getContext('2d');
    const overlay = document.createElement('div');
    overlay.setAttribute('data-edit', 'overlay');
    overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden';
    stage.append(canvas, overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) select(null); });

    // 选中对象属性
    const props = document.createElement('div');
    props.style.cssText = 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:12px';
    const colorInp = document.createElement('input');
    colorInp.type = 'color';
    colorInp.value = '#111111';
    const colorField = field('颜色', colorInp);
    colorField.style.marginBottom = '0';
    const opacityInp = numberInput(1, { min: 0, max: 1, step: 0.05 });
    opacityInp.setAttribute('data-edit', 'opacity');
    const opacityField = field('透明度（0-1）', opacityInp);
    opacityField.style.marginBottom = '0';
    const fsInp = numberInput(18, { min: 6, max: 300, step: 1 });
    fsInp.setAttribute('data-edit', 'fontSize');
    const fsField = field('字号（pt）', fsInp);
    fsField.style.marginBottom = '0';
    const noSelHint = document.createElement('span');
    noSelHint.className = 'hint';
    noSelHint.textContent = '未选中对象：点击页面对象进行选中，可拖动移动、拖右下角缩放、Delete 键删除';
    props.append(noSelHint, colorField, opacityField, fsField);
    colorInp.addEventListener('input', () => { const o = selObj(); if (o) { o.color = colorInp.value; paintObj(o); } });
    opacityInp.addEventListener('input', () => {
      const o = selObj();
      if (o) { const v = Number(opacityInp.value); if (Number.isFinite(v)) { o.opacity = Math.min(1, Math.max(0, v)); paintObj(o); } }
    });
    fsInp.addEventListener('input', () => {
      const o = selObj();
      if (o && o.type === 'text') {
        const v = Number(fsInp.value);
        if (Number.isFinite(v) && v >= 6) {
          o.fontSize = v;
          o.h = String(o.text).split('\n').length * v * 1.3;
          paintObj(o);
        }
      }
    });

    eBody.append(bar, stage, props);
    editorCard.appendChild(eBody);

    const goBtn = button('开始编辑', 'btn-primary', () => doApply());
    goBtn.setAttribute('data-edit', 'go');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(info, panel.el, editorCard, goBtn, resultBox);

    // ---- 基础状态 helpers ----
    function pageObjs(p) {
      if (!state.objs.has(p)) state.objs.set(p, []);
      return state.objs.get(p);
    }
    function allObjs() {
      const out = [];
      for (const arr of state.objs.values()) out.push(...arr);
      return out;
    }
    function selObj() {
      return allObjs().find((o) => o.id === state.selectedId) || null;
    }
    function select(id) {
      state.selectedId = id;
      renderObjects();
      updateProps();
    }
    function updateProps() {
      const o = selObj();
      const has = !!o;
      noSelHint.style.display = has ? 'none' : '';
      colorField.style.display = has ? '' : 'none';
      opacityField.style.display = has ? '' : 'none';
      fsField.style.display = has && o.type === 'text' ? '' : 'none';
      if (has) {
        // 正在被编辑的输入框不回写，避免打断输入
        if (document.activeElement !== colorInp) colorInp.value = o.color || '#111111';
        if (document.activeElement !== opacityInp) opacityInp.value = String(o.opacity ?? 1);
        if (o.type === 'text' && document.activeElement !== fsInp) fsInp.value = String(o.fontSize ?? 18);
      }
    }
    function updateNav() {
      const ok = state.pageCount > 0;
      prevBtn.disabled = !ok || state.cur <= 0;
      nextBtn.disabled = !ok || state.cur >= state.pageCount - 1;
      if (ok) pageLabel.textContent = `第 ${state.cur + 1} / ${state.pageCount} 页`;
    }
    function updateGoState() {
      goBtn.disabled = state.running || !state.doc;
    }
    function gotoPage(p) {
      if (!state.pageCount) return;
      const np = Math.max(0, Math.min(state.pageCount - 1, p));
      if (np === state.cur) return;
      state.cur = np;
      state.selectedId = null;
      renderPage();
    }

    // ---- 页面渲染 ----
    async function renderPage() {
      if (!state.doc || !state.pageCount) { updateNav(); return; }
      const my = ++renderToken;
      const p = state.cur;
      try {
        const r = await run('doc.render', { docId: state.doc.id, page: p, dpi: DPI, bg: '#ffffff' }, {}, new Map([[state.doc.id, state.doc]]));
        if (my !== renderToken) { r.bitmap.close?.(); return; }
        canvas.width = r.width;
        canvas.height = r.height;
        ctx.clearRect(0, 0, r.width, r.height);
        ctx.drawImage(r.bitmap, 0, 0);
        r.bitmap.close?.();
        state.visualW = r.visualW || state.doc.info?.pages?.[p]?.visualW || 595;
        state.visualH = r.visualH || state.doc.info?.pages?.[p]?.visualH || 842;
        updateNav();
        renderObjects();
      } catch (e) {
        if (my === renderToken) toast(`页面渲染失败：${e.message}`, 'error');
      }
    }

    // ---- 对象叠加层 ----
    function scale() {
      return state.visualW ? overlay.getBoundingClientRect().width / state.visualW : 1;
    }

    function renderObjects() {
      overlay.textContent = '';
      for (const o of pageObjs(state.cur)) overlay.appendChild(buildObjEl(o));
    }

    function paintObj(o) {
      const el = overlay.querySelector(`[data-oid="${o.id}"]`);
      if (el) applyObjStyle(el, o);
      if (o.id === state.selectedId) updateProps();
    }

    function applyObjStyle(el, o) {
      const vw = state.visualW || 595;
      const vh = state.visualH || 842;
      el.style.left = `${(o.x / vw) * 100}%`;
      el.style.top = `${(o.y / vh) * 100}%`;
      el.style.width = `${(o.w / vw) * 100}%`;
      el.style.height = `${(o.h / vh) * 100}%`;
      el.dataset.x = String(Math.round(o.x * 10) / 10);
      el.dataset.y = String(Math.round(o.y * 10) / 10);
      if (o.type === 'text') {
        el.textContent = o.text;
        el.style.cssText += `;font-size:${o.fontSize * scale()}px;line-height:1.3;color:${o.color};white-space:pre;`
          + 'display:flex;flex-direction:column;justify-content:center;align-items:flex-start;overflow:hidden';
      } else if (o.type === 'image') {
        el.style.cssText += '';
        if (el.tagName !== 'IMG') {
          const img = document.createElement('img');
          img.src = o.url;
          img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none';
          el.textContent = '';
          el.appendChild(img);
        }
      } else {
        el.style.background = o.color;
        el.style.opacity = String(o.opacity ?? 1);
        if (o.type === 'ellipse') el.style.borderRadius = '50%';
        if (o.type === 'rect') el.style.border = `1px solid ${o.color}`;
      }
      const selected = o.id === state.selectedId;
      el.style.outline = selected ? '2px dashed var(--primary)' : '';
      el.style.cursor = 'move';
      // 缩放手柄（仅选中时）
      const oldHandle = el.querySelector('.edit-handle');
      if (oldHandle) oldHandle.remove();
      if (selected && o.type !== 'image') {
        const h = document.createElement('div');
        h.className = 'edit-handle';
        h.style.cssText = 'position:absolute;right:-6px;bottom:-6px;width:12px;height:12px;background:var(--primary);border:2px solid #fff;border-radius:3px;cursor:nwse-resize';
        h.addEventListener('mousedown', (e) => startResize(e, o));
        el.appendChild(h);
      }
    }

    function buildObjEl(o) {
      const el = document.createElement('div');
      el.className = 'edit-obj';
      el.setAttribute('data-oid', o.id);
      el.setAttribute('data-type', o.type);
      el.style.position = 'absolute';
      el.style.userSelect = 'none';
      el.addEventListener('mousedown', (e) => {
        if (e.target.classList?.contains('edit-handle')) return;
        e.stopPropagation();
        if (state.selectedId !== o.id) {
          select(o.id); // select 会重建叠加层，需重新取元素
        }
        const fresh = overlay.querySelector(`[data-oid="${o.id}"]`) || el;
        startDrag(e, o, fresh);
      });
      applyObjStyle(el, o);
      return el;
    }

    function clampPos(o) {
      const vw = state.visualW || 595;
      const vh = state.visualH || 842;
      o.x = Math.min(Math.max(0, o.x), Math.max(0, vw - o.w));
      o.y = Math.min(Math.max(0, o.y), Math.max(0, vh - o.h));
    }

    function startDrag(e, o, el) {
      e.preventDefault();
      const sc = scale();
      const startX = e.clientX;
      const startY = e.clientY;
      const ox = o.x;
      const oy = o.y;
      const move = (ev) => {
        o.x = ox + (ev.clientX - startX) / sc;
        o.y = oy + (ev.clientY - startY) / sc;
        clampPos(o);
        // 拖动中直接更新样式，避免整层重建导致闪烁
        const vw = state.visualW || 595;
        const vh = state.visualH || 842;
        el.style.left = `${(o.x / vw) * 100}%`;
        el.style.top = `${(o.y / vh) * 100}%`;
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        renderObjects();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    function startResize(e, o) {
      e.preventDefault();
      e.stopPropagation();
      const sc = scale();
      const startX = e.clientX;
      const startY = e.clientY;
      const ow = o.w;
      const oh = o.h;
      const of = o.fontSize || 18;
      const move = (ev) => {
        const nw = Math.max(10, ow + (ev.clientX - startX) / sc);
        if (o.type === 'text') {
          const ratio = nw / Math.max(1, ow);
          o.fontSize = Math.min(300, Math.max(6, Math.round(of * ratio)));
          o.w = nw;
          o.h = String(o.text).split('\n').length * o.fontSize * 1.3;
        } else {
          o.w = nw;
          o.h = Math.max(8, oh + (ev.clientY - startY) / sc);
        }
        clampPos(o);
        paintObj(o);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        renderObjects();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    function deleteSelected() {
      const o = selObj();
      if (!o) { toast('请先点击选中一个对象', 'error'); return; }
      if (o.url) URL.revokeObjectURL(o.url);
      const arr = pageObjs(state.cur);
      const i = arr.findIndex((x) => x.id === o.id);
      if (i >= 0) arr.splice(i, 1);
      state.selectedId = null;
      renderObjects();
      updateProps();
    }

    // Delete 键删除（输入框内不拦截）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!document.body.contains(stage)) return; // 工具已卸载
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (state.selectedId) { e.preventDefault(); deleteSelected(); }
    });

    // ---- 新增对象 ----
    function nextPos() {
      const n = pageObjs(state.cur).length % 5;
      return { x: 60 + n * 26, y: 60 + n * 26 };
    }

    function openTextModal() {
      if (!state.doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.placeholder = '输入文字内容（支持多行）';
      ta.setAttribute('data-edit', 'textArea');
      const fs = numberInput(24, { min: 6, max: 300, step: 1 });
      fs.setAttribute('data-edit', 'newFontSize');
      const color = document.createElement('input');
      color.type = 'color';
      color.value = '#111111';
      color.setAttribute('data-edit', 'newColor');
      const box = document.createElement('div');
      box.append(
        field('文字内容', ta, '多行文字按换行分段'),
        field('字号（pt）', fs),
        field('颜色', color),
      );
      const modal = openModal('添加文字框', box);
      const addB = button('添加', 'btn-primary', () => {
        const text = ta.value;
        if (!text.trim()) { toast('文字内容不能为空', 'error'); return; }
        const fontSize = Math.max(6, Number(fs.value) || 24);
        const o = {
          id: `o${++state.counter}`,
          type: 'text',
          text,
          fontSize,
          color: color.value || '#111111',
          opacity: 1,
          rotation: 0,
          align: 'left',
          bold: false,
          fontId: 'auto',
          ...nextPos(),
          w: 0, h: 0,
        };
        o.w = Math.min(estimateTextW(text, fontSize), Math.max(40, (state.visualW || 595) - o.x - 8));
        o.h = String(text).split('\n').length * fontSize * 1.3;
        pageObjs(state.cur).push(o);
        select(o.id);
        modal.close();
      });
      addB.style.marginTop = '14px';
      box.appendChild(addB);
      setTimeout(() => ta.focus(), 50);
    }

    function pickImage() {
      if (!state.doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif';
      inp.onchange = async () => {
        const f = inp.files?.[0];
        inp.remove();
        if (!f) return;
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const url = URL.createObjectURL(f);
          const nat = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => reject(new Error('浏览器无法解码该图片格式（TIFF 等请先转换）'));
            img.src = url;
          });
          const vw = state.visualW || 595;
          const w = Math.min(240, vw / 2);
          const o = {
            id: `o${++state.counter}`,
            type: 'image',
            bytes, mime: f.type || 'image/png', url, name: f.name,
            opacity: 1, rotation: 0,
            w, h: Math.max(8, w * (nat.h / Math.max(1, nat.w))),
            ...nextPos(),
          };
          clampPos(o);
          pageObjs(state.cur).push(o);
          select(o.id);
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.click();
    }

    function addShape(type) {
      if (!state.doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const defaults = {
        highlight: { color: '#ffe066', opacity: 0.4 },
        rect: { color: '#2563eb', opacity: 1 },
        ellipse: { color: '#2563eb', opacity: 1 },
      }[type];
      const o = {
        id: `o${++state.counter}`,
        type,
        w: type === 'highlight' ? 220 : 160,
        h: type === 'highlight' ? 60 : 100,
        fill: true, stroke: false, strokeWidth: 1,
        ...defaults,
        ...nextPos(),
      };
      clampPos(o);
      pageObjs(state.cur).push(o);
      select(o.id);
    }

    // ---- 执行 ----
    async function doApply() {
      const doc = state.doc;
      if (!doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const edits = [];
      for (const [p, arr] of state.objs) {
        if (!arr.length) continue;
        edits.push({
          page: p,
          objects: arr.map((o) => {
            const base = { type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, opacity: o.opacity ?? 1, rotation: o.rotation || 0 };
            if (o.type === 'text') {
              return { ...base, text: o.text, fontSize: o.fontSize, color: o.color, fontId: 'auto', bold: false, align: o.align || 'left' };
            }
            if (o.type === 'image') {
              return { ...base, bytes: o.bytes, mime: o.mime };
            }
            return { ...base, color: o.color, fill: o.fill !== false, stroke: !!o.stroke, strokeWidth: o.strokeWidth || 1 };
          }),
        });
      }
      if (!edits.length) { toast('请先添加至少一个编辑对象', 'error'); return; }
      state.running = true;
      goBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(10, '写入编辑内容…');
      const t0 = Date.now();
      try {
        // 引擎缺陷绕过：见文件头注释（pageMeta crop 格式与 geometry.normBox 不匹配 → NaN）。
        // 这里在本地以相同绘制语义写入内容，保持文字为矢量（可检索）。
        const bytes = await applyEditsLocal(doc, edits, (done, total) => {
          pc.set(10 + (done / total) * 80, `编辑第 ${Math.round(done)} 页…`);
        });
        const art = {
          name: `${baseName(doc.name)}_已编辑.pdf`,
          mime: 'application/pdf',
          bytes,
        };
        // 本地 pdf-lib 产出（未经引擎 run）：显式镜像到右侧暂存区
        addResultArtifacts([art]);
        pc.done();
        renderResult({ summary: { edits: edits.length } }, art, doc, edits, Date.now() - t0);
      } catch (e) {
        pc.error(e.message);
        toast(e.message, 'error');
      } finally {
        state.running = false;
        updateGoState();
      }
    }

    function renderResult(res, art, doc, edits, ms) {
      const card = document.createElement('div');
      card.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      const b = document.createElement('b');
      b.appendChild(iconNode('success'));
      b.appendChild(document.createTextNode(` 编辑完成：${res.summary?.edits ?? edits.length} 页有新增内容 · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round(ms / 100) / 10}s`));
      kv.appendChild(b);
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = `输出：${art.name}（仅追加新内容，未改动既有文字与排版）`;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      actions.append(
        button('下载编辑结果', 'btn-primary', () => downloadArtifact(art)),
        button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'edit', toolName: '页面编辑',
            docNames: [doc.name],
            options: { pages: edits.length, objects: edits.reduce((n, e) => n + e.objects.length, 0) },
            outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
          });
          toast('已保存到历史');
        }),
      );
      ib.append(kv, note, actions);
      const w = warningsBox(res.warnings);
      if (w) ib.appendChild(w);
      card.appendChild(ib);
      resultBox.appendChild(card);
    }
  },
});
