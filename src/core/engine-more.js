// 「更多」工具族的引擎操作（在 worker 内运行）。
// 与 engine-worker.js 为循环引用：仅函数体中访问其导出（ESM 活绑定，延迟到调用期解析）。
import * as pdfLib from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as geometry from './geometry.js';
import { parsePageRange } from './pagerange.js';
import { hexToRgb01 } from './watermark-model.js';
import { toolkitError } from './errors.js';
import { buildOffice } from './officewriters.js';
import { encodeTiff } from './tiff.js';
import {
  getDoc, pageMetaOf, pageMeta, renderPageBitmap, checkAbort, progress, LIMITS,
  pdfLibLoad, pdfjsOpen, withSuffix, ensureWorkerCJKFont, workerFontSpec, drawTextRaster,
} from './engine-worker.js';

export const handlers = {};

const PAPERS = {
  a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28],
  letter: [612, 792], legal: [612, 1008],
};

/**
 * 将嵌入页（未应用 /Rotate）按视觉方向摆放进目标盒（等比缩放、居中）。
 * /Rotate 90 表示查看时顺时针旋转，因此补偿旋转为 -r（PDF 正角=逆时针）。
 * pdf-lib drawPage 变换顺序 translate(x,y)·rotate·scale，rot≠0 时按下方公式补偿原点。
 */
function placeEmbedded(page, emb, box, rot) {
  const r = ((rot % 360) + 360) % 360;
  const s = Math.min(box.w / emb.width, box.h / emb.height);
  const sw = emb.width * s, sh = emb.height * s;
  const cx = box.x + (box.w - sw) / 2;
  const cy = box.y + (box.h - sh) / 2;
  let x, y;
  if (r === 90) { x = cx; y = cy + sw; }           // 顺时针90：内容落到原点上方
  else if (r === 180) { x = cx + sw; y = cy + sh; }
  else if (r === 270) { x = cx + sh; y = cy; }
  else { x = cx; y = cy; }
  page.drawPage(emb, { x, y, xScale: s, yScale: s, rotate: pdfLib.degrees(-r) });
}

function rangePages(e, pages) {
  const r = parsePageRange(pages ?? 'all', e.pages.length);
  if (!r.ok) throw toolkitError('ERR_RANGE', r.error);
  return r.pages;
}

/** 原位修改型 op 保存后：把新字节同步回 worker 条目，避免后续 op 拿到旧文档 */
function syncEntryBytes(e, doc, bytes) {
  e.bytes = bytes;
  try { e.pdfjsDoc?.destroy?.(); } catch { /* noop */ }
  e.pdfjsDoc = null;
  e.pages = doc.getPages().map((p, i) => pageMeta(doc, p, i));
}

/** 复制选定页（按给定顺序）为新文档 */
async function copySubset(entry, pageIdxs, name) {
  const out = await pdfLib.PDFDocument.create();
  for (let i = 0; i < pageIdxs.length; i++) {
    checkAbort();
    const [p] = await out.copyPages(entry.pdfLibDoc, [pageIdxs[i]]);
    out.addPage(p);
    progress({ done: i + 1, total: pageIdxs.length, stage: `处理第 ${pageIdxs[i] + 1} 页` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name, mime: 'application/pdf', bytes }], summary: { pages: pageIdxs.length } };
}

/** 高亮 token [{v,c}] → 视觉行（\n 断行；与 mdhl.tokenLines 同构——本地实现避免 worker 引入 hljs） */
function tokenLines(tokens) {
  const lines = [[]];
  for (const tk of tokens) {
    const parts = String(tk.v ?? '').split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ v: p, c: tk.c });
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 页面操作
// ---------------------------------------------------------------------------

/**
 * 内容流首尾包装 `q <矩阵> cm … Q` 实现镜像：只变换内容坐标，
 * 保留矢量/文字/注释（无损），与 pdf-lib translateContent/scaleContent 同一手法。
 * rotation 必须传该页最终 /Rotate（本轮旋转之后），视觉方向映射才正确。
 */
function applyMirror(page, rotation, mirrorX, mirrorY) {
  const matrix = geometry.mirrorMatrix(page.getCropBox(), rotation, mirrorX, mirrorY);
  if (!matrix) return;
  page.node.normalize();
  page.getContentStream(); // 页面可能没有内容流，先确保 Contents 为数组且非空
  const [a, b, c, d, e, f] = matrix;
  const start = page.createContentStream(
    pdfLib.pushGraphicsState(),
    pdfLib.concatTransformationMatrix(a, b, c, d, e, f),
  );
  const end = page.createContentStream(pdfLib.popGraphicsState());
  page.node.wrapContentStreams(page.doc.context.register(start), page.doc.context.register(end));
}

handlers['pages.rotate'] = async ({ docId, pages = 'all', angle = 90, mode = 'relative', mirrorX = false, mirrorY = false }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const step = ((Math.round(Number(angle)) % 360) + 360) % 360;
  if (step % 90 !== 0) throw toolkitError('ERR_BAD_ARGS', '旋转角度需为 90 的倍数');
  if (!step && !mirrorX && !mirrorY) throw toolkitError('ERR_BAD_ARGS', '请选择旋转角度或镜像方式');
  const doc = e.pdfLibDoc;
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const page = doc.getPage(list[i]);
    const cur = ((page.getRotation().angle % 360) + 360) % 360;
    const next = mode === 'absolute' ? step : geometry.composeRotation(cur, step);
    if (next !== cur) page.setRotation(pdfLib.degrees(next));
    if (mirrorX || mirrorY) applyMirror(page, next, mirrorX, mirrorY);
    progress({ done: i + 1, total: list.length, stage: `处理第 ${list[i] + 1} 页` });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  const suffix = step && (mirrorX || mirrorY) ? '已旋转镜像' : step ? '已旋转' : '已镜像';
  return {
    artifacts: [{ name: withSuffix(e.name, suffix), mime: 'application/pdf', bytes }],
    summary: {
      pages: list.length,
      angle: step,
      mirror: mirrorX && mirrorY ? '左右+上下' : mirrorX ? '左右' : mirrorY ? '上下' : '无',
    },
  };
};

handlers['pages.remove'] = async ({ docId, pages }) => {
  const e = getDoc(docId);
  const removeSet = new Set(rangePages(e, pages));
  const keep = [];
  for (let i = 0; i < e.pages.length; i++) if (!removeSet.has(i)) keep.push(i);
  if (!keep.length) throw toolkitError('ERR_BAD_ARGS', '不能删除全部页面');
  return copySubset(e, keep, withSuffix(e.name, '已删页'));
};

handlers['pages.extract'] = async ({ docId, pages }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  if (!list.length) throw toolkitError('ERR_RANGE', '未选择任何页面');
  return copySubset(e, list, withSuffix(e.name, '已提取'));
};

/** N-up：每页纸排放 N 个页面（矢量嵌入） */
handlers['pages.nup'] = async ({ docId, pages = 'all', per = 4, cols = null, rows = null, paper = 'a4', orientation = 'portrait', margin = 14, border = false }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const LAYOUT = { 2: [2, 1], 4: [2, 2], 6: [2, 3], 9: [3, 3], 16: [4, 4] };
  const [dc, dr] = LAYOUT[per] || LAYOUT[4];
  const C = Number(cols) > 0 ? Number(cols) : dc;
  const R = Number(rows) > 0 ? Number(rows) : dr;
  const cell = C * R;
  let [pw0, ph0] = PAPERS[paper] || PAPERS.a4;
  const landscape = orientation === 'landscape';
  const pw = landscape ? ph0 : pw0, ph = landscape ? pw0 : ph0;
  const out = await pdfLib.PDFDocument.create();
  const total = Math.ceil(list.length / cell);
  for (let s = 0; s < total; s++) {
    checkAbort();
    const page = out.addPage([pw, ph]);
    const cellW = (pw - margin * 2 - (C - 1) * 6) / C;
    const cellH = (ph - margin * 2 - (R - 1) * 6) / R;
    for (let k = 0; k < cell; k++) {
      const idx = s * cell + k;
      if (idx >= list.length) break;
      const srcPage = e.pdfLibDoc.getPage(list[idx]);
      const pm = e.pages[list[idx]];
      const bbox = {
        left: pm.crop.x, bottom: pm.crop.y,
        right: pm.crop.x + pm.crop.width, top: pm.crop.y + pm.crop.height,
      };
      const emb = await out.embedPage(srcPage, bbox);
      const rot = ((pm.rot % 360) + 360) % 360;
      const col = k % C, row = Math.floor(k / C);
      const cx = margin + col * (cellW + 6) + cellW / 2;
      const cy = ph - margin - row * (cellH + 6) - cellH / 2;
      if (border) page.drawRectangle({ x: cx - cellW / 2, y: cy - cellH / 2, width: cellW, height: cellH, borderColor: pdfLib.rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
      placeEmbedded(page, emb, { x: cx - cellW / 2, y: cy - cellH / 2, w: cellW, h: cellH }, rot);
    }
    progress({ done: s + 1, total, stage: `拼版第 ${s + 1} 张` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(e.name, `${per}合1`), mime: 'application/pdf', bytes }], summary: { sheets: total, perPage: cell } };
};

/** 每页切分为左右/上下两半（矢量裁剪） */
handlers['pages.halve'] = async ({ docId, pages = 'all', direction = 'vertical', order = 'normal' }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const out = await pdfLib.PDFDocument.create();
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const idx = list[i];
    const srcPage = e.pdfLibDoc.getPage(idx);
    const pm = e.pages[idx];
    const cw = pm.crop.width, ch = pm.crop.height;
    const swap = pm.rot === 90 || pm.rot === 270;
    // 视觉宽高（旋转后）
    const vw = swap ? ch : cw, vh = swap ? cw : ch;
    const halves = direction === 'vertical'
      ? [{ x: 0, y: 0, w: vw / 2, h: vh }, { x: vw / 2, y: 0, w: vw / 2, h: vh }]
      : [{ x: 0, y: 0, w: vw, h: vh / 2 }, { x: 0, y: vh / 2, w: vw, h: vh / 2 }];
    if (order === 'reverse') halves.reverse();
    for (const hf of halves) {
      // 视觉矩形 → 用户空间轴对齐框
      const p1 = geometry.visualToUser(hf.x, hf.y, pm.crop, pm.rot);
      const p2 = geometry.visualToUser(hf.x + hf.w, hf.y + hf.h, pm.crop, pm.rot);
      const bbox = {
        left: Math.min(p1.x, p2.x), bottom: Math.min(p1.y, p2.y),
        right: Math.max(p1.x, p2.x), top: Math.max(p1.y, p2.y),
      };
      const emb = await out.embedPage(srcPage, bbox);
      const page = out.addPage([hf.w, hf.h]);
      placeEmbedded(page, emb, { x: 0, y: 0, w: hf.w, h: hf.h }, pm.rot);
    }
    progress({ done: i + 1, total: list.length, stage: `切分第 ${list[i] + 1} 页` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(e.name, '切半'), mime: 'application/pdf', bytes }], summary: { pages: list.length * 2 } };
};

/** 设置裁剪框（CropBox） */
handlers['pages.crop'] = async ({ docId, mode = 'margin', values = {}, pages = 'all' }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const doc = e.pdfLibDoc;
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const pageNo = list[i];
    const pm = pageMetaOf(e, pageNo);
    const page = doc.getPage(pageNo);
    const mediaBox = { x0: pm.media.x, y0: pm.media.y, x1: pm.media.x + pm.media.width, y1: pm.media.y + pm.media.height };
    let box;
    if (mode === 'reset') {
      box = { x0: mediaBox.x0, y0: mediaBox.y0, x1: mediaBox.x1, y1: mediaBox.y1 };
    } else {
      // 视觉空间（y 向下、/Rotate 已换向）计算裁剪框，再映射回用户空间；
      // 直接用 pm.crop.width/height 会在 rot=90/270 时把右/下边距落错边
      const vis = geometry.visualSize(pm.crop, pm.rot);
      let v;
      if (mode === 'margin') {
        const { left = 0, top = 0, right = 0, bottom = 0 } = values;
        v = { x: left, y: top, w: Math.max(1, vis.w - left - right), h: Math.max(1, vis.h - top - bottom) };
      } else if (mode === 'percent') {
        const pl = Math.min(49, Math.max(0, values.left ?? 0));
        const pt = Math.min(49, Math.max(0, values.top ?? 0));
        const pr = Math.min(49, Math.max(0, values.right ?? 0));
        const pb = Math.min(49, Math.max(0, values.bottom ?? 0));
        v = {
          x: vis.w * pl / 100, y: vis.h * pt / 100,
          w: vis.w * (100 - pl - pr) / 100, h: vis.h * (100 - pt - pb) / 100,
        };
      } else { // box：绝对视觉坐标
        v = { x: values.x ?? 0, y: values.y ?? 0, w: values.w ?? vis.w, h: values.h ?? vis.h };
      }
      const p1 = geometry.visualToUser(v.x, v.y, pm.crop, pm.rot);
      const p2 = geometry.visualToUser(v.x + v.w, v.y + v.h, pm.crop, pm.rot);
      box = geometry.clampCrop(
        { x0: Math.min(p1.x, p2.x), y0: Math.min(p1.y, p2.y), x1: Math.max(p1.x, p2.x), y1: Math.max(p1.y, p2.y) },
        mediaBox,
      );
    }
    page.node.set(pdfLib.PDFName.of('CropBox'), doc.context.obj([box.x0, box.y0, box.x1, box.y1]));
    progress({ done: i + 1, total: list.length, stage: `裁剪第 ${pageNo + 1} 页` });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '已裁剪'), mime: 'application/pdf', bytes }], summary: { pages: list.length } };
};

