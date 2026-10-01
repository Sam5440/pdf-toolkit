// 「更多」工具族的引擎操作（在 worker 内运行）。
// 与 engine-worker.js 为循环引用：仅函数体中访问其导出（ESM 活绑定，延迟到调用期解析）。
import * as pdfLib from 'pdf-lib';
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

// ---------------------------------------------------------------------------
// 页面操作
// ---------------------------------------------------------------------------

handlers['pages.rotate'] = async ({ docId, pages = 'all', angle = 90, mode = 'relative' }) => {
  const e = getDoc(docId);
  const list = rangePages(e, pages);
  const step = ((Number(angle) % 360) + 360) % 360;
  if (step % 90 !== 0) throw toolkitError('ERR_BAD_ARGS', '旋转角度需为 90 的倍数');
  const doc = e.pdfLibDoc;
  for (let i = 0; i < list.length; i++) {
    checkAbort();
    const page = doc.getPage(list[i]);
    const cur = ((page.getRotation().angle % 360) + 360) % 360;
    const next = mode === 'absolute' ? step : geometry.normalizeRotationStep(cur + step);
    page.setRotation(pdfLib.degrees(next));
    progress({ done: i + 1, total: list.length, stage: `旋转第 ${list[i] + 1} 页` });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytes(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '已旋转'), mime: 'application/pdf', bytes }], summary: { pages: list.length, angle: step } };
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
      let v;
      if (mode === 'margin') {
        const { left = 0, top = 0, right = 0, bottom = 0 } = values;
        v = { x: left, y: top, w: Math.max(1, pm.crop.width - left - right), h: Math.max(1, pm.crop.height - top - bottom) };
      } else if (mode === 'percent') {
        const pl = Math.min(49, Math.max(0, values.left ?? 0));
        const pt = Math.min(49, Math.max(0, values.top ?? 0));
        const pr = Math.min(49, Math.max(0, values.right ?? 0));
        const pb = Math.min(49, Math.max(0, values.bottom ?? 0));
        v = {
          x: pm.crop.width * pl / 100, y: pm.crop.height * pt / 100,
          w: pm.crop.width * (100 - pl - pr) / 100, h: pm.crop.height * (100 - pt - pb) / 100,
        };
      } else { // box：绝对视觉坐标
        v = { x: values.x ?? 0, y: values.y ?? 0, w: values.w ?? pm.crop.width, h: values.h ?? pm.crop.height };
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
// 文本 → PDF（生成/撰写/文本类导入共用的分页渲染器）
// ---------------------------------------------------------------------------

const TP_K = 2; // 渲染倍率（清晰度）

function tpFont(size, bold, italic, mono) {
  const fam = mono ? "'Courier New', monospace" : `'pdftoolkit-cjk', 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${Math.round(size * TP_K)}px ${fam}`;
}

/** blocks → 分页后的渲染任务（纯计算） */
function paginateBlocks(blocks, opts) {
  const { paper = 'a4', margin = 48, fontSize = 11 } = opts;
  const [pw0, ph0] = PAPERS[paper] || PAPERS.a4;
  const maxW = pw0 - margin * 2;
  const styleOf = (b) => {
    switch (b.type) {
      case 'h1': return { size: fontSize * 2.0, bold: true, before: fontSize * 1.2, after: fontSize * 0.6, lh: 1.3 };
      case 'h2': return { size: fontSize * 1.55, bold: true, before: fontSize * 1.0, after: fontSize * 0.5, lh: 1.3 };
      case 'h3': return { size: fontSize * 1.25, bold: true, before: fontSize * 0.8, after: fontSize * 0.4, lh: 1.35 };
      case 'li': return { size: fontSize, bold: false, indent: fontSize * 1.8, before: 2, after: 2, lh: 1.55 };
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
      lines.push({ table: b.rows || [], before: 6, after: 6, fontSize });
      continue;
    }
    const st = styleOf(b);
    const text = String(b.text ?? '');
    const paras = text.split('\n');
    for (const para of paras) {
      lines.push({ para, st, type: b.type, align: b.align || (b.type === 'li' ? 'left' : 'left'), marker: b.type === 'li' ? (b.marker || '•') : null });
    }
  }
  return { lines, pw: pw0, ph: ph0, maxW, margin };
}

handlers['text.toPdf'] = async ({ name = '文档', blocks = [], paper = 'a4', margin = 48, fontSize = 11, title = '' }) => {
  if (!blocks.length) throw toolkitError('ERR_NO_INPUT', '内容为空');
  await ensureWorkerCJKFont();
  const { lines, pw, ph, maxW } = paginateBlocks(blocks, { paper, margin, fontSize });
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
      // 表格：等比列宽，逐行绘制
      const rows = item.table.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')]));
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
          ctx.font = tpFont(fontSize * 0.95, ln.header, false, false);
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(ln.cells[ci].text, x + margin + 5, ln.yTop + ln.h - 6);
          x += ln.widths[ci];
        }
      } else {
        const weight = ln.bold ? 700 : 400;
        ctx.font = tpFont(ln.size, ln.bold, false, ln.mono);
        ctx.fillStyle = ln.gray ? '#555555' : '#111111';
        ctx.textBaseline = 'alphabetic';
        let x = margin + ln.indent;
        if (ln.align === 'center') {
          const w = ctx.measureText(ln.text).width / TP_K;
          x = (pw - w) / 2;
        } else if (ln.align === 'right') {
          const w = ctx.measureText(ln.text).width / TP_K;
          x = pw - margin - w;
        }
        if (ln.code) {
          const w = ctx.measureText(ln.text).width / TP_K;
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
    progress({ done: pi + 1, total: pageLayouts.length, stage: `渲染第 ${pi + 1} 页` });
  }
  if (title) { try { out.setTitle(title); } catch { /* noop */ } }
  const bytes = await out.save({ useObjectStreams: true });
  const outName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  return { artifacts: [{ name: outName, mime: 'application/pdf', bytes }], summary: { pages: pageLayouts.length } };
};

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
    summary: { format, pages: list.length },
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