/** 更改页面大小：新建目标尺寸页并矢量嵌入 */
handlers['pages.resize'] = async ({ docId, paper = 'a4', orientation = 'portrait', fit = 'contain', margin = 0 }) => {
  const e = getDoc(docId);
  let [pw0, ph0] = PAPERS[paper] || PAPERS.a4;
  const landscape = orientation === 'landscape';
  const pw = landscape ? ph0 : pw0, ph = landscape ? pw0 : ph0;
  const out = await pdfLib.PDFDocument.create();
  const n = e.pages.length;
  for (let i = 0; i < n; i++) {
    checkAbort();
    const srcPage = e.pdfLibDoc.getPage(i);
    const pm = e.pages[i];
    const bbox = { left: pm.crop.x, bottom: pm.crop.y, right: pm.crop.x + pm.crop.width, top: pm.crop.y + pm.crop.height };
    const emb = await out.embedPage(srcPage, bbox);
    const rot = ((pm.rot % 360) + 360) % 360;
    const availW = Math.max(1, pw - margin * 2), availH = Math.max(1, ph - margin * 2);
    const page = out.addPage([pw, ph]);
    if (fit === 'stretch' && rot === 0) {
      // 拉伸：非等比铺满（仅未旋转页面；旋转页回退等比适应）
      page.drawPage(emb, { x: margin, y: margin, width: availW, height: availH });
    } else {
      placeEmbedded(page, emb, { x: margin, y: margin, w: availW, h: availH }, rot);
    }
    progress({ done: i + 1, total: n, stage: `调整第 ${i + 1} 页` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(e.name, `已调整为${paper.toUpperCase()}`), mime: 'application/pdf', bytes }], summary: { pages: n, paper } };
};

const POS9 = {
  'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
  'middle-left': [0, 0.5], 'middle-center': [0.5, 0.5], 'middle-right': [1, 0.5],
  'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1],
};

handlers['pages.pagenumbers'] = async ({ docId, pages = 'all', position = 'bottom-center', start = 1, format = '{n} / {N}', fontSize = 12, margin = 28, color = '#333333' }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const total = list.length;
  const doc = e.pdfLibDoc;
  const c01 = hexToRgb01(color);
  await ensureWorkerCJKFont();
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const pageNo = list[i];
    const pm = pageMetaOf(e, pageNo);
    const page = doc.getPage(pageNo);
    const label = String(format).replace('{n}', String(start + i)).replace('{N}', String(total));
    const [fx, fy] = POS9[position] || POS9['bottom-center'];
    // 量宽：workerFontSpec 已含 ×3 渲染倍率，量得的 px 除以 3 得 pt
    const probe = new OffscreenCanvas(8, 8);
    const pctx = probe.getContext('2d');
    pctx.font = workerFontSpec(fontSize, false);
    const tw = pctx.measureText(label).width / 3;
    const vw = pm.rot === 90 || pm.rot === 270 ? pm.crop.height : pm.crop.width;
    const vh = pm.rot === 90 || pm.rot === 270 ? pm.crop.width : pm.crop.height;
    const padX = Math.min(margin + tw / 2, vw / 2);
    const padY = Math.min(margin + fontSize / 2, vh / 2);
    const vx = fx === 0 ? padX : fx === 1 ? vw - padX : vw / 2;
    const vy = fy === 0 ? padY : fy === 1 ? vh - padY : vh / 2;
    const c = geometry.visualToUser(vx, vy, pm.crop, pm.rot);
    await drawTextRaster(page, doc, [label], {
      cx: c.x, cy: c.y, fontSize, color01: c01, opacity: 1, angleUser: 0, align: 'center',
    });
    progress({ done: i + 1, total: list.length, stage: `编号第 ${pageNo + 1} 页` });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '已编号'), mime: 'application/pdf', bytes }], summary: { pages: list.length } };
};

// ---------------------------------------------------------------------------
// 信息 / 查看器偏好 / 书签
// ---------------------------------------------------------------------------

handlers['meta.edit'] = async ({ docId, info = {} }) => {
  const e = getDoc(docId);
  const doc = e.pdfLibDoc;
  const set = (v, fn) => { if (v !== undefined && v !== null) fn(v); };
  set(info.title, (v) => doc.setTitle(String(v)));
  set(info.author, (v) => doc.setAuthor(String(v)));
  set(info.subject, (v) => doc.setSubject(String(v)));
  set(info.creator, (v) => doc.setCreator(String(v)));
  set(info.producer, (v) => doc.setProducer(String(v)));
  if (info.keywords !== undefined && info.keywords !== null) {
    const kw = Array.isArray(info.keywords) ? info.keywords : String(info.keywords).split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
    doc.setKeywords(kw);
  }
  const asDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
  if (info.creationDate) { const d = asDate(info.creationDate); if (d) doc.setCreationDate(d); }
  if (info.modDate) { const d = asDate(info.modDate); if (d) doc.setModificationDate(d); }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '信息已修改'), mime: 'application/pdf', bytes }], summary: { fields: Object.keys(info).length } };
};

handlers['meta.strip'] = async ({ docId }) => {
  const e = getDoc(docId);
  const doc = e.pdfLibDoc;
  doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]);
  doc.setCreator(''); doc.setProducer('');
  // XMP 元数据流
  try {
    doc.catalog.delete(pdfLib.PDFName.of('Metadata'));
  } catch { /* noop */ }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '元数据已清除'), mime: 'application/pdf', bytes }], summary: {} };
};

const PDF_BOOL = (v) => (v ? pdfLib.PDFBool.True : pdfLib.PDFBool.False);

handlers['viewer.prefs'] = async ({ docId, prefs = {} }) => {
  const e = getDoc(docId);
  const cat = e.pdfLibDoc.catalog;
  const NAME = (k, v) => { if (v) cat.set(pdfLib.PDFName.of(k), pdfLib.PDFName.of(String(v))); };
  NAME('PageMode', prefs.pageMode);
  NAME('PageLayout', prefs.pageLayout);
  NAME('NonFullScreenPageMode', prefs.nonFullScreenPageMode);
  const FLAG = (k, v) => { if (v !== undefined && v !== null && v !== '') cat.set(pdfLib.PDFName.of(k), PDF_BOOL(!!v)); };
  FLAG('HideToolbar', prefs.hideToolbar);
  FLAG('HideMenubar', prefs.hideMenubar);
  FLAG('HideWindowUI', prefs.hideWindowUI);
  FLAG('FitWindow', prefs.fitWindow);
  FLAG('CenterWindow', prefs.centerWindow);
  FLAG('DisplayDocTitle', prefs.displayDocTitle);
  const bytes = await e.pdfLibDoc.save({ useObjectStreams: true });
  syncEntryBytes(e, e.pdfLibDoc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '查看器偏好'), mime: 'application/pdf', bytes }], summary: {} };
};

/** 写入大纲（书签）。items: [{title, page(0基), level(0=顶级)}] */
handlers['outlines.add'] = async ({ docId, items = [] }) => {
  const e = getDoc(docId);
  const doc = e.pdfLibDoc;
  if (!items.length) throw toolkitError('ERR_BAD_ARGS', '请至少添加一条书签');
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlineRef = ctx.nextRef();
  const nodeRefs = items.map(() => ctx.nextRef());
  // 简化层级：level 只能为 0（顶级）或 1（子项）；>=2 按 1 处理
  const norm = items.map((it) => ({
    title: String(it.title ?? '').slice(0, 500) || `第 ${it.page + 1} 页`,
    page: Math.min(Math.max(0, Number(it.page) || 0), pages.length - 1),
    level: Math.min(1, Math.max(0, Number(it.level) || 0)),
  }));
  const mkNode = (it, ref, parentRef, prevRef, nextRef, children) => {
    const page = pages[it.page];
    const dict = ctx.obj({
      Title: pdfLib.PDFHexString.fromText(it.title),
      Parent: parentRef,
      Dest: ctx.obj([page.ref, pdfLib.PDFName.of('Fit')]),
    });
    if (prevRef) dict.set(pdfLib.PDFName.of('Prev'), prevRef);
    if (nextRef) dict.set(pdfLib.PDFName.of('Next'), nextRef);
    if (children?.length) {
      dict.set(pdfLib.PDFName.of('First'), children[0]);
      dict.set(pdfLib.PDFName.of('Last'), children[children.length - 1]);
      dict.set(pdfLib.PDFName.of('Count'), ctx.obj(children.length));
    }
    ctx.assign(ref, dict);
  };
  // 分组：顶级项 + 各自的子项
  const topIdx = [];
  const kidsOf = new Map();
  for (let i = 0; i < norm.length; i++) {
    if (norm[i].level === 0) topIdx.push(i);
    else {
      const parent = topIdx.length ? topIdx[topIdx.length - 1] : null;
      if (parent == null) { topIdx.push(i); continue; } // 无父项的子项提升为顶级
      if (!kidsOf.has(parent)) kidsOf.set(parent, []);
      kidsOf.get(parent).push(i);
    }
  }
  const topLevelRefs = topIdx.map((i) => nodeRefs[i]);
  for (let k = 0; k < topIdx.length; k++) {
    const i = topIdx[k];
    const kids = kidsOf.get(i) || [];
    for (let j = 0; j < kids.length; j++) {
      const ki = kids[j];
      mkNode(norm[ki], nodeRefs[ki], nodeRefs[i],
        j > 0 ? nodeRefs[kids[j - 1]] : null,
        j < kids.length - 1 ? nodeRefs[kids[j + 1]] : null, []);
    }
    mkNode(norm[i], nodeRefs[i], outlineRef,
      k > 0 ? nodeRefs[topIdx[k - 1]] : null,
      k < topIdx.length - 1 ? nodeRefs[topIdx[k + 1]] : null,
      kids.map((ki) => nodeRefs[ki]));
  }
  const rootDict = ctx.obj({ Type: 'Outlines' });
  if (topLevelRefs.length) {
    rootDict.set(pdfLib.PDFName.of('First'), topLevelRefs[0]);
    rootDict.set(pdfLib.PDFName.of('Last'), topLevelRefs[topLevelRefs.length - 1]);
    // Count = 可见条目总数（顶级 + 子项）
    rootDict.set(pdfLib.PDFName.of('Count'), ctx.obj(norm.length));
  }
  ctx.assign(outlineRef, rootDict);
  doc.catalog.set(pdfLib.PDFName.of('Outlines'), outlineRef);
  doc.catalog.set(pdfLib.PDFName.of('PageMode'), pdfLib.PDFName.of('UseOutlines'));
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '已加书签'), mime: 'application/pdf', bytes }], summary: { bookmarks: norm.length } };
};

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

function formOf(e) {
  try {
    return e.pdfLibDoc.getForm();
  } catch {
    throw toolkitError('ERR_BAD_ARGS', '该文件没有可用的表单（AcroForm）');
  }
}

handlers['form.list'] = async ({ docId }) => {
  const e = getDoc(docId);
  const form = formOf(e);
  const fields = form.getFields().map((f) => {
    const name = f.getName();
    let type = 'text', value = '', options = undefined;
    if (f instanceof pdfLib.PDFCheckBox) { type = 'checkbox'; value = f.isChecked(); }
    else if (f instanceof pdfLib.PDFRadioGroup) { type = 'radio'; value = f.getSelected() || ''; options = f.getOptions(); }
    else if (f instanceof pdfLib.PDFDropdown) { type = 'dropdown'; value = f.getSelected()?.[0] || ''; options = f.getOptions(); }
    else if (f instanceof pdfLib.PDFOptionList) { type = 'optionlist'; value = f.getSelected()?.[0] || ''; options = f.getOptions(); }
    else if (f instanceof pdfLib.PDFTextField) { type = 'text'; value = f.getText() || ''; }
    else if (f instanceof pdfLib.PDFButton) { type = 'button'; value = ''; }
    else if (f instanceof pdfLib.PDFSignature) { type = 'signature'; value = ''; }
    return { name, type, value, options };
  });
  return { fields };
};

handlers['form.fill'] = async ({ docId, values = {}, flatten = false }) => {
  const e = getDoc(docId);
  const form = formOf(e);
  let applied = 0;
  const errors = [];
  for (const f of form.getFields()) {
    const name = f.getName();
    if (!(name in values)) continue;
    const v = values[name];
    try {
      if (f instanceof pdfLib.PDFCheckBox) {
        if (v === true || v === 'true' || v === 1 || v === '是') f.check(); else f.uncheck();
      } else if (f instanceof pdfLib.PDFRadioGroup || f instanceof pdfLib.PDFDropdown || f instanceof pdfLib.PDFOptionList) {
        f.select(String(v));
      } else if (f instanceof pdfLib.PDFTextField) {
        f.setText(String(v ?? ''));
      }
      applied++;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  if (flatten) {
    try { form.flatten(); } catch (err) { errors.push(`扁平化失败: ${err.message}`); }
  }
  const bytes = await e.pdfLibDoc.save({ useObjectStreams: true });
  syncEntryBytes(e, e.pdfLibDoc, bytes);
  return {
    artifacts: [{ name: withSuffix(e.name, flatten ? '表单已填写并扁平化' : '表单已填写'), mime: 'application/pdf', bytes }],
    summary: { applied, errors },
  };
};

/** 创建表单字段。fields: [{type:'text'|'checkbox', name, page, x, y, w, h(视觉), value?, multiline?}] */
handlers['form.create'] = async ({ docId, fields = [], flatten = false }) => {
  const e = getDoc(docId);
  const doc = e.pdfLibDoc;
  const form = formOf(e);
  for (let i = 0; i < fields.length; i++) {
    checkAbort();
    const f = fields[i];
    const pm = pageMetaOf(e, f.page);
    const page = doc.getPage(f.page);
    // 视觉左上 (x,y) → 用户空间轴对齐框
    const p1 = geometry.visualToUser(f.x, f.y, pm.crop, pm.rot);
    const p2 = geometry.visualToUser(f.x + f.w, f.y + f.h, pm.crop, pm.rot);
    const ux = Math.min(p1.x, p2.x), uy = Math.min(p1.y, p2.y);
    const uw = Math.abs(p2.x - p1.x), uh = Math.abs(p2.y - p1.y);
    if (f.type === 'checkbox') {
      const cb = form.createCheckBox(f.name);
      cb.addToPage(page, { x: ux, y: uy, width: uw, height: uh });
      if (f.value === true || f.value === 'true') cb.check();
    } else {
      const tf = form.createTextField(f.name);
      if (f.multiline) tf.enableMultiline();
      tf.addToPage(page, { x: ux, y: uy, width: uw, height: uh });
      try { tf.setFontSize(Math.min(24, Math.max(4, Number(f.fontSize) || Math.round(uh * 0.62)))); } catch { /* 字体未就绪时跳过 */ }
      if (f.value) tf.setText(String(f.value));
    }
    progress({ done: i + 1, total: fields.length, stage: `创建字段 ${f.name}` });
  }
  if (flatten) { try { form.flatten(); } catch { /* noop */ } }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '表单已创建'), mime: 'application/pdf', bytes }], summary: { fields: fields.length } };
};

// ---------------------------------------------------------------------------
// 涂黑（真删除）/ 扁平化 / 栅格化 / 修复
// ---------------------------------------------------------------------------

/** PDF 涂黑：mupdf Redact 注解真删除内容；失败回退绘制不透明黑框 */
handlers['redact.apply'] = async ({ docId, marks = [], removeText = true }) => {
  if (!marks.length) throw toolkitError('ERR_BAD_ARGS', '请先标记要涂黑的区域');
  const e = getDoc(docId);
  let method = 'mupdf';
  let bytes = null;
  try {
    const m = await import('mupdf');
    const md = m.PDFDocument.openDocument(new Uint8Array(e.bytes.slice()), 'application/pdf');
    const byPage = new Map();
    for (const mk of marks) {
      if (!byPage.has(mk.page)) byPage.set(mk.page, []);
      byPage.get(mk.page).push(mk);
    }
    for (const [pageNo, list] of byPage) {
      checkAbort();
      const page = md.loadPage(pageNo);
      for (const mk of list) {
        // mupdf setRect 使用左上原点的视觉坐标（实证：visualToUser 变换反而上下颠倒）
        const annot = page.createAnnotation('Redact');
        annot.setRect([mk.x, mk.y, mk.x + mk.w, mk.y + mk.h]);
      }
      page.applyRedactions(
        true, // 绘制黑框
        m.PDFPage.REDACT_IMAGE_PIXELS,
        m.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
        removeText ? m.PDFPage.REDACT_TEXT_REMOVE : m.PDFPage.REDACT_TEXT_NONE,
      );
      progress({ done: pageNo + 1, total: e.pages.length, stage: `涂黑第 ${pageNo + 1} 页` });
    }
    bytes = md.saveToBuffer('garbage=2,decrypt=yes').asUint8Array();
  } catch {
    method = 'fallback';
  }
  if (!bytes) {
    // 回退：绘制不透明黑框（视觉等效，文字仍存在——界面会提示）
    const doc = e.pdfLibDoc;
    for (const mk of marks) {
      const pm = pageMetaOf(e, mk.page);
      const page = doc.getPage(mk.page);
      const p1 = geometry.visualToUser(mk.x, mk.y + mk.h, pm.crop, pm.rot);
      const p2 = geometry.visualToUser(mk.x + mk.w, mk.y, pm.crop, pm.rot);
      page.drawRectangle({
        x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y),
        color: pdfLib.rgb(0, 0, 0),
      });
    }
    bytes = await doc.save({ useObjectStreams: true });
    syncEntryBytes(e, doc, bytes);
  }
  return {
    artifacts: [{ name: withSuffix(e.name, '已涂黑'), mime: 'application/pdf', bytes }],
    summary: { marks: marks.length, method },
    warnings: method === 'fallback' ? ['引擎不支持深度涂黑，已改用不透明黑框遮盖（下层文字未物理删除，请知悉）'] : [],
  };
};

handlers['flatten.run'] = async ({ docId, mode = 'form', dpi = 150 }) => {
  const e = getDoc(docId);
  if (mode === 'form') {
    const form = formOf(e);
    form.flatten();
    const bytes = await e.pdfLibDoc.save({ useObjectStreams: true });
    syncEntryBytes(e, e.pdfLibDoc, bytes);
    return { artifacts: [{ name: withSuffix(e.name, '已扁平化'), mime: 'application/pdf', bytes }], summary: { mode } };
  }
  // raster：整册渲染重建（注释/图层/表单全部烧入）
  const out = await pdfLib.PDFDocument.create();
  for (let p = 0; p < e.pages.length; p++) {
    checkAbort();
    const r = await renderPageBitmap(e, p, { dpi, bg: '#ffffff', maxPixels: LIMITS.maxRenderPixels });
    const canvas = new OffscreenCanvas(r.width, r.height);
    canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const pm = e.pages[p];
    const page = out.addPage([pm.visualW, pm.visualH]);
    page.drawImage(img, { x: 0, y: 0, width: pm.visualW, height: pm.visualH });
    progress({ done: p + 1, total: e.pages.length, stage: `扁平化第 ${p + 1} 页` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(e.name, '已扁平化'), mime: 'application/pdf', bytes }], summary: { mode, dpi } };
};

handlers['raster.run'] = async ({ docId, pages = 'all', dpi = 150, format = 'jpeg', quality = 0.9, gray = false }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const out = await pdfLib.PDFDocument.create();
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const p = list[i];
    const r = await renderPageBitmap(e, p, { dpi, gray, bg: '#ffffff', maxPixels: LIMITS.maxRenderPixels });
    const canvas = new OffscreenCanvas(r.width, r.height);
    canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const type = format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type, quality });
    const img = type === 'image/jpeg'
      ? await out.embedJpg(new Uint8Array(await blob.arrayBuffer()))
      : await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
    const pm = e.pages[p];
    const page = out.addPage([pm.visualW, pm.visualH]);
    page.drawImage(img, { x: 0, y: 0, width: pm.visualW, height: pm.visualH });
    progress({ done: i + 1, total: list.length, stage: `栅格化第 ${p + 1} 页` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(e.name, '已栅格化'), mime: 'application/pdf', bytes }], summary: { pages: list.length, dpi, format } };
};

handlers['repair.run'] = async ({ docId }) => {
  const e = getDoc(docId);
  const warnings = [];
  // 首选 mupdf：重建交叉引用 + 垃圾回收
  try {
    const m = await import('mupdf');
    const md = m.PDFDocument.openDocument(new Uint8Array(e.bytes.slice()), 'application/pdf');
    const bytes = md.saveToBuffer('garbage=3,decrypt=yes').asUint8Array();
    return {
      artifacts: [{ name: withSuffix(e.name, '已修复'), mime: 'application/pdf', bytes }],
      summary: { via: 'mupdf', size: bytes.byteLength },
    };
  } catch (err) {
    warnings.push(`mupdf 修复失败：${err.message}`);
  }
  // 回退 pdf-lib 容错重存
  try {
    const doc = await pdfLibLoad(e.bytes);
    const bytes = await doc.save({ useObjectStreams: true });
    return {
      artifacts: [{ name: withSuffix(e.name, '已修复'), mime: 'application/pdf', bytes }],
      summary: { via: 'pdf-lib', size: bytes.byteLength },
      warnings,
    };
  } catch (err) {
    throw toolkitError('ERR_BAD_PDF', `无法修复该文件：${err.message}`);
  }
};

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

handlers['search.run'] = async ({ docId, query, pages = 'all', caseSensitive = false, regex = false }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  if (!query) throw toolkitError('ERR_BAD_ARGS', '请输入搜索词');
  const pjs = await import('pdfjs-dist');
  const doc = await pdfjsOpen(e);
  let re = null;
  if (regex) {
    try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch (err) { throw toolkitError('ERR_BAD_ARGS', `正则无效：${err.message}`); }
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const p = list[i];
    const page = await doc.getPage(p + 1);
    const tc = await page.getTextContent();
    const lines = [];
    for (const it of tc.items) {
      if (it.str === undefined) continue;
      lines.push({ y: it.transform[5], x: it.transform[4], str: it.str });
    }
    lines.sort((a, b) => b.y - a.y || a.x - b.x);
    const text = lines.map((l) => l.str).join('');
    const haystack = caseSensitive ? text : text.toLowerCase();
    const found = [];
    if (re) {
      re.lastIndex = 0;
      let m2;
      while ((m2 = re.exec(text)) && found.length < 200) {
        found.push(m2.index);
        if (m2.index === re.lastIndex) re.lastIndex++;
      }
    } else {
      let idx = haystack.indexOf(needle);
      while (idx !== -1 && found.length < 200) {
        found.push(idx);
        idx = haystack.indexOf(needle, idx + needle.length);
      }
    }
    if (found.length) {
      const snippets = found.slice(0, 8).map((idx) => {
        const s = Math.max(0, idx - 24);
        return `${s > 0 ? '…' : ''}${text.slice(s, idx + query.length + 24)}${idx + query.length + 24 < text.length ? '…' : ''}`;
      });
      hits.push({ page: p, count: found.length, snippets });
      total += found.length;
    }
    progress({ done: i + 1, total: list.length, stage: `搜索第 ${p + 1} 页` });
  }
  return { hits, total, query };
};

// ---------------------------------------------------------------------------
// 文本 → PDF（文本型）：嵌入 NotoSansSC-Text 预子集字体逐行绘制真实文字，
// 产物可框选/搜索/复制；KaTeX 公式 / Mermaid / 思维导图仍以 PNG 图片混排。
// 字体获取或嵌入失败时回退 rasterFallbackTextToPdf（Canvas 位图旧实现，见本区域末尾）。
// ---------------------------------------------------------------------------

const TEXT_FONT_FILES = {
  regular: 'NotoSansSC-Regular-Text.ttf',
  bold: 'NotoSansSC-Bold-Text.ttf',
};
const textFontBytesPromises = new Map(); // weight → Promise<ArrayBuffer>（worker 生命周期内复用，避免重复下载）

function textFontBase() {
  // 主线程 run() 会随 limits.assetBase 传入绝对基址；开发/直连场景回退构建期 BASE_URL
  if (LIMITS.assetBase) return LIMITS.assetBase;
  return import.meta.env.BASE_URL || '/';
}

/** 惰性加载文本型字库（同源 fetch /fonts/text/…，约 2.2MB/字重；生成脚本见 scripts/build_text_fonts.py） */
function loadTextFontBytes(weight) {
  if (!textFontBytesPromises.has(weight)) {
    const file = TEXT_FONT_FILES[weight] || TEXT_FONT_FILES.regular;
    textFontBytesPromises.set(weight, (async () => {
      const url = `${textFontBase()}fonts/text/${file}`;
      let resp;
      try {
        resp = await fetch(url);
      } catch {
        throw new Error(`字体请求失败：${url}`);
      }
      if (!resp.ok) throw new Error(`字体缺失（${url}），请确认部署包含 public/fonts/text`);
      return resp.arrayBuffer();
    })());
  }
  return textFontBytesPromises.get(weight);
}

/** base64 → bytes（用于 embedPng；逐字节填充避免大 buffer 一次性转换） */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// WinAnsi（PDF 标准字体编码）可表示判定：ASCII 可见区 / Latin-1 高半区 / WinAnsi 特有标点
const WIN_ANSI_EXTRA = '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D'
  + '\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178';

function isWinAnsiLine(s) {
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WIN_ANSI_EXTRA.includes(ch)) continue;
    return false;
  }
  return true;
}

const C_BODY = pdfLib.rgb(0.066, 0.066, 0.066);      // #111111 正文/代码
const C_QUOTE = pdfLib.rgb(0.33, 0.36, 0.42);        // 引用文字
const C_QUOTE_BAR = pdfLib.rgb(0.804, 0.835, 0.882); // #cbd5e1 引用左侧竖条
const C_CODE_BG = pdfLib.rgb(0.953, 0.957, 0.965);   // #f3f4f6 代码背景条
const C_HR = pdfLib.rgb(0.612, 0.639, 0.686);        // #9ca3af 分隔线
const C_GRID = pdfLib.rgb(0.667, 0.667, 0.667);      // #aaaaaa 表格线
const C_TH_BG = pdfLib.rgb(0.941, 0.941, 0.941);     // #f0f0f0 表头底

// 语法高亮 token 色（'#rrggbb'）→ pdf-lib rgb 缓存（mdhl 色板固定，条目个位数）
const HL_RGB = new Map();
const rgbOfHex = (hex) => {
  let c = HL_RGB.get(hex);
  if (!c) {
    const { r, g, b } = hexToRgb01(hex);
    c = pdfLib.rgb(r, g, b);
    HL_RGB.set(hex, c);
  }
  return c;
};

function textStyleOf(b, fontSize) {
  switch (b.type) {
    case 'h1': return { size: fontSize * 2.0, bold: true, before: fontSize * 1.2, after: fontSize * 0.6, lh: 1.3 };
    case 'h2': return { size: fontSize * 1.55, bold: true, before: fontSize * 1.0, after: fontSize * 0.5, lh: 1.3 };
    case 'h3': return { size: fontSize * 1.25, bold: true, before: fontSize * 0.8, after: fontSize * 0.4, lh: 1.35 };
    case 'li': return { size: fontSize, bold: false, indent: fontSize * 1.8 * ((b.level ?? 0) + 1), before: 2, after: 2, lh: 1.55 };
    case 'quote': return { size: fontSize * 0.95, bold: false, indent: fontSize * 1.2, before: 4, after: 4, lh: 1.55, quote: true };
    case 'code': return { size: fontSize * 0.92, bold: false, mono: true, indent: fontSize, before: 4, after: 4, lh: 1.45, code: true };
    default: return { size: fontSize, bold: false, before: 3, after: 3, lh: 1.6 };
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 表格列宽拟合：自然宽之和 ≤ 总宽直接用自然宽；否则按「富余水位」等比压缩，不低于最小宽 */
function fitColumns(natW, minW, total) {
  const sumNat = natW.reduce((a, b) => a + b, 0);
  if (sumNat <= total) return natW.slice();
  const sumMin = minW.reduce((a, b) => a + b, 0);
  if (sumMin >= total) { const eq = total / minW.length; return minW.map(() => eq); }
  const k = (total - sumMin) / (sumNat - sumMin);
  return natW.map((w, i) => minW[i] + (w - minW[i]) * k);
}

/**
 * blocks → 分页后的绘制项（纯计算；y 自内容区顶向下，绘制端换算 pdf-lib y-up）。
 * 项：{kind:'text', text, font, size, color, x, y(基线)}
 *   | {kind:'rect', x, yTop, w, h, color?, border?}
 *   | {kind:'hr', y}
 *   | {kind:'img', b64, x, yTop, w, h}
 * 富段模型：segs = [{t:'s',v}|{t:'b',v} 粗体|{t:'c',v} 行内代码|{t:'m'/'e',…} 栅格化原子]，表格单元格同构。
 * 西文按词折行（CJK 逐字可断）；行内代码用 Courier+浅灰底；列表悬挂缩进；代码块逐行选字体；表格单元格换行+跨页重复表头。
 */
function paginateBlocks(blocks, ctx) {
  const { pw, ph, margin, fontSize, maxW, fontReg, fontBold, fontCourier, charW, textW, hasGlyph } = ctx;
  const limitY = ph - margin * 2;
  const pages = [];
  let cur = [];
  let y = 0;
  const newPage = () => { pages.push(cur); cur = []; y = 0; };
  const addText = (text, font, size, x, baseline, color) => {
    cur.push({ kind: 'text', text, font, size, color, x, y: baseline });
  };
  const fontOf = (role, v) => {
    if (role === 'bold') return fontBold || fontReg;
    if (role === 'mono' && fontCourier && isWinAnsiLine(v)) return fontCourier;
    return fontReg;
  };
  // 相邻同字体/同底色/同前景色的文字原子合并为字符串 run（文本层按词连续，利于搜索/选中）
  const toRuns = (atoms) => {
    const runs = [];
    let buf = null;
    for (const a of atoms) {
      if (a.t === 't') {
        if (!buf || buf.font !== a.font || !!buf.code !== !!a.code || (buf.color || null) !== (a.color || null)) {
          buf = { t: 's', v: '', w: 0, font: a.font, code: a.code, color: a.color || null };
          runs.push(buf);
        }
        buf.v += a.v;
        buf.w += a.w;
      } else {
        buf = null;
        runs.push(a);
      }
    }
    return runs;
  };
  const isBreakableChar = (ch) => {
    const c = ch.codePointAt(0);
    return c >= 0x2e80 || (c >= 0x2010 && c <= 0x205e); // CJK/全角 + 破折引号类标点：逐字可断
  };
  /** 文本 → 原子流。charMode（代码块）逐字保留缩进；否则西文按词、CJK/空格逐字，缺字形字符丢弃。
   *  color：语法高亮前景色（仅代码块 token 携带），贯穿折行/hardSplit 到绘制。 */
  const atomsOfText = (v, font, size, { code = false, charMode = false, color = null } = {}) => {
    const out = [];
    const extra = color ? { color } : {};
    const pushCh = (ch, more) => {
      out.push({ t: 't', v: ch, w: charW(font, size, ch), font, size, code, ...extra, ...more });
    };
    if (charMode) {
      for (const ch of String(v ?? '')) if (hasGlyph(ch)) pushCh(ch, {});
      return out;
    }
    let word = '', wordW = 0;
    const flush = () => {
      if (!word) return;
      out.push({ t: 't', v: word, w: wordW, font, size, code, ...extra });
      word = ''; wordW = 0;
    };
    for (const ch of String(v ?? '')) {
      if (!hasGlyph(ch)) continue;
      if (/\s/.test(ch)) {
        flush();
        pushCh(ch, { space: true });
        continue;
      }
      if (isBreakableChar(ch)) {
        flush();
        pushCh(ch, {});
        continue;
      }
      word += ch;
      wordW += charW(font, size, ch);
    }
    flush();
    return out;
  };
  /** 富段 → 原子流（blockBold：标题/表头的 s 段整体加粗） */
  const atomsOfSegs = (segs, size, blockBold) => {
    const out = [];
    for (const seg of segs) {
      if (seg.t === 'm' || seg.t === 'e') {
        if (!seg.b64) continue;
        const hPt = seg.hPt || 0;
        out.push({ t: 'img', b64: seg.b64, w: seg.wPt || 0, hPt, baselinePt: clamp(Math.min(seg.baselinePt ?? hPt, hPt), 0, hPt) });
        continue;
      }
      const isCode = seg.t === 'c';
      const role = (seg.t === 'b' || (blockBold && seg.t === 's')) ? 'bold' : 'reg';
      const font = fontOf(isCode ? 'mono' : role, String(seg.v ?? ''));
      out.push(...atomsOfText(String(seg.v ?? ''), font, size, { code: isCode }));
    }
    return out;
  };
  /**
   * 词感知折行：行尾空格为回退断点；整词放不下断行；单原子超行宽按字符硬切；
   * 行首空格丢弃；图片原子超宽独占一行。availOf(rowIdx) 支持悬挂缩进。
   */
  const wrapRows = (atoms, availOf) => {
    const rows = [];
    let row = [], rowW = 0, spaceAt = -1;
    const avail = () => availOf(rows.length);
    const breakLine = () => { rows.push(row); row = []; rowW = 0; spaceAt = -1; };
    const hardSplit = (a) => { // 单原子超行宽：按字符切（保留原子字体/底色属性）
      let buf = '', bufW = 0;
      for (const ch of a.v) {
        const cw = charW(a.font, a.size, ch);
        if (buf && rowW + bufW + cw > avail()) {
          row.push({ ...a, v: buf, w: bufW });
          rowW += bufW;
          breakLine();
          buf = '';
          bufW = 0;
        }
        buf += ch;
        bufW += cw;
      }
      if (buf) { row.push({ ...a, v: buf, w: bufW }); rowW += bufW; }
    };
    for (const a of atoms) {
      if (a.t === 'img') {
        if (row.length && rowW + a.w > avail()) breakLine();
        if (a.w > avail()) { row.push(a); rowW += a.w; breakLine(); continue; } // 超宽图独立成行
        row.push(a);
        rowW += a.w;
        spaceAt = -1;
        continue;
      }
      if (a.space) {
        if (!row.length) continue; // 行首空格丢弃
        row.push(a);
        rowW += a.w;
        spaceAt = row.length;
        continue;
      }
      if (row.length && rowW + a.w > avail()) {
        if (spaceAt >= 0 && spaceAt < row.length) { row = row.slice(0, spaceAt); } // 回退空格断点（丢行尾空格）
        breakLine();
        if (a.w > avail() && String(a.v ?? '').length > 1) { hardSplit(a); continue; }
        row.push(a);
        rowW += a.w;
        continue;
      }
      if ((!row.length || rows.length === 0) && a.w > avail() && String(a.v ?? '').length > 1) { hardSplit(a); continue; }
      row.push(a);
      rowW += a.w;
    }
    if (row.length || !rows.length) rows.push(row);
    return rows;
  };

  const total = blocks.length;
  const step = Math.max(1, Math.ceil(total / 10));
  let nextMilestone = step;
  for (let bi = 0; bi < total; bi++) {
    checkAbort();
    if (bi >= nextMilestone) {
      progress({ done: bi, total, stage: '排版中…' });
      nextMilestone += step;
    }
    const b = blocks[bi];
    if (b.type === 'pagebreak') { newPage(); continue; }
    if (b.type === 'hr') {
      if (y + 8 + 2 + 8 > limitY) newPage();
      y += 8;
      cur.push({ kind: 'hr', y });
      y += 2 + 8;
      continue;
    }
    if (b.type === 'table') {
      const normCell = (c) => (Array.isArray(c) ? c : [{ t: 's', v: String(c ?? '') }]);
      const rows = (b.rows || []).map((r) => (Array.isArray(r) ? r.map(normCell) : [normCell(r)]));
      if (!rows.length) continue;
      const cellSize = fontSize * 0.95;
      const cellLh = cellSize * 1.45;
      const vPad = 4;
      const hPad = 5;
      const nCols = Math.max(...rows.map((r) => r.length));
      const grid = rows.map((r) => { const c = r.slice(); while (c.length < nCols) c.push([{ t: 's', v: '' }]); return c; });
      const cellAtoms = grid.map((r, ri) => r.map((cell) => atomsOfSegs(cell, cellSize, ri === 0)));
      const natW = [], minW = [];
      for (let ci = 0; ci < nCols; ci++) {
        let nat = 0, min = 0;
        for (const r of cellAtoms) {
          const atoms = r[ci];
          nat = Math.max(nat, atoms.reduce((s, a) => s + a.w, 0));
          for (const a of atoms) min = Math.max(min, a.img ? Math.min(a.w, maxW) : a.w);
        }
        natW.push(Math.min(maxW, nat + hPad * 2));
        minW.push(Math.min(maxW, Math.max(28, min + hPad * 2)));
      }
      const widths = fitColumns(natW, minW, maxW);
      const cellLines = cellAtoms.map((r) => r.map((atoms, ci) => wrapRows(atoms, () => widths[ci] - hPad * 2)));
      const rowH = cellLines.map((r) => Math.max(1, ...r.map((lines) => Math.max(1, lines.length))) * cellLh + vPad * 2);
      const emitRow = (ri, top) => {
        let x = margin;
        for (let ci = 0; ci < nCols; ci++) {
          cur.push({
            kind: 'rect', x, yTop: top, w: widths[ci], h: rowH[ri],
            color: ri === 0 ? C_TH_BG : undefined,
            border: { color: C_GRID, width: 0.6 },
          });
          const lines = cellLines[ri][ci];
          for (let li = 0; li < lines.length; li++) {
            const baseline = top + vPad + li * cellLh + cellSize * 1.1;
            let cx = x + hPad;
            for (const r of toRuns(lines[li])) {
              if (r.t === 's') {
                if (r.v) {
                  if (r.code) cur.push({ kind: 'rect', x: cx - 1.5, yTop: baseline - cellSize * 1.02, w: r.w + 3, h: cellSize * 1.42, color: C_CODE_BG });
                  addText(r.v, r.font, cellSize, cx, baseline, C_BODY);
                }
              } else {
                cur.push({ kind: 'img', b64: r.b64, x: cx, yTop: baseline - r.baselinePt, w: r.w, h: r.hPt });
              }
              cx += r.w;
            }
          }
          x += widths[ci];
        }
      };
      // 表格上下留白：对齐 GitHub 表格规范（margin-bottom 16px≈12pt 视觉白隙）与 Eisvogel
      // （arraystretch 1.3、表格与正文间留呼吸）。after 20pt 是因为紧随其后的文字 ascent
      // 会吃掉 ~9pt（实测 border→墨迹 12pt+），原 6pt 时灰底几乎贴死表格——用户反馈过挤
      y += 8;
      for (let ri = 0; ri < grid.length; ri++) {
        if (y + rowH[ri] > limitY) {
          newPage();
          if (ri > 0) { emitRow(0, y); y += rowH[0]; } // 跨页重复表头
        }
        emitRow(ri, y);
        y += rowH[ri];
      }
      y += 20;
      continue;
    }
    if (b.type === 'img') {
      // 富渲染栅格化块（公式/图形）：b64 PNG + pt 尺寸；宽 clamp maxW、超高缩页内、水平居中
      if (!b.b64) continue;
      const availH = limitY;
      let w = Math.min(maxW, b.wPt || maxW);
      let h = (b.hPt || w) * w / (b.wPt || 1);
      if (h > availH) { w = (b.wPt || 1) * availH / (b.hPt || 1); h = availH; }
      const gap = fontSize * 0.4;
      if (y + gap + h + gap > limitY) newPage();
      y += gap;
      cur.push({ kind: 'img', b64: b.b64, x: (pw - w) / 2, yTop: y, w, h });
      y += h + gap;
      continue;
    }

    const st = textStyleOf(b, fontSize);
    const isCodeBlock = b.type === 'code';
    const availW = Math.max(8, maxW - (st.indent || 0));
    const marker = b.type === 'li' ? (b.marker ?? '•') : null;
    const markerW = marker ? textW(fontReg, st.size, `${marker} `) : 0;
    // 原子流：富段按角色选字体；代码块逐行选字体（纯 WinAnsi 行用 Courier）；纯文本块整块字体
    let paraLists;
    if (Array.isArray(b.segs)) {
      paraLists = [[]];
      for (const seg of b.segs) {
        if (seg.t === 'm' || seg.t === 'e') {
          if (!seg.b64) continue;
          const hPt = seg.hPt || 0;
          paraLists[paraLists.length - 1].push({
            t: 'img', b64: seg.b64, w: seg.wPt || 0, hPt,
            baselinePt: clamp(Math.min(seg.baselinePt ?? hPt, hPt), 0, hPt),
          });
          continue;
        }
        const isCode = seg.t === 'c';
        const role = (seg.t === 'b' || (st.bold && seg.t === 's')) ? 'bold' : 'reg';
        const segFont = fontOf(isCode ? 'mono' : role, String(seg.v ?? ''));
        const parts = String(seg.v ?? '').split('\n');
        parts.forEach((part, idx) => {
          if (idx > 0 && paraLists[paraLists.length - 1].length) paraLists.push([]);
          const list = paraLists[paraLists.length - 1];
          list.push(...atomsOfText(part, segFont, st.size, { code: isCode }));
        });
      }
    } else if (isCodeBlock) {
      // 语法高亮：b.tokens = [{v,c}]（mdhl 产出，token 连回 === 原文）按 \n 断行逐 token 着色；
      // 无 tokens（未知语言/旧调用）回退整块单色
      const monoFor = (v) => (fontCourier && isWinAnsiLine(v) ? fontCourier : fontReg);
      const lineToks = Array.isArray(b.tokens) ? tokenLines(b.tokens) : String(b.text ?? '').split('\n').map((v) => [{ v }]);
      paraLists = lineToks.map((line) => line.flatMap((tk) => (
        atomsOfText(tk.v, monoFor(tk.v), st.size, { charMode: true, color: tk.c || null })
      )));
    } else {
      const font = st.bold ? (fontBold || fontReg) : fontReg;
      paraLists = String(b.text ?? '').split('\n').map((para) => atomsOfText(para, font, st.size));
    }
    // 折行：代码块逐字（保留缩进）；其余词感知，所有行让位 marker（悬挂缩进）
    const lineH = st.size * st.lh;
    const rowsAll = [];
    for (const atoms of paraLists) {
      let rows;
      if (isCodeBlock) {
        rows = [];
        let row = [], rowW = 0;
        for (const a of atoms) {
          if (rowW + a.w > availW && row.length) { rows.push(row); row = []; rowW = 0; }
          row.push(a);
          rowW += a.w;
        }
        rows.push(row);
      } else {
        rows = wrapRows(atoms, () => (marker ? availW - markerW : availW));
      }
      for (const r of rows) rowsAll.push({ atoms: r, first: rowsAll.length === 0 });
    }
    if (rowsAll.length) rowsAll[rowsAll.length - 1].last = true;
    // 逐行落位（超页换页；段前/段后只在块首/块尾计）
    for (const { atoms, first, last } of rowsAll) {
      if (y + lineH > limitY) newPage();
      if (first) y += st.before || 0;
      const runs = toRuns(atoms);
      const contIndent = marker && !first ? markerW : 0; // 悬挂缩进：续行对齐首行文字起点
      const lineWidth = runs.reduce((s, r) => s + r.w, 0) + (first && marker ? markerW : 0);
      let x0 = margin + (st.indent || 0) + contIndent;
      if (b.align === 'center') x0 = (pw - lineWidth) / 2;
      else if (b.align === 'right') x0 = pw - margin - lineWidth;
      const baseline = y;
      if (st.code) cur.push({ kind: 'rect', x: margin, yTop: baseline - st.size * 1.05, w: maxW, h: lineH, color: C_CODE_BG });
      if (st.quote) cur.push({ kind: 'rect', x: margin, yTop: baseline - st.size * 1.05, w: 2, h: lineH, color: C_QUOTE_BAR });
      let x = x0;
      if (first && marker) {
        addText(`${marker} `, fontReg, st.size, x, baseline, st.quote ? C_QUOTE : C_BODY);
        x += markerW;
      }
      for (const r of runs) {
        if (r.t === 's') {
          if (r.v) {
            if (r.code) cur.push({ kind: 'rect', x: x - 1.5, yTop: baseline - st.size * 1.02, w: r.w + 3, h: st.size * 1.42, color: C_CODE_BG });
            addText(r.v, r.font, st.size, x, baseline, r.color ? rgbOfHex(r.color) : (st.quote ? C_QUOTE : C_BODY));
          }
        } else {
          cur.push({ kind: 'img', b64: r.b64, x, yTop: baseline - r.baselinePt, w: r.w, h: r.hPt });
        }
        x += r.w;
      }
      y += lineH;
      if (last) y += st.after || 0;
    }
  }
  pages.push(cur);
  return pages.filter((p) => p.length);
}

/** 文本型构建：字体嵌入 → 排版分页 → 逐页绘制（文字 drawText / 图形 drawImage） */
async function buildTextPdfVector({ name, blocks, paper, margin, fontSize, title }) {
  const [pw, ph] = PAPERS[paper] || PAPERS.a4;
  const maxW = pw - margin * 2;
  const out = await pdfLib.PDFDocument.create();
  out.registerFontkit(fontkit);

  // 1) 字体：subset:false 嵌入（subset:true 对 CJK 产出损坏字形——见 scripts/build_text_fonts.py 头注）；
  //    Bold 惰性（仅标题/表头/粗体段文档加载）；Courier 供纯 WinAnsi 代码块与行内代码使用
  let fontReg, fontBold = null, fontCourier = null;
  try {
    fontReg = await out.embedFont(await loadTextFontBytes('regular'), { subset: false });
    const needsBold = blocks.some((b) => b.type === 'h1' || b.type === 'h2' || b.type === 'h3' || b.type === 'table'
      || (Array.isArray(b.segs) && b.segs.some((s) => s.t === 'b')));
    if (needsBold) fontBold = await out.embedFont(await loadTextFontBytes('bold'), { subset: false });
    const hasMonoUse = blocks.some((b) => b.type === 'code'
      || (Array.isArray(b.segs) && b.segs.some((s) => s.t === 'c')));
    if (hasMonoUse) fontCourier = await out.embedFont(pdfLib.StandardFonts.Courier);
  } catch (err) {
    const ferr = new Error(err?.message || String(err));
    ferr.fontFailure = true;
    throw ferr;
  }
  // 字形覆盖探测（fontkit）：缺字形字符在排版期丢弃——否则画成 .notdef 空框并污染文本层 ToUnicode
  const kitFont = fontReg?.embedder?.font ?? null;
  const glyphCache = new Map();
  const hasGlyph = (ch) => {
    let v = glyphCache.get(ch);
    if (v === undefined) {
      try {
        v = kitFont?.hasGlyphForCodePoint ? kitFont.hasGlyphForCodePoint(ch.codePointAt(0)) : true;
      } catch {
        v = true;
      }
      glyphCache.set(ch, v);
    }
    return v;
  };

  // 2) 排版 + 分页（pdf-lib 字体度量，与绘制完全同源）
  const widthCaches = new Map(); // font → (size → (ch → pt 宽))
  const charW = (font, size, ch) => {
    let bySize = widthCaches.get(font);
    if (!bySize) { bySize = new Map(); widthCaches.set(font, bySize); }
    let byCh = bySize.get(size);
    if (!byCh) { byCh = new Map(); bySize.set(size, byCh); }
    let w = byCh.get(ch);
    if (w === undefined) {
      w = font.widthOfTextAtSize(ch, size);
      byCh.set(ch, w);
    }
    return w;
  };
  const textW = (font, size, s) => {
    let t = 0;
    for (const ch of String(s)) t += charW(font, size, ch);
    return t;
  };
  const pages = paginateBlocks(blocks, { pw, ph, margin, fontSize, maxW, fontReg, fontBold, fontCourier, charW, textW, hasGlyph });
  if (!pages.length) throw toolkitError('ERR_NO_INPUT', '排版结果为空');

  // 3) 逐页绘制（按阅读顺序逐行 drawText，保证文本层可搜索/可选中）
  const pngCache = new Map(); // b64 → 已嵌入图像（同图只嵌入一次）
  const embedPng = async (b64) => {
    let img = pngCache.get(b64);
    if (!img) {
      img = await out.embedPng(base64ToBytes(b64));
      pngCache.set(b64, img);
    }
    return img;
  };
  for (let pi = 0; pi < pages.length; pi++) {
    checkAbort();
    const page = out.addPage([pw, ph]);
    const pdfY = (yTopDown) => ph - margin - yTopDown; // 内容顶坐标（y 自上而下）→ PDF y-up
    for (const it of pages[pi]) {
      if (it.kind === 'text') {
        page.drawText(it.text, { x: it.x, y: pdfY(it.y), size: it.size, font: it.font, color: it.color });
      } else if (it.kind === 'rect') {
        page.drawRectangle({
          x: it.x, y: pdfY(it.yTop) - it.h, width: it.w, height: it.h,
          ...(it.color ? { color: it.color } : {}),
          ...(it.border ? { borderColor: it.border.color, borderWidth: it.border.width } : {}),
        });
      } else if (it.kind === 'hr') {
        page.drawLine({
          start: { x: margin, y: pdfY(it.y) }, end: { x: pw - margin, y: pdfY(it.y) },
          thickness: 0.8, color: C_HR,
        });
      } else if (it.kind === 'img') {
        const png = await embedPng(it.b64);
        page.drawImage(png, { x: it.x, y: pdfY(it.yTop) - it.h, width: it.w, height: it.h });
      }
    }
    progress({ done: pi + 1, total: pages.length, stage: `写入第 ${pi + 1} 页` });
  }
  if (title) { try { out.setTitle(title); } catch { /* noop */ } }
  try { out.setLanguage('zh-CN'); } catch { /* noop */ }
  const bytes = await out.save({ useObjectStreams: true });
  const outName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  return { artifacts: [{ name: outName, mime: 'application/pdf', bytes }], summary: { pages: pages.length, mode: 'text' } };
}

handlers['text.toPdf'] = async ({ name = '文档', blocks = [], paper = 'a4', margin = 48, fontSize = 11, title = '' }) => {
  if (!blocks.length) throw toolkitError('ERR_NO_INPUT', '内容为空');
  try {
    return await buildTextPdfVector({ name, blocks, paper, margin, fontSize, title });
  } catch (err) {
    if (!err || err.fontFailure !== true) throw err;
    // 字体获取/嵌入失败：回退图片型（Canvas 栅格）实现
    const fb = await rasterFallbackTextToPdf({ name, blocks, paper, margin, fontSize, title });
    return {
      ...fb,
      warnings: [`内嵌字体加载失败（${err.message}），已回退为图片型 PDF（文字暂不可选中/搜索）`],
    };
  }
};

// ---------------------------------------------------------------------------
// 文本 → PDF（图片型回退：Canvas 位图 → JPEG；仅在文本型字体加载/嵌入失败时使用）
// ---------------------------------------------------------------------------

const TP_K = 2; // 渲染倍率（清晰度）

function tpFont(size, bold, italic, mono) {
  const fam = mono ? "'Courier New', monospace" : `'pdftoolkit-cjk', 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${Math.round(size * TP_K)}px ${fam}`;
}

/** 绘制期字体：画布已 scale(TP_K)（用户单位=pt），字体尺寸直接用 pt；
 *  tpFont 的 TP_K 倍率仅适用于未缩放的测量画布（测得 px/TP_K=pt）。 */
function tpFontDraw(size, bold, italic, mono) {
  const fam = mono ? "'Courier New', monospace" : `'pdftoolkit-cjk', 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${Math.round(size)}px ${fam}`;
}

/** blocks → 分页后的渲染任务（纯计算）——旧栅格实现 */
function rasterPaginate(blocks, opts) {
  const { paper = 'a4', margin = 48, fontSize = 11 } = opts;
  const [pw0, ph0] = PAPERS[paper] || PAPERS.a4;
  const maxW = pw0 - margin * 2;
  const styleOf = (b) => {
    switch (b.type) {
      case 'h1': return { size: fontSize * 2.0, bold: true, before: fontSize * 1.2, after: fontSize * 0.6, lh: 1.3 };
      case 'h2': return { size: fontSize * 1.55, bold: true, before: fontSize * 1.0, after: fontSize * 0.5, lh: 1.3 };
      case 'h3': return { size: fontSize * 1.25, bold: true, before: fontSize * 0.8, after: fontSize * 0.4, lh: 1.35 };
      case 'li': return { size: fontSize, bold: false, indent: fontSize * 1.8 * ((b.level ?? 0) + 1), before: 2, after: 2, lh: 1.55 };
      case 'quote': return { size: fontSize * 0.95, bold: false, indent: fontSize * 1.2, before: 4, after: 4, lh: 1.55, gray: true };
      case 'code': return { size: fontSize * 0.92, bold: false, mono: true, indent: fontSize, before: 4, after: 4, lh: 1.45, code: true };
      default: return { size: fontSize, bold: false, before: 3, after: 3, lh: 1.6 };
    }
  };
  const lines = [];
  for (const b of blocks) {
    if (b.type === 'pagebreak') { lines.push({ brk: true }); continue; }
    if (b.type === 'hr') { lines.push({ hr: true, before: 8, after: 8 }); continue; }
    if (b.type === 'table') {
      lines.push({ table: b.rows || [], before: 8, after: 20, fontSize });
      continue;
    }
    if (b.type === 'img') {
      // 富渲染栅格化块（公式/图形）：b64 PNG + pt 尺寸
      lines.push({ img: { b64: b.b64, wPt: b.wPt, hPt: b.hPt }, before: fontSize * 0.4, after: fontSize * 0.4 });
      continue;
    }
    const st = styleOf(b);
    if (Array.isArray(b.segs)) {
      // 富文本块（含行内数学原子）：segs = [{t:'s',v}|{t:'m',b64,wPt,hPt,baselinePt}]
      lines.push({ rich: true, segs: b.segs, st, type: b.type, align: b.align || 'left', marker: b.type === 'li' ? (b.marker || '•') : null });
      continue;
    }
    const text = String(b.text ?? '');
    const paras = text.split('\n');
    for (const para of paras) {
      lines.push({ para, st, type: b.type, align: b.align || (b.type === 'li' ? 'left' : 'left'), marker: b.type === 'li' ? (b.marker || '•') : null });
    }
  }
  return { lines, pw: pw0, ph: ph0, maxW, margin };
}

/** 旧 Canvas 位图实现原样保留（字体加载失败时的兜底；产物文字不可选中/搜索） */
async function rasterFallbackTextToPdf({ name = '文档', blocks = [], paper = 'a4', margin = 48, fontSize = 11, title = '' }) {
  await ensureWorkerCJKFont();
  const { lines, pw, ph, maxW } = rasterPaginate(blocks, { paper, margin, fontSize });
  // 逐行排版（Canvas measureText，与渲染同字体设定，保证一致）
  const layout = []; // {kind:'line', text|segments, x, yBaseline, size, ...}
  let pageLayouts = [];
  let cur = [];
  let y = margin;
  const measure = (text, st) => {
    const c = new OffscreenCanvas(8, 8).getContext('2d');
    c.font = tpFont(st.size, st.bold, false, st.mono);
    return c.measureText(text).width / TP_K;
  };
  const wrap = (text, st, width) => {
    if (!text) return [''];
    const c = new OffscreenCanvas(8, 8).getContext('2d');
    c.font = tpFont(st.size, st.bold, false, st.mono);
    const unitW = (ch) => c.measureText(ch).width / TP_K;
    const out = [];
    let line = '', w = 0;
    for (const ch of text) {
      const cw = unitW(ch);
      if (w + cw > width && line) {
        out.push(line);
        line = ch === ' ' ? '' : ch;
        w = line ? cw : 0;
        if (ch === ' ') { line = ''; w = 0; }
      } else {
        line += ch;
        w += cw;
      }
    }
    out.push(line);
    return out;
  };
  // 富路径字符宽度缓存（per-style，防 O(n²) 重复 measureText）
  const charCache = new Map(); // fontSpec → Map(ch → pt 宽)
  const probeCtx = new OffscreenCanvas(8, 8).getContext('2d');
  const charW = (ch, st) => {
    const key = tpFont(st.size, st.bold, false, st.mono);
    let m = charCache.get(key);
    if (!m) { m = new Map(); charCache.set(key, m); }
    let w = m.get(ch);
    if (w === undefined) {
      probeCtx.font = key;
      w = probeCtx.measureText(ch).width / TP_K;
      m.set(ch, w);
    }
    return w;
  };
  // 富段逐原子字体（b 段粗体 / c 段等宽）的宽度测量
  const charWF = (ch, size, bold, mono) => {
    const key = tpFont(size, bold, false, mono);
    let m = charCache.get(key);
    if (!m) { m = new Map(); charCache.set(key, m); }
    let w = m.get(ch);
    if (w === undefined) {
      probeCtx.font = key;
      w = probeCtx.measureText(ch).width / TP_K;
      m.set(ch, w);
    }
    return w;
  };
  for (const item of lines) {
    checkAbort();
    if (item.brk) {
      pageLayouts.push(cur);
      cur = [];
      y = margin;
      continue;
    }
    if (item.hr) {
      if (y + item.before + 2 + item.after > ph - margin) { pageLayouts.push(cur); cur = []; y = margin; }
      y += item.before;
      cur.push({ kind: 'hr', y });
      y += 2 + item.after;
      continue;
    }
    if (item.table) {
      // 表格：等比列宽，逐行绘制（富段单元格展平为纯文本——位图回退路径不做富排版）
      const cellPlain = (c) => (Array.isArray(c) ? c.map((s) => String(s?.v ?? '')).join('') : String(c ?? ''));
      const rows = item.table.map((r) => (Array.isArray(r) ? r.map(cellPlain) : [cellPlain(r)]));
      if (!rows.length) continue;
      const nCols = Math.max(...rows.map((r) => r.length));
      const probe = new OffscreenCanvas(8, 8).getContext('2d');
      probe.font = tpFont(fontSize * 0.95, false, false, false);
      const colW = [];
      for (let cIdx = 0; cIdx < nCols; cIdx++) {
        let mx = 0;
        for (const r of rows) mx = Math.max(mx, probe.measureText(r[cIdx] || '').width / TP_K);
        colW.push(mx + 10);
      }
      const sum = colW.reduce((a, b) => a + b, 0);
      const scaled = colW.map((w) => Math.max(24, w / sum * maxW));
      const totalW = Math.min(maxW, scaled.reduce((a, b) => a + b, 0));
      const k = totalW / scaled.reduce((a, b) => a + b, 0);
      const widths = scaled.map((w) => w * k);
      const rh = fontSize * 0.95 * 1.5 + 8;
      y += item.before;
      for (let ri = 0; ri < rows.length; ri++) {
        if (y + rh > ph - margin) { pageLayouts.push(cur); cur = []; y = margin; }
        const row = { kind: 'tableRow', yTop: y, h: rh, cells: [], widths, header: ri === 0 };
        let x = 0;
        for (let ci = 0; ci < widths.length; ci++) {
          row.cells.push({ text: rows[ri][ci] || '', x });
          x += widths[ci];
        }
        cur.push(row);
        y += rh;
      }
      y += item.after;
      continue;
    }
    if (item.img) {
      // 图形/公式块：maxW 内取宽，超高则等比缩到页内；y+h 超页换页；水平居中
      const it = item.img;
      const availH = ph - margin * 2;
      let w = Math.min(maxW, it.wPt || maxW);
      let h = (it.hPt || w) * w / (it.wPt || 1);
      if (h > availH) { w = (it.wPt || 1) * availH / (it.hPt || 1); h = availH; }
      if (y + item.before + h + item.after > ph - margin) { pageLayouts.push(cur); cur = []; y = margin; }
      y += item.before;
      cur.push({ kind: 'img', b64: it.b64, x: (pw - w) / 2, y, w, h });
      y += h + item.after;
      continue;
    }
    if (item.rich) {
      // 富文本行：segs 展开为原子流（文字按字符、栅格化原子整体），逐原子累计宽度折行
      const st = item.st;
      const availW = maxW - (st.indent || 0);
      const prefixW = item.marker ? measure(`${item.marker} `, st) : 0;
      const rows = [];
      let run = [], w = 0, first = true;
      for (const seg of item.segs) {
        if (seg.t === 'm' || seg.t === 'e') {
          const atom = { t: 'm', b64: seg.b64, w: seg.wPt, hPt: seg.hPt, baselinePt: Math.min(Math.max(seg.baselinePt ?? seg.hPt, 0), seg.hPt) };
          if (w + atom.w > (first ? availW - prefixW : availW) && run.length) { rows.push({ runs: run, w }); run = []; w = 0; first = false; }
          run.push(atom);
          w += atom.w;
          continue;
        }
        const segBold = seg.t === 'b' || (st.bold && seg.t === 's');
        const segMono = seg.t === 'c';
        for (const ch of String(seg.v ?? '')) {
          if (ch === '\n') { if (run.length) { rows.push({ runs: run, w }); run = []; w = 0; } first = false; continue; }
          const atom = { t: 't', v: ch, w: charWF(ch, st.size, segBold, segMono), bold: segBold || undefined, mono: segMono || undefined };
          if (w + atom.w > (first ? availW - prefixW : availW) && run.length) { rows.push({ runs: run, w }); run = []; w = 0; first = false; }
          run.push(atom);
          w += atom.w;
        }
      }
      rows.push({ runs: run, w });
      for (let wi = 0; wi < rows.length; wi++) {
        const lineH = st.size * st.lh;
        if (y + lineH > ph - margin) { pageLayouts.push(cur); cur = []; y = margin; }
        if (wi === 0) y += st.before || 0;
        const row = rows[wi];
        const runs = wi === 0 && item.marker
          ? [{ t: 't', v: `${item.marker} `, w: prefixW }, ...row.runs]
          : row.runs;
        cur.push({
          kind: 'rich', runs, y,
          width: row.w + (wi === 0 && item.marker ? prefixW : 0),
          size: st.size, bold: st.bold || undefined, gray: st.gray || undefined,
          mono: st.mono || undefined, code: st.code || undefined,
          align: item.align, indent: st.indent || 0,
        });
        y += lineH;
        if (wi === rows.length - 1) y += st.after || 0;
      }
      continue;
    }
    const st = item.st;
    const availW = maxW - (st.indent || 0);
    const wrapped = wrap(item.para, st, availW);
    for (let wi = 0; wi < wrapped.length; wi++) {
      const lineH = st.size * st.lh;
      if (y + lineH > ph - margin) { pageLayouts.push(cur); cur = []; y = margin; }
      if (wi === 0) y += st.before || 0;
      const text = wrapped[wi];
      const prefix = wi === 0 && item.marker ? `${item.marker} ` : '';
      cur.push({
        kind: 'text', text: prefix + text, y,
        size: st.size, bold: st.bold || undefined, gray: st.gray || undefined,
        mono: st.mono || undefined, code: st.code || undefined,
        align: item.align, indent: st.indent || 0,
        markerWidth: prefix ? measure(`${item.marker} `, st) : 0,
      });
      y += lineH;
      if (wi === wrapped.length - 1) y += st.after || 0;
    }
  }
  if (cur.length) pageLayouts.push(cur);
  pageLayouts = pageLayouts.filter((p) => p.length);
  if (!pageLayouts.length) throw toolkitError('ERR_NO_INPUT', '排版结果为空');

  // 渲染每页 → JPEG → PDF
  const out = await pdfLib.PDFDocument.create();
  const pngCache = new Map(); // b64 → 已嵌入图像（同图只嵌入一次）
  const embedPng = async (b64) => {
    let img = pngCache.get(b64);
    if (!img) {
      img = await out.embedPng(base64ToBytes(b64));
      pngCache.set(b64, img);
    }
    return img;
  };
  for (let pi = 0; pi < pageLayouts.length; pi++) {
    checkAbort();
    const canvas = new OffscreenCanvas(Math.round(pw * TP_K), Math.round(ph * TP_K));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(TP_K, TP_K);
    for (const ln of pageLayouts[pi]) {
      if (ln.kind === 'hr') {
        ctx.strokeStyle = '#999999';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(margin, ln.y);
        ctx.lineTo(pw - margin, ln.y);
        ctx.stroke();
      } else if (ln.kind === 'tableRow') {
        let x = margin;
        for (let ci = 0; ci < ln.cells.length; ci++) {
          if (ln.header) {
            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(x + margin, ln.yTop, ln.widths[ci], ln.h);
          }
          ctx.strokeStyle = '#aaaaaa';
          ctx.lineWidth = 0.6;
          ctx.strokeRect(x + margin, ln.yTop, ln.widths[ci], ln.h);
          ctx.fillStyle = '#111111';
          ctx.font = tpFontDraw(fontSize * 0.95, ln.header, false, false);
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(ln.cells[ci].text, x + margin + 5, ln.yTop + ln.h - 6);
          x += ln.widths[ci];
        }
      } else if (ln.kind === 'img') {
        // 图形块在页级以 PNG 叠画（见下方 drawPageOverlays），位图页跳过
      } else if (ln.kind === 'rich') {
        // 富文本行：位图页只画文字 run（b/c 段按粗体/等宽字体），栅格化原子由页级 PNG 叠画
        ctx.fillStyle = ln.gray ? '#555555' : '#111111';
        ctx.textBaseline = 'alphabetic';
        let x = ln.align === 'center' ? (pw - ln.width) / 2
          : ln.align === 'right' ? pw - margin - ln.width
            : margin + ln.indent;
        for (const run of ln.runs) {
          if (run.t !== 'm') {
            ctx.font = tpFontDraw(ln.size, !!run.bold, false, !!run.mono);
            ctx.fillText(run.v, x, ln.y);
          }
          x += run.w;
        }
      } else {
        const weight = ln.bold ? 700 : 400;
        ctx.font = tpFontDraw(ln.size, ln.bold, false, ln.mono);
        ctx.fillStyle = ln.gray ? '#555555' : '#111111';
        ctx.textBaseline = 'alphabetic';
        let x = margin + ln.indent;
        if (ln.align === 'center') {
          const w = ctx.measureText(ln.text).width;
          x = (pw - w) / 2;
        } else if (ln.align === 'right') {
          const w = ctx.measureText(ln.text).width;
          x = pw - margin - w;
        }
        if (ln.code) {
          const w = ctx.measureText(ln.text).width;
          ctx.fillStyle = '#f3f4f6';
          ctx.fillRect(x - 4, ln.y - ln.size * 1.05, Math.min(w + 8, maxW), ln.size * 1.45);
          ctx.fillStyle = '#111111';
        }
        ctx.fillText(ln.text, x, ln.y);
      }
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = out.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    // 图形/公式 PNG 以矢量坐标叠画到 PDF 页上（布局 y 自页顶向下，PDF y 自页底向上）
    for (const ln of pageLayouts[pi]) {
      if (ln.kind === 'img') {
        const png = await embedPng(ln.b64);
        page.drawImage(png, { x: ln.x, y: ph - ln.y - ln.h, width: ln.w, height: ln.h });
        continue;
      }
      if (ln.kind !== 'rich') continue;
      let x = ln.align === 'center' ? (pw - ln.width) / 2
        : ln.align === 'right' ? pw - margin - ln.width
          : margin + ln.indent;
      for (const run of ln.runs) {
        if (run.t === 'm') {
          const png = await embedPng(run.b64);
          page.drawImage(png, { x, y: ph - (ln.y - run.baselinePt) - run.hPt, width: run.w, height: run.hPt });
        }
        x += run.w;
      }
    }
    progress({ done: pi + 1, total: pageLayouts.length, stage: `渲染第 ${pi + 1} 页` });
  }
  if (title) { try { out.setTitle(title); } catch { /* noop */ } }
  const bytes = await out.save({ useObjectStreams: true });
  const outName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  return { artifacts: [{ name: outName, mime: 'application/pdf', bytes }], summary: { pages: pageLayouts.length, mode: 'raster-fallback' } };
}

// ---------------------------------------------------------------------------
// PDF → 其他格式（文本级）
// ---------------------------------------------------------------------------

/** 提取带字号信息的行（供 Office 导出做标题启发式） */
async function richLinesOf(e, list) {
  const doc = await pdfjsOpen(e);
  const raw = [];
  const allSizes = [];
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const p = list[i];
    const page = await doc.getPage(p + 1);
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str !== undefined && it.str.trim());
    const rows = new Map();
    for (const it of items) {
      const y = Math.round(it.transform[5] / 2) * 2;
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], str: it.str, size, bold: /bold/i.test(it.fontName || '') });
      allSizes.push(size);
    }
    const sorted = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    raw.push(sorted.map(([, arr]) => {
      arr.sort((a, b) => a.x - b.x);
      return {
        text: arr.map((i2) => i2.str).join('').replace(/\s+$/, ''),
        size: Math.max(...arr.map((i2) => i2.size)),
        bold: arr.some((i2) => i2.bold),
      };
    }).filter((l) => l.text));
    progress({ done: i + 1, total: list.length, stage: `解析第 ${p + 1} 页` });
  }
  // 中位数字号 → 标题启发式
  allSizes.sort((a, b) => a - b);
  const median = allSizes[Math.floor(allSizes.length / 2)] || 10;
  const result = raw.map((lines) => ({
    lines: lines.map((l) => {
      let heading = 0;
      const ratio = l.size / median;
      if (ratio >= 1.85) heading = 1;
      else if (ratio >= 1.45) heading = 2;
      else if (ratio >= 1.2 && l.text.length < 60) heading = 3;
      return { text: l.text, size: Math.round(l.size * 10) / 10, heading, bold: l.bold };
    }),
  }));
  return result;
}

handlers['pdf.exportOffice'] = async ({ docId, pages = 'all', format = 'docx', title = '' }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const pagesData = await richLinesOf(e, list);
  const built = buildOffice(format, pagesData, { title: title || e.name.replace(/\.pdf$/i, '') });
  const base = e.name.replace(/\.pdf$/i, '');
  return {
    artifacts: [{ name: `${base}.${built.ext}`, mime: built.mime, bytes: built.bytes }],
    // lines：提取到的总行数（0 = 无文本层/扫描件，工具层据此降级图片型或给出 OCR 引导）
    summary: { format, pages: list.length, lines: pagesData.reduce((s, p) => s + p.lines.length, 0) },
  };
};

handlers['pdf.toTiff'] = async ({ docId, pages = 'all', dpi = 150, gray = false }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const imgs = [];
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const p = list[i];
    const r = await renderPageBitmap(e, p, { dpi, gray, bg: '#ffffff', maxPixels: LIMITS.maxRenderPixels });
    const canvas = new OffscreenCanvas(r.width, r.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (gray) {
      const g = new Uint8Array(canvas.width * canvas.height);
      for (let k = 0; k < g.length; k++) {
        g[k] = (d.data[k * 4] * 299 + d.data[k * 4 + 1] * 587 + d.data[k * 4 + 2] * 114) / 1000 | 0;
      }
      imgs.push({ data: g, w: canvas.width, h: canvas.height, gray: true });
    } else {
      imgs.push({ data: d.data, w: canvas.width, h: canvas.height });
    }
    progress({ done: i + 1, total: list.length, stage: `转换第 ${p + 1} 页` });
  }
  const bytes = encodeTiff(imgs);
  const base = e.name.replace(/\.pdf$/i, '');
  return {
    artifacts: [{ name: `${base}.tiff`, mime: 'image/tiff', bytes }],
    summary: { pages: list.length, dpi },
  };
};

handlers['pdf.toSvg'] = async ({ docId, pages = 'all', dpi = 150 }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const base = e.name.replace(/\.pdf$/i, '');
  const artifacts = [];
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const p = list[i];
    const r = await renderPageBitmap(e, p, { dpi, bg: '#ffffff', maxPixels: LIMITS.maxRenderPixels });
    const canvas = new OffscreenCanvas(r.width, r.height);
    canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const b64 = await blobToBase64(blob);
    const pm = e.pages[p];
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(pm.visualW)}" height="${Math.round(pm.visualH)}" viewBox="0 0 ${Math.round(pm.visualW)} ${Math.round(pm.visualH)}"><image width="${Math.round(pm.visualW)}" height="${Math.round(pm.visualH)}" xlink:href="${b64}"/></svg>`;
    artifacts.push({ name: `${base}_p${String(p + 1).padStart(3, '0')}.svg`, mime: 'image/svg+xml', bytes: new TextEncoder().encode(svg) });
    progress({ done: i + 1, total: list.length, stage: `转换第 ${p + 1} 页` });
  }
  return { artifacts, summary: { pages: list.length, dpi, note: '位图封装（非矢量追踪）' } };
};

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}
