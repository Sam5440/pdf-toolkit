// 引擎 Worker：全部 PDF 处理在此执行（文件字节不离开浏览器）。
// 协议：主线程 {id, op, args}；worker → {type:'progress'|'result', id, ...}
// 引擎组合：pdf-lib（结构/绘制）+ pdf.js（渲染/文本）+ mupdf WASM（加密/解密）。
import * as pdfLib from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inflate } from 'fflate';

import * as geometry from './geometry.js';
import { parsePageRange, splitGroups } from './pagerange.js';
import {
  sanitizeLayer, resolveLayerPages, applyTemplateVars, tileLayout, fullscreenLayout,
  hexToRgb01,
} from './watermark-model.js';
import { ssimGray, grayFromImageData } from './ssim.js';
import { pageTextDiffs } from './textdiff.js';
import { planCandidates, refineCandidates, candidateId, pickBest } from './compress-planner.js';
import { toolkitError, ERR } from './errors.js';
import { fmtMB } from './format.js';
import { handlers as moreHandlers } from './engine-more.js';

const BASE = import.meta.env.BASE_URL || '/';
let ASSET_BASE = null; // 主线程通过 limits.assetBase 传入（worker 内相对路径会相对 /assets/ 解析，不可靠）

function assetBase() {
  if (ASSET_BASE) return ASSET_BASE;
  // 回退：worker 脚本位于 <base>assets/worker.js → 去掉 assets/ 段
  const href = self.location.href;
  const m = /^(.*\/)assets\/[^/]*$/.exec(href);
  return m ? m[1] : BASE;
}

let pdfjs = null;
// 懒加载引擎状态上报 → 主线程转发至 wasm-registry（设置面板「引擎状态」展示）
function notifyEngine(engine, status, detail) {
  self.postMessage({ type: 'engine-status', engine, status, detail });
}

async function getPdfjs() {
  if (!pdfjs) {
    notifyEngine('pdfjs', 'loading');
    try {
      pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch (err) {
      notifyEngine('pdfjs', 'error', err?.message || String(err));
      throw err;
    }
    notifyEngine('pdfjs', 'ready', `v${pdfjs.version || '?'}`);
  }
  return pdfjs;
}

// Worker 里没有 document，pdf.js 默认的 DOMCanvasFactory / DOMFilterFactory 在
// 图像缩放、蒙版、透明组合等渲染路径会崩溃（无 document.createElement）。
// 对齐 pdf.js 无 DOM 环境的官方做法：canvas 用 OffscreenCanvas 创建，
// 滤镜工厂降级为 no-op（仅影响极少数带传递函数的蒙版）。
class OffscreenCanvasFactory {
  // pdf.js 会传 { ownerDocument, enableHWA }，这里无 DOM 依赖故忽略
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset({ canvas }, width, height) {
    if (!canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    canvas.width = width;
    canvas.height = height;
  }
  destroy(canvasAndContext) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

class NoDomFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  destroy() { /* noop */ }
}

let mupdfMod = null;
async function getMupdf() {
  if (!mupdfMod) {
    notifyEngine('mupdf', 'loading');
    try {
      mupdfMod = await import('mupdf');
    } catch (err) {
      notifyEngine('mupdf', 'error', err?.message || String(err));
      throw err;
    }
    notifyEngine('mupdf', 'ready');
  }
  return mupdfMod;
}

// ---------------------------------------------------------------------------
// 文档注册表（worker 内）
// ---------------------------------------------------------------------------

const docs = new Map(); // docId → entry
export let LIMITS = { maxDocsBytes: 1.2e9 };
let docLru = [];

function touchLru(id) {
  const i = docLru.indexOf(id);
  if (i >= 0) docLru.splice(i, 1);
  docLru.push(id);
}

function evictDocs() {
  let total = 0;
  for (const e of docs.values()) total += e.bytes.byteLength;
  while (total > LIMITS.maxDocsBytes && docLru.length > 1) {
    const victim = docLru[0];
    const e = docs.get(victim);
    if (!e) { docLru.shift(); continue; }
    total -= e.bytes.byteLength;
    try { e.pdfjsDoc?.destroy?.(); } catch { /* noop */ }
    docs.delete(victim);
    docLru.shift();
  }
}

export function getDoc(docId) {
  const e = docs.get(docId);
  if (!e) throw toolkitError('ERR_NO_INPUT', '文档未加载或已被释放（引擎内）');
  touchLru(docId);
  return e;
}

export function pdfLibLoad(bytes) {
  return pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
}

/** 打开并解析页面信息；加密文件尝试空密码解锁 */
async function openDocEntry(docId, name, bytes) {
  const entry = { docId, name, bytes, pdfLibDoc: null, pdfjsDoc: null, pages: [], encrypted: false, needsPassword: false, meta: {}, warnings: [] };
  let lib;
  try {
    lib = await pdfLibLoad(bytes);
  } catch {
    throw toolkitError('ERR_BAD_PDF');
  }
  if (lib.isEncrypted) {
    entry.encrypted = true;
    const m = await getMupdf();
    let md;
    try {
      md = m.PDFDocument.openDocument(new Uint8Array(bytes.slice()), 'application/pdf');
    } catch {
      entry.needsPassword = true;
      docs.set(docId, entry); touchLru(docId); evictDocs();
      return entry;
    }
    if (md.needsPassword()) {
      const okEmpty = md.authenticatePassword('');
      if (okEmpty > 0) {
        const dec = md.saveToBuffer('decrypt=yes,garbage=2').asUint8Array();
        entry.bytes = dec;
        entry.warnings.push('原文件已加密（空密码），已自动解锁为工作副本');
        entry.encrypted = false;
        lib = await pdfLibLoad(dec);
      } else {
        entry.needsPassword = true;
        docs.set(docId, entry); touchLru(docId); evictDocs();
        return entry;
      }
    } else {
      const dec = md.saveToBuffer('decrypt=yes,garbage=2').asUint8Array();
      entry.bytes = dec;
      entry.encrypted = false;
      lib = await pdfLibLoad(dec);
    }
  }
  entry.pdfLibDoc = lib;
  entry.pages = lib.getPages().map((p, i) => pageMeta(lib, p, i));
  try {
    entry.meta.title = lib.getTitle() || '';
    entry.meta.author = lib.getAuthor() || '';
  } catch { /* noop */ }
  docs.set(docId, entry);
  touchLru(docId);
  evictDocs();
  return entry;
}

export function pageMeta(_lib, p, i) {
  const size = p.getSize();
  const rot = ((p.getRotation().angle % 360) + 360) % 360;
  // 盒形状必须为 {x,y,width,height}：geometry.normBox 只认该形状或 {x0,y0,x1,y1}，
  // 传 {w,h} 会得到 NaN（曾致 wm.apply/wm.preview 平铺静默画空）
  let crop;
  try {
    const cb = p.getCropBox();
    crop = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
  } catch {
    crop = { x: 0, y: 0, width: size.width, height: size.height };
  }
  let media;
  try {
    const mb = p.getMediaBox();
    media = { x: mb.x, y: mb.y, width: mb.width, height: mb.height };
  } catch {
    media = { x: 0, y: 0, width: size.width, height: size.height };
  }
  const vis = geometry.visualSize(crop, rot);
  return { index: i, w: size.width, h: size.height, media, rot, crop, visualW: vis.w, visualH: vis.h };
}

export function pageMetaOf(entry, pageNo) {
  const pages = entry.pdfLibDoc.getPages();
  if (pageNo < 0 || pageNo >= pages.length) throw toolkitError('ERR_RANGE', `页 ${pageNo + 1} 不存在`);
  return pageMeta(entry.pdfLibDoc, pages[pageNo], pageNo);
}

/** pdf.js 打开（渲染/文本用） */
export async function pdfjsOpen(entry) {
  if (entry.pdfjsDoc) { touchLru(entry.docId); return entry.pdfjsDoc; }
  if (entry.needsPassword) throw toolkitError('ERR_ENCRYPTED');
  const pjs = await getPdfjs();
  const task = pjs.getDocument({
    data: entry.bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
    // 资源由 pdf.worker 侧自行 fetch：API 侧的 DOMBinaryDataFactory 走
    // fetchData(url, document.baseURI)，worker 内无 document 会 ReferenceError，
    // 中文 CID 字体的 CMap 因此加载失败 → 文字被整体丢弃（预览中文空白）。
    useWorkerFetch: true,
    // 中文 PDF 常用未嵌入的 CID 字体；wasm 为 JBIG2/JPX 图像与 ICC 色彩解码
    cMapUrl: `${assetBase()}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase()}pdfjs/standard_fonts/`,
    wasmUrl: `${assetBase()}pdfjs/wasm/`,
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoDomFilterFactory,
  });
  entry.pdfjsDoc = await task.promise;
  touchLru(entry.docId);
  return entry.pdfjsDoc;
}

// ---------------------------------------------------------------------------
// 渲染（pdf.js + OffscreenCanvas → ImageBitmap）
// ---------------------------------------------------------------------------

export async function renderPageBitmap(entry, pageNo, { dpi = 110, gray = false, bg = null, maxPixels = 4096 * 4096 } = {}) {
  const pjs = await getPdfjs();
  const doc = await pdfjsOpen(entry);
  const page = await doc.getPage(pageNo + 1);
  let scale = dpi / 72;
  const vp0 = page.getViewport({ scale: 1 });
  const px = (vp0.width * scale) * (vp0.height * scale);
  if (px > maxPixels) scale *= Math.sqrt(maxPixels / px);
  const vp = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
  const ctx = canvas.getContext('2d', { alpha: !bg, willReadFrequently: true });
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  await page.render({
    canvasContext: ctx,
    viewport: vp,
    background: bg || undefined,
    intent: 'print',
  }).promise;
  if (gray) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
  }
  const bitmap = canvas.transferToImageBitmap();
  return { bitmap, width: canvas.width, height: canvas.height, visualW: vp0.width, visualH: vp0.height, scale };
}

// ---------------------------------------------------------------------------
// 内容绘制 helpers
// ---------------------------------------------------------------------------

async function resolveFont(doc, fontId, bold, text) {
  if (fontId === 'auto' || !fontId) {
    const needsCJK = /[\u3400-\u4DBF\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(text || '');
    fontId = needsCJK ? 'noto-sc' : 'helvetica';
  }
  if (fontId === 'helvetica') return doc.embedFont(pdfLib.StandardFonts.Helvetica);
  if (fontId === 'times') return doc.embedFont(bold ? pdfLib.StandardFonts.TimesRomanBold : pdfLib.StandardFonts.TimesRoman);
  if (fontId === 'courier') return doc.embedFont(pdfLib.StandardFonts.Courier);
  // CJK：从主线程传入字体（fonts.js 取好）或 fetch public 资产
  const bytes = await fetchFontBytes(fontId, bold);
  doc.registerFontkit(fontkit);
  return doc.embedFont(bytes, { subset: true });
}

let fontBytesCache = new Map();
async function fetchFontBytes(fontId, bold) {
  const key = `${fontId}:${bold ? 'b' : 'r'}`;
  if (fontBytesCache.has(key)) return fontBytesCache.get(key);
  const url = `${assetBase()}fonts/${fontId === 'noto-sc' ? 'NotoSansSC' : fontId}-${bold ? 'Bold' : 'Regular'}.ttf`;
  let resp;
  try { resp = await fetch(url); } catch { throw toolkitError('ERR_FONT', '字体文件获取失败'); }
  if (!resp.ok) throw toolkitError('ERR_FONT', `字体文件缺失（${url}），请确认部署包含 public/fonts`);
  const buf = await resp.arrayBuffer();
  fontBytesCache.set(key, buf);
  return buf;
}

/**
 * 在页面上绘制文字水印层（over：直接追加；返回不变）
 * @returns 绘制后的尺寸信息
 */
function drawTextLayerDirect(page, font, lines, opts) {
  // opts: {cx, cy (user space block center), fontSize, color01, opacity, angleUser, align, lineHeight}
  const { fontSize, color01, opacity, angleUser, align } = opts;
  const rad = (angleUser * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const lh = fontSize * 1.3;
  const widthOf = (s) => { try { return font.widthOfTextAtSize(s, fontSize); } catch { return s.length * fontSize * 0.6; } };
  const maxW = Math.max(...lines.map(widthOf));
  const n = lines.length;
  const color = pdfLib.rgb(color01.r, color01.g, color01.b);
  lines.forEach((line, i) => {
    // 行 i 相对块中心的视觉偏移（y 向下为正）
    const offVx = align === 'left' ? -(maxW / 2 - widthOf(line) / 2)
      : align === 'right' ? (maxW / 2 - widthOf(line) / 2) : 0;
    const offVy = ((i - (n - 1) / 2)) * lh;
    const vec = geometry.visualVecToUser(offVx, offVy, opts.pageRotation);
    // 绘制点：用户空间；drawText 的坐标为文本左基线，旋转围绕该点
    const ux = opts.cx + vec.dx, uy = opts.cy + vec.dy;
    const w = widthOf(line);
    // 基线相对行中心下移约 0.35em（视觉），换算到用户向量
    const baseVec = geometry.visualVecToUser(-w / 2, fontSize * 0.36, opts.pageRotation);
    page.drawText(line, {
      x: ux + baseVec.dx, y: uy + baseVec.dy,
      size: fontSize, font, color,
      opacity,
      rotate: pdfLib.degrees(angleUser),
    });
  });
  return { width: maxW, height: n * lh };
}

function drawImageOnPage(page, img, { cx, cy, drawW, drawH, opacity, angleUser }) {
  page.drawImage(img, {
    x: cx - drawW / 2, y: cy - drawH / 2,
    width: drawW, height: drawH,
    opacity,
    rotate: pdfLib.degrees(angleUser),
  });
}

// --- CJK 文字栅格化（worker 侧，供页面编辑 page.addContent 用）：
// pdf-lib subset:true 对大型 CJK 字体产出损坏字形；Canvas→PNG→drawImage 体积小且字形正确 ---

const W_RASTER_SCALE = 3;
let workerCjkFontPromise = null;
const wRasterCache = new Map(); // key → { bytes, wPt, hPt }

export async function ensureWorkerCJKFont() {
  if (!workerCjkFontPromise) {
    workerCjkFontPromise = (async () => {
      try {
        const bytes = await fetchFontBytes('noto-sc', false);
        const face = new FontFace('pdftoolkit-cjk', bytes);
        await face.load();
        self.fonts.add(face);
        return true;
      } catch {
        return false; // 字体缺失时回退系统字体（OffscreenCanvas 仍可渲染）
      }
    })();
  }
  return workerCjkFontPromise;
}

export function workerFontSpec(fontSizePt, bold) {
  return `${bold ? 700 : 400} ${fontSizePt * W_RASTER_SCALE}px 'pdftoolkit-cjk', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
}

async function workerRasterLinePng(text, { fontSize, bold, color01 }) {
  const key = `${text}|${fontSize}|${bold ? 'b' : 'r'}|${color01.r},${color01.g},${color01.b}`;
  if (wRasterCache.has(key)) return wRasterCache.get(key);
  await ensureWorkerCJKFont();
  const K = W_RASTER_SCALE;
  const probe = new OffscreenCanvas(8, 8);
  const pctx = probe.getContext('2d');
  pctx.font = workerFontSpec(fontSize, bold);
  const m = pctx.measureText(text);
  const ascent = Math.ceil(m.actualBoundingBoxAscent || fontSize * K * 0.8) + 2;
  const descent = Math.ceil(m.actualBoundingBoxDescent || fontSize * K * 0.25) + 2;
  const w = Math.max(4, Math.ceil(m.width) + 4);
  const h = ascent + descent;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.font = workerFontSpec(fontSize, bold);
  ctx.fillStyle = `rgb(${Math.round(color01.r * 255)},${Math.round(color01.g * 255)},${Math.round(color01.b * 255)})`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 2, ascent);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const entry = { bytes: new Uint8Array(await blob.arrayBuffer()), wPt: w / K, hPt: h / K, key };
  wRasterCache.set(key, entry);
  if (wRasterCache.size > 300) wRasterCache.delete(wRasterCache.keys().next().value);
  return entry;
}

export async function drawTextRaster(page, doc, lines, { cx, cy, fontSize, color01, opacity, angleUser, align }) {
  const widthOf = async (s) => {
    const e = await workerRasterLinePng(s, { fontSize, bold: false, color01 });
    return e.wPt;
  };
  const widths = [];
  for (const s of lines) widths.push(await widthOf(s));
  const maxW = Math.max(...widths, 4);
  const lh = fontSize * 1.3;
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (!line) continue;
    const offVx = align === 'left' ? -(maxW / 2 - widths[i] / 2)
      : align === 'right' ? (maxW / 2 - widths[i] / 2) : 0;
    // worker 侧无页面旋转上下文转换：行偏移按未旋转页面近似（编辑对象 rotation 常为 0）
    const ux = cx + offVx, uy = cy + (i - (n - 1) / 2) * lh;
    const entry = await workerRasterLinePng(line, { fontSize, bold: false, color01 });
    const img = await doc.embedPng(entry.bytes);
    const rad = (angleUser * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const ax = ux - (entry.wPt / 2) * cos + (entry.hPt / 2) * sin;
    const ay = uy - (entry.wPt / 2) * sin - (entry.hPt / 2) * cos;
    page.drawImage(img, { x: ax, y: ay, width: entry.wPt, height: entry.hPt, opacity, rotate: pdfLib.degrees(angleUser) });
  }
}

/** 计算 tile 位置（视觉）→ 用户中心坐标数组 */
function tilePositions(layer, visW, visH, cellW, cellH) {
  if (layer.placement === 'single') {
    const a = anchorPoint(layer.anchor, visW, visH);
    return [{ vx: a.vx + layer.offsetX, vy: a.vy + layer.offsetY }];
  }
  if (layer.placement === 'diagonal') {
    return [{ vx: visW / 2 + layer.offsetX, vy: visH / 2 + layer.offsetY }];
  }
  if (layer.placement === 'fullscreen') {
    // 全屏高密度平铺：均匀格子 + 四周出血一圈，旋转后仍覆盖页角（含 offsetX/Y 微调）
    const pos = fullscreenLayout({
      vw: visW, vh: visH, density: layer.density, stagger: layer.stagger,
      offsetX: layer.offsetX, offsetY: layer.offsetY,
    });
    return pos.map((p) => ({ vx: p.cx, vy: p.cy }));
  }
  const pos = tileLayout({
    vw: visW, vh: visH, cellW, cellH,
    spacingX: layer.tileSpacingX, spacingY: layer.tileSpacingY,
    stagger: layer.stagger, marginX: layer.marginX, marginY: layer.marginY,
  });
  return pos.map((p) => ({ vx: p.cx + layer.offsetX, vy: p.cy + layer.offsetY }));
}

// --- under 层：Form XObject 前置方案 ---

function pageResourcesDict(doc, page) {
  const node = page.node;
  let res = node.get(pdfLib.PDFName.of('Resources'));
  if (!res) {
    const d = doc.context.obj({});
    node.set(pdfLib.PDFName.of('Resources'), d);
    return d;
  }
  if (res instanceof pdfLib.PDFRef) {
    const looked = doc.context.lookup(res);
    if (looked) return looked;
    const d = doc.context.obj({});
    node.set(pdfLib.PDFName.of('Resources'), d);
    return d;
  }
  return res;
}

function ensureDict(parentDict, key) {
  const k = pdfLib.PDFName.of(key);
  let v = parentDict.get(k);
  if (v instanceof pdfLib.PDFRef) {
    const l = parentDict.context.lookup(v);
    if (l instanceof pdfLib.PDFDict) return l;
  }
  if (v instanceof pdfLib.PDFDict) return v;
  const d = parentDict.context.obj({});
  parentDict.set(k, d);
  return d;
}

function uniqueXObjectKey(resDict) {
  const xo = ensureDict(resDict, 'XObject');
  let i = 0;
  while (xo.has(pdfLib.PDFName.of(`WMX${i}`))) i++;
  return `WMX${i}`;
}

/**
 * 将 draw 回调画出的临时页内容作为 Form XObject 前置到目标页（背景水印）。
 * drawFn(tempPage) 应在 tempPage（与目标页同 MediaBox、rotation 0）上绘制。
 */
async function prependAsFormXObject(doc, page, drawFn, mediaBox) {
  const tmp = await pdfLib.PDFDocument.create();
  const tp = tmp.addPage([mediaBox.w, mediaBox.h]);
  tp.node.set(pdfLib.PDFName.of('MediaBox'), doc.context.obj([mediaBox.x0, mediaBox.y0, mediaBox.x1, mediaBox.y1]));
  await drawFn(tmp, tp);
  const tmpBytes = await tmp.save({ useObjectStreams: false });
  const tmpLoad = await pdfLib.PDFDocument.load(tmpBytes, { ignoreEncryption: true });
  const [copied] = await doc.copyPages(tmpLoad, [0]);
  // copied 已在 doc context 中；取其内容与资源
  const node = copied.node;
  const contents = node.get(pdfLib.PDFName.of('Contents'));
  const streamRefs = [];
  if (contents instanceof pdfLib.PDFRef) streamRefs.push(contents);
  else if (contents instanceof pdfLib.PDFArray) {
    for (let i = 0; i < contents.size(); i++) streamRefs.push(contents.get(i));
  }
  if (!streamRefs.length) return;
  // 资源字典（copied 的，含字体映射）
  const cRes = node.get(pdfLib.PDFName.of('Resources'));
  let cResRef = cRes instanceof pdfLib.PDFRef ? cRes : doc.context.register(cRes);
  // 包装为 Form XObject（必须继承内容流的 Filter，否则压缩数据会被当作原文损坏）
  const contentObj = doc.context.lookup(streamRefs[0]);
  const media = page.node.MediaBox();
  const formDictProps = {
    Type: 'XObject', Subtype: 'Form',
    BBox: [media.get(0), media.get(1), media.get(2), media.get(3)],
    Resources: cResRef,
  };
  const srcDict = contentObj.dict;
  for (const key of ['Filter', 'DecodeParms', 'Length']) {
    const v = srcDict.get(pdfLib.PDFName.of(key));
    if (v) formDictProps[key] = v;
  }
  const formDict = doc.context.obj(formDictProps);
  const formRef = doc.context.register(pdfLib.PDFRawStream.of(formDict, contentObj.getContents()));
  // 目标页资源挂 XObject
  const res = pageResourcesDict(doc, page);
  const key = uniqueXObjectKey(res);
  ensureDict(res, 'XObject').set(pdfLib.PDFName.of(key), formRef);
  // 前置一个小流：q /Key Do Q
  const ops = new TextEncoder().encode(`q\n/${key} Do\nQ\n`);
  const opsRef = doc.context.register(pdfLib.PDFRawStream.of(doc.context.obj({}), ops));
  const existing = node_Contents(page);
  page.node.set(pdfLib.PDFName.of('Contents'), doc.context.obj([opsRef, ...existing]));
}

function node_Contents(page) {
  const c = page.node.get(pdfLib.PDFName.of('Contents'));
  const out = [];
  if (c instanceof pdfLib.PDFRef) out.push(c);
  else if (c instanceof pdfLib.PDFArray) for (let i = 0; i < c.size(); i++) out.push(c.get(i));
  return out;
}

// ---------------------------------------------------------------------------
// op handlers
// ---------------------------------------------------------------------------

const handlers = {};

// 引擎预热探测（设置面板「引擎状态」按需加载）：只触发懒加载，不碰文档
handlers['engine.warm'] = async ({ engine }) => {
  if (engine === 'pdfjs') {
    await getPdfjs();
    return { ok: true };
  }
  if (engine === 'mupdf') {
    await getMupdf();
    return { ok: true };
  }
  if (engine === 'tesseract') {
    await getTessWorker('eng', () => {});
    return { ok: true };
  }
  throw toolkitError('ERR_BAD_ARGS', `未知引擎 ${engine}`);
};

Object.assign(handlers, moreHandlers);

handlers['doc.open'] = async ({ docId, name, bytes }) => {
  const e = await openDocEntry(docId, name, bytes);
  return {
    pageCount: e.needsPassword ? (e.pdfLibDoc ? e.pages.length : 0) : e.pages.length,
    pages: e.pages,
    encrypted: e.encrypted,
    needsPassword: e.needsPassword,
    meta: e.meta,
    warnings: e.warnings,
    size: e.bytes.byteLength,
  };
};

handlers['doc.unlock'] = async ({ docId, password }) => {
  const e = getDoc(docId);
  if (!e.encrypted && !e.needsPassword) return { ok: true, warnings: ['文件未加密'] };
  const m = await getMupdf();
  const md = m.PDFDocument.openDocument(new Uint8Array(e.bytes.slice()), 'application/pdf');
  const level = md.authenticatePassword(String(password ?? ''));
  if (!level) throw toolkitError('ERR_WRONG_PASSWORD');
  const dec = md.saveToBuffer('decrypt=yes,garbage=2').asUint8Array();
  const fresh = await openDocEntry(docId, e.name, dec);
  fresh.warnings.push('已解锁，后续处理基于解密副本');
  return {
    pageCount: fresh.pages.length, pages: fresh.pages,
    encrypted: false, needsPassword: false, meta: fresh.meta, warnings: fresh.warnings,
    size: fresh.bytes.byteLength,
  };
};

handlers['doc.close'] = ({ docId }) => {
  const e = docs.get(docId);
  if (e) { try { e.pdfjsDoc?.destroy?.(); } catch { /* noop */ } docs.delete(docId); }
  return { ok: true };
};

handlers['doc.render'] = async ({ docId, page, dpi = 110, gray = false, bg = null }) => {
  const e = getDoc(docId);
  const r = await renderPageBitmap(e, page, { dpi, gray, bg, maxPixels: LIMITS.maxRenderPixels });
  return { bitmap: r.bitmap, width: r.width, height: r.height, visualW: r.visualW, visualH: r.visualH };
};

handlers['pages.merge'] = async ({ items }) => {
  if (!items?.length) throw toolkitError('ERR_NO_INPUT', '请至少选择一个文件');
  const out = await pdfLib.PDFDocument.create();
  let total = 0;
  for (const item of items) {
    const e = getDoc(item.docId);
    const range = parsePageRange(item.pages ?? 'all', e.pages.length);
    if (!range.ok) throw toolkitError('ERR_RANGE', range.error);
    const idx = range.pages;
    const copied = await out.copyPages(e.pdfLibDoc, idx);
    for (const p of copied) out.addPage(p);
    total += idx.length;
    progress({ done: items.indexOf(item) + 1, total: items.length, stage: `合并 ${e.name}` });
  }
  if (!total) throw toolkitError('ERR_BAD_ARGS', '合并结果为空');
  const bytes = await out.save({ useObjectStreams: true });
  return {
    artifacts: [{ name: '合并.pdf', mime: 'application/pdf', bytes }],
    summary: { pages: total },
  };
};

handlers['pages.split'] = async ({ docId, mode, baseName = '拆分' }) => {
  const e = getDoc(docId);
  const groups = splitGroups(e.pages.length, mode);
  if (!groups.length) throw toolkitError('ERR_BAD_ARGS', '拆分结果为空');
  const artifacts = [];
  for (let gi = 0; gi < groups.length; gi++) {
    checkAbort();
    const g = groups[gi];
    const out = await pdfLib.PDFDocument.create();
    const copied = await out.copyPages(e.pdfLibDoc, g);
    for (const p of copied) out.addPage(p);
    const bytes = await out.save({ useObjectStreams: true });
    const label = g.length === 1 ? `第${g[0] + 1}页` : `第${g[0] + 1}-${g[g.length - 1] + 1}页`;
    artifacts.push({ name: `${baseName}_${label}.pdf`, mime: 'application/pdf', bytes });
    progress({ done: gi + 1, total: groups.length, stage: `拆分 ${gi + 1}/${groups.length}` });
  }
  return { artifacts, summary: { groups: groups.length, pages: e.pages.length } };
};

handlers['pages.organize'] = async ({ docId, plan }) => {
  if (!plan?.length) throw toolkitError('ERR_BAD_ARGS', '页面计划为空');
  const out = await pdfLib.PDFDocument.create();
  for (let i = 0; i < plan.length; i++) {
    checkAbort();
    const item = plan[i];
    if (item.blank) {
      out.addPage([item.blank.w || 595, item.blank.h || 842]);
      progress({ done: i + 1, total: plan.length, stage: '插入空白页' });
      continue;
    }
    const srcEntry = getDoc(item.srcDocId || docId);
    // 同一源页在计划中出现多次（复制页）时，每次都必须独立复制：
    // 一个 Page 对象不能出现在页面树两处（/Parent 唯一），且旋转/裁剪各自独立
    const srcPage = item.srcPage;
    if (srcPage == null || srcPage < 0 || srcPage >= srcEntry.pages.length) {
      throw toolkitError('ERR_RANGE', `计划第 ${i + 1} 项页码无效`);
    }
    const [page] = await out.copyPages(srcEntry.pdfLibDoc, [srcPage]);
    if (item.rotation != null) {
      const r = geometry.normalizeRotationStep(item.rotation);
      page.setRotation(pdfLib.degrees(r));
    }
    if (item.crop) {
      const pm = pageMetaOf(srcEntry, item.srcPage);
      // 裁剪输入为视觉坐标（相对当前可视区），限制在 MediaBox 内
      const p1 = geometry.visualToUser(item.crop.x, item.crop.y, pm.crop, pm.rot);
      const p2 = geometry.visualToUser(item.crop.x + item.crop.w, item.crop.y + item.crop.h, pm.crop, pm.rot);
      const mediaBox = { x0: pm.media.x, y0: pm.media.y, x1: pm.media.x + pm.media.w, y1: pm.media.y + pm.media.h };
      const clamped = geometry.clampCrop(
        { x0: Math.min(p1.x, p2.x), y0: Math.min(p1.y, p2.y), x1: Math.max(p1.x, p2.x), y1: Math.max(p1.y, p2.y) },
        mediaBox,
      );
      page.node.set(pdfLib.PDFName.of('CropBox'), out.context.obj([clamped.x0, clamped.y0, clamped.x1, clamped.y1]));
    }
    out.addPage(page);
    progress({ done: i + 1, total: plan.length, stage: `整理页面 ${i + 1}/${plan.length}` });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { artifacts: [{ name: '页面整理.pdf', mime: 'application/pdf', bytes }], summary: { pages: plan.length } };
};

// 产物命名：原名_suffix.pdf
export function withSuffix(name, suffix) {
  const base = String(name || '文档').replace(/\.pdf$/i, '');
  return `${base}_${suffix}.pdf`;
}

// 产物命名：原名_tail.pdf（tail 已含中缀，如 '加密.pdf' → '原名_加密.pdf'）
function replaceExt(name, tail) {
  const base = String(name || '文档').replace(/\.pdf$/i, '');
  return `${base}_${tail}`;
}


/** 原位修改型 op 保存后：把新字节同步回 worker 条目（供 addContent 等使用） */
function syncEntryBytesOf(e, doc, bytes) {
  e.bytes = bytes;
  try { e.pdfjsDoc?.destroy?.(); } catch { /* noop */ }
  e.pdfjsDoc = null;
  e.pages = doc.getPages().map((p, i) => pageMeta(doc, p, i));
}

/** 页面编辑：添加文字/图片/形状（视觉坐标） */
handlers['page.addContent'] = async ({ docId, edits }) => {
  const e = getDoc(docId);
  const doc = e.pdfLibDoc;
  for (let i = 0; i < edits.length; i++) {
    checkAbort();
    const edit = edits[i];
    const pm = pageMetaOf(e, edit.page);
    const page = doc.getPage(edit.page);
    for (const obj of edit.objects || []) {
      const rot = pm.rot;
      if (obj.type === 'text') {
        const lines = String(obj.text ?? '').split('\n');
        const c = geometry.visualToUser(obj.x + (obj.w || 0) / 2, obj.y + (obj.h || lines.length * obj.fontSize * 1.3) / 2, pm.crop, rot);
        const useRaster = obj.fontId === 'noto-sc'
          || ((obj.fontId === 'auto' || !obj.fontId) && /[\u3400-\u4DBF\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(obj.text ?? ''));
        if (useRaster) {
          await drawTextRaster(page, doc, lines, {
            cx: c.x, cy: c.y, fontSize: obj.fontSize || 14,
            color01: hexToRgb01(obj.color || '#111111'),
            opacity: obj.opacity ?? 1,
            angleUser: geometry.userAngleForVisual(obj.rotation || 0, rot),
            align: obj.align || 'left',
          });
        } else {
          const font = await resolveFont(doc, obj.fontId, obj.bold, obj.text);
          drawTextLayerDirect(page, font, lines, {
            cx: c.x, cy: c.y, fontSize: obj.fontSize || 14,
            color01: hexToRgb01(obj.color || '#111111'),
            opacity: obj.opacity ?? 1,
            angleUser: geometry.userAngleForVisual(obj.rotation || 0, rot),
            align: obj.align || 'left',
            pageRotation: rot,
          });
        }
      } else if (obj.type === 'image') {
        const img = await embedImageAny(doc, obj.bytes, obj.mime);
        const c = geometry.visualToUser(obj.x + obj.w / 2, obj.y + obj.h / 2, pm.crop, rot);
        drawImageOnPage(page, img, {
          cx: c.x, cy: c.y, drawW: obj.w, drawH: obj.h,
          opacity: obj.opacity ?? 1,
          angleUser: geometry.userAngleForVisual(obj.rotation || 0, rot),
        });
      } else if (obj.type === 'rect' || obj.type === 'highlight') {
        const c01 = hexToRgb01(obj.color || (obj.type === 'highlight' ? '#ffe066' : '#2563eb'));
        const p1 = geometry.visualToUser(obj.x, obj.y + obj.h, pm.crop, rot);
        const w = obj.w, h = obj.h;
        page.drawRectangle({
          x: p1.x, y: p1.y, width: w, height: h,
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
    progress({ done: i + 1, total: edits.length, stage: `编辑第 ${edit.page + 1} 页` });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  syncEntryBytesOf(e, doc, bytes);
  return { artifacts: [{ name: withSuffix(e.name, '已编辑'), mime: 'application/pdf', bytes }], summary: { edits: edits.length } };
};

// ---------------------------------------------------------------------------
// 水印 / 叠加
// ---------------------------------------------------------------------------

/**
 * 核心：将水印层集合绘制到 doc 的指定页。over 与 under 共用此函数（预览=导出）。
 * @param {pdfLib.PDFDocument} doc
 * @param {Array} layers 已 sanitize 的层
 * @param {object} vars {docName, pageNo(0基)→渲染时已知}
 */
async function applyWatermarkToDoc(doc, entry, layers, vars, scopePages = null) {
  const pageCount = doc.getPageCount();
  for (let li = 0; li < layers.length; li++) {
    checkAbort();
    const layer = layers[li];
    let pageIdxs;
    if (scopePages) pageIdxs = scopePages;
    else {
      pageIdxs = resolveLayerPages(layer, pageCount);
    }
    const font = layer.type === 'text' ? await resolveFont(doc, layer.fontId, layer.bold, applyTemplateVars(layer.text, { ...vars, pageNo: 1, pageCount })) : null;
    for (const pageNo of pageIdxs) {
      if (pageNo >= pageCount) continue;
      checkAbort();
      const pm = pageMeta(doc, doc.getPage(pageNo), pageNo);
      const vtext = layer.type === 'text' ? applyTemplateVars(layer.text, {
        ...vars, pageNo: pageNo + 1, pageCount,
        date: vars.date, time: vars.time, docName: vars.docName,
      }) : '';
      const lines = vtext.split('\n');
      // 计算单元尺寸（视觉）
      let cellW, cellH;
      if (layer.type === 'text') {
        const widthOf = (s) => { try { return font.widthOfTextAtSize(s, layer.fontSize); } catch { return s.length * layer.fontSize * 0.6; } };
        cellW = Math.max(4, Math.max(...lines.map(widthOf)));
        cellH = lines.length * layer.fontSize * 1.3;
      } else {
        cellW = layer.imageScale * pm.visualW;
        cellH = cellW * (layer._imgH / layer._imgW);
      }
      if (layer.rotation % 180 !== 0) {
        // 旋转后包围盒近似（用于平铺间距）
        const rad = Math.abs(layer.rotation) * Math.PI / 180;
        const bw = cellW * Math.cos(rad) + cellH * Math.sin(rad);
        const bh = cellW * Math.sin(rad) + cellH * Math.cos(rad);
        cellW = bw; cellH = bh;
      }
      const positions = tilePositions(layer, pm.visualW, pm.visualH, cellW, cellH);
      const angleUser = geometry.userAngleForVisual(layer.rotation, pm.rot);
      const drawOn = (targetPage) => {
        for (const pos of positions) {
          const c = geometry.visualToUser(pos.vx, pos.vy, pm.crop, pm.rot);
          if (layer.type === 'text') {
            drawTextLayerDirect(targetPage, font, lines, {
              cx: c.x, cy: c.y, fontSize: layer.fontSize,
              color01: hexToRgb01(layer.color), opacity: layer.opacity,
              angleUser, align: layer.align, pageRotation: pm.rot,
            });
          } else {
            drawImageOnPage(targetPage, layer._img, {
              cx: c.x, cy: c.y, drawW: layer.imageScale * pm.visualW, drawH: layer.imageScale * pm.visualW * (layer._imgH / layer._imgW),
              opacity: layer.opacity, angleUser,
            });
          }
        }
      };
      if (layer.layerSide === 'under') {
        await prependAsFormXObject(doc, doc.getPage(pageNo), async (tmpDoc, tmpPage) => {
          drawOn(tmpPage);
        }, { x0: 0, y0: 0, w: pm.w, h: pm.h, x1: pm.w, y1: pm.h });
      } else {
        drawOn(doc.getPage(pageNo));
      }
      progress({ done: pageIdxs.indexOf(pageNo) + 1, total: pageIdxs.length, stage: `水印第 ${pageNo + 1} 页`, op: 'wm' });
    }
  }
}

handlers['wm.apply'] = async ({ docId, spec, vars = {} }) => {
  const e = getDoc(docId);
  // 图片层先解析
  const layers = [];
  for (const raw of spec.layers || []) {
    const l = sanitizeLayer(raw);
    if (l.type === 'image') {
      if (!raw.imageBytes) throw toolkitError('ERR_BAD_ARGS', '图片水印缺少图片数据');
      const img = await embedImageAny(e.pdfLibDoc, raw.imageBytes, raw.imageMime);
      l._img = img;
      l._imgW = img.width || 1; l._imgH = img.height || 1;
    }
    layers.push(l);
  }
  if (!layers.length) throw toolkitError('ERR_BAD_ARGS', '没有水印层');
  await applyWatermarkToDoc(e.pdfLibDoc, e, layers, {
    docName: vars.docName || e.name,
    date: vars.date || '', time: vars.time || '',
  });
  const bytes = await e.pdfLibDoc.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(e.name, '水印') }], summary: { layers: layers.length } };
};

/** 真实预览：复制单页 → 同一 apply 代码 → 渲染位图 */
handlers['wm.preview'] = async ({ docId, page, spec, vars = {}, dpi = 110 }) => {
  const e = getDoc(docId);
  const single = await pdfLib.PDFDocument.create();
  const [p] = await single.copyPages(e.pdfLibDoc, [page]);
  single.addPage(p);
  const layers = [];
  for (const raw of spec.layers || []) {
    const l = sanitizeLayer(raw);
    if (l.type === 'image' && raw.imageBytes) {
      const img = await embedImageAny(single, raw.imageBytes, raw.imageMime);
      l._img = img; l._imgW = img.width; l._imgH = img.height;
    }
    layers.push(l);
  }
  // scope=[page]：预览时所有层都画到这一页上（与导出同一 drawOn 代码路径）
  await applyWatermarkToDoc(single, e, layers, {
    docName: vars.docName || e.name, date: vars.date || '', time: vars.time || '',
  }, [0]);
  const bytes = await single.save({ useObjectStreams: false });
  const tmpEntry = { docId: `preview_${docId}_${page}`, name: e.name, bytes, pdfLibDoc: single, pages: single.getPages().map((pp, i) => pageMeta(single, pp, i)), encrypted: false, needsPassword: false };
  docs.set(tmpEntry.docId, tmpEntry); touchLru(tmpEntry.docId);
  try {
    const r = await renderPageBitmap(tmpEntry, 0, { dpi, maxPixels: LIMITS.maxRenderPixels });
    return { bitmap: r.bitmap, width: r.width, height: r.height, visualW: r.visualW, visualH: r.visualH };
  } finally {
    docs.delete(tmpEntry.docId);
  }
};

/** 叠加：base 页面上叠 overlay 页 */
handlers['overlay.apply'] = async ({ baseDocId, overlayDocId, mapping = { mode: 'oneToOne' }, options = {} }) => {
  const base = getDoc(baseDocId);
  const over = getDoc(overlayDocId);
  const scale = options.scale ?? 1;
  const opacity = Math.min(1, Math.max(0.01, options.opacity ?? 1));
  const under = !!options.under;
  const offX = options.offsetX ?? 0, offY = options.offsetY ?? 0;
  const baseCount = base.pdfLibDoc.getPageCount();
  const overCount = over.pdfLibDoc.getPageCount();
  const pairs = [];
  if (mapping.mode === 'oneToOne') {
    const n = Math.min(baseCount, overCount);
    for (let i = 0; i < n; i++) pairs.push({ base: i, over: i });
  } else if (mapping.mode === 'repeatFirst') {
    for (let i = 0; i < baseCount; i++) pairs.push({ base: i, over: 0 });
  } else if (mapping.mode === 'custom' && Array.isArray(mapping.custom)) {
    for (const p of mapping.custom) {
      if (p.base >= 0 && p.base < baseCount && p.over >= 0 && p.over < overCount) pairs.push(p);
    }
  }
  if (!pairs.length) throw toolkitError('ERR_BAD_ARGS', '没有有效的页面配对');
  for (let i = 0; i < pairs.length; i++) {
    checkAbort();
    const { base: bi, over: oi } = pairs[i];
    const bm = pageMeta(base.pdfLibDoc, base.pdfLibDoc.getPage(bi), bi);
    const om = pageMeta(over.pdfLibDoc, over.pdfLibDoc.getPage(oi), oi);
    const emb = await base.pdfLibDoc.embedPage(over.pdfLibDoc.getPage(oi));
    // 对齐：overlay 视觉尺寸缩放后，中心对 base 视觉中心 + 偏移
    const drawW = om.visualW * scale, drawH = om.visualH * scale;
    const cVis = { vx: bm.visualW / 2 + offX, vy: bm.visualH / 2 + offY };
    const c = geometry.visualToUser(cVis.vx, cVis.vy, bm.crop, bm.rot);
    // drawPage 的 x,y 为未旋转用户空间左下角；overlay 视觉与用户方向的差异在低 scale 下可接受，
    // 精确处理：按 base 页旋转换算绘制矩形左下角
    const p1 = geometry.visualToUser(cVis.vx - drawW / 2, cVis.vy - drawH / 2, bm.crop, bm.rot);
    const p3 = geometry.visualToUser(cVis.vx + drawW / 2, cVis.vy + drawH / 2, bm.crop, bm.rot);
    const x = Math.min(p1.x, p3.x), y = Math.min(p1.y, p3.y);
    await drawEmbeddedWithOpacity(base.pdfLibDoc, base.pdfLibDoc.getPage(bi), emb, {
      x, y, xScale: drawW / om.w, yScale: drawH / om.h, opacity, under,
    });
    progress({ done: i + 1, total: pairs.length, stage: `叠加第 ${bi + 1} 页` });
  }
  const bytes = await base.pdfLibDoc.save({ useObjectStreams: true });
  return { artifacts: [{ name: withSuffix(base.name, '叠加') }], summary: { pairs: pairs.length } };
};

/** pdf-lib drawPage 无透明度支持 —— 低级 ExtGState 包装（q /GS gs /Xo Do Q 或前置） */
async function drawEmbeddedWithOpacity(doc, page, embedded, { x, y, xScale, yScale, opacity, under }) {
  const gsDict = doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity, BM: 'Normal' });
  const gsRef = doc.context.register(gsDict);
  const xoName = `OVX${Math.floor(Math.random() * 1e9).toString(36)}`;
  const res = pageResourcesDict(doc, page);
  ensureDict(res, 'ExtGState').set(pdfLib.PDFName.of('OVGS'), gsRef);
  ensureDict(res, 'XObject').set(pdfLib.PDFName.of(xoName), embedded.ref);
  const opsU8 = new TextEncoder().encode(
    `q\n/OVGS gs\n${pdfNum(xScale)} 0 0 ${pdfNum(yScale)} ${pdfNum(x)} ${pdfNum(y)} cm\n/${xoName} Do\nQ\n`,
  );
  if (under) {
    const opsRef = doc.context.register(pdfLib.PDFRawStream.of(doc.context.obj({}), opsU8));
    const existing = node_Contents(page);
    page.node.set(pdfLib.PDFName.of('Contents'), doc.context.obj([opsRef, ...existing]));
  } else {
    const { PDFOperator } = pdfLib;
    page.pushOperators(
      PDFOperator.of('q'),
      PDFOperator.of('gs', pdfLib.PDFName.of('OVGS')),
      PDFOperator.of('cm', [
        pdfLib.PDFNumber.of(xScale), pdfLib.PDFNumber.of(0),
        pdfLib.PDFNumber.of(0), pdfLib.PDFNumber.of(yScale),
        pdfLib.PDFNumber.of(x), pdfLib.PDFNumber.of(y),
      ]),
      PDFOperator.of('Do', pdfLib.PDFName.of(xoName)),
      PDFOperator.of('Q'),
    );
  }
}

/** PDF 数字字面量（避免科学计数法） */
function pdfNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 1e6) / 1e6);
}

// ---------------------------------------------------------------------------
// 图像工具
// ---------------------------------------------------------------------------

async function embedImageAny(doc, bytes, mime) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const type = (mime || '').toLowerCase();
  const isJpg = type.includes('jpeg') || type.includes('jpg') || (u8[0] === 0xFF && u8[1] === 0xD8);
  const isPng = type.includes('png') || (u8[0] === 0x89 && u8[1] === 0x50);
  if (isJpg) { try { return await doc.embedJpg(u8); } catch { /* 走解码路径 */ } }
  if (isPng) { try { return await doc.embedPng(u8); } catch { /* 走解码路径 */ } }
  // 浏览器解码（webp/gif/bmp/avif/jpeg/png）→ 重编码
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([u8], { type: type || 'application/octet-stream' }), { imageOrientation: 'from-image' });
  } catch {
    throw toolkitError('ERR_UNSUPPORTED', '浏览器无法解码该图片格式（TIFF 等请先转换为 PNG/JPG）');
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  let outType = 'image/png';
  if (!hasAlpha(canvas, ctx)) outType = 'image/jpeg';
  const blob = await canvas.convertToBlob({ type: outType, quality: 0.92 });
  const outBytes = new Uint8Array(await blob.arrayBuffer());
  return outType === 'image/jpeg' ? doc.embedJpg(outBytes) : doc.embedPng(outBytes);
}

function hasAlpha(canvas, ctx) {
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

handlers['images.toPdf'] = async ({ images, paper = 'auto', orientation = 'auto', margin = 24, fit = 'contain', bg = null }) => {
  if (!images?.length) throw toolkitError('ERR_NO_INPUT', '请选择图片');
  const doc = await pdfLib.PDFDocument.create();
  for (let i = 0; i < images.length; i++) {
    checkAbort();
    const im = images[i];
    const bmp = await decodeImage(im.bytes, im.mime, im.name);
    const pxW = bmp.width, pxH = bmp.height;
    const imgW = pxW * 72 / 96, imgH = pxH * 72 / 96; // 图片按 96 DPI 换算的自然尺寸（pt）
    let pw, ph;
    if (paper === 'auto') {
      // 页面 = 图片尺寸：整页正好一张图，零留白
      pw = imgW; ph = imgH;
      if (orientation === 'landscape' && ph > pw) [pw, ph] = [ph, pw];
      if (orientation === 'portrait' && pw > ph) [pw, ph] = [ph, pw];
    } else {
      const PAPERS = { a4: [595.28, 841.89], a3: [841.89, 1190.55], letter: [612, 792], a5: [419.53, 595.28] };
      let [w0, h0] = PAPERS[paper] || PAPERS.a4;
      const landscape = orientation === 'landscape' || (orientation === 'auto' && pxW > pxH);
      if (landscape) [w0, h0] = [h0, w0];
      pw = w0; ph = h0;
    }
    const page = doc.addPage([pw, ph]);
    const availW = paper === 'auto' ? pw : Math.max(1, pw - margin * 2);
    const availH = paper === 'auto' ? ph : Math.max(1, ph - margin * 2);
    const img = await embedImageAny(doc, im.bytes, im.mime);
    let drawW, drawH;
    if (fit === 'cover') {
      // 填充裁切：等比缩放到完全覆盖可用区，居中放置，超出页面部分被裁掉（无留白）
      const s = Math.max(availW / imgW, availH / imgH);
      drawW = imgW * s; drawH = imgH * s;
    } else {
      // 适应页面（contain）：等比缩放到完全放入可用区，可能留白
      const s = Math.min(availW / imgW, availH / imgH);
      drawW = imgW * s; drawH = imgH * s;
    }
    if (bg) page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: pdfLib.rgb(...hexParts(bg)) });
    page.drawImage(img, {
      x: (pw - drawW) / 2, y: (ph - drawH) / 2, width: drawW, height: drawH,
    });
    bmp.close();
    progress({ done: i + 1, total: images.length, stage: `写入 ${im.name || i + 1}` });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  return { artifacts: [{ name: '图片合并.pdf', mime: 'application/pdf', bytes }], summary: { pages: images.length } };
};

function hexParts(hex) {
  const c = hexToRgb01(hex);
  return [c.r, c.g, c.b];
}

async function decodeImage(bytes, mime, name) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return await createImageBitmap(new Blob([u8], { type: mime || '' }), { imageOrientation: 'from-image' });
  } catch {
    throw toolkitError('ERR_UNSUPPORTED', `浏览器无法解码 ${name || '图片'}（TIFF 等请先转换格式）`);
  }
}

handlers['pdf.toImages'] = async ({ docId, pages, dpi = 150, format = 'png', quality = 0.92, bg = '#ffffff' }) => {
  const e = getDoc(docId);
  const range = parsePageRange(pages ?? 'all', e.pages.length);
  if (!range.ok) throw toolkitError('ERR_RANGE', range.error);
  const base = e.name.replace(/\.pdf$/i, '');
  const artifacts = [];
  for (let i = 0; i < range.pages.length; i++) {
    checkAbort();
    const p = range.pages[i];
    const r = await renderPageBitmap(e, p, { dpi, bg: format === 'jpeg' ? bg : null, maxPixels: LIMITS.maxRenderPixels });
    const canvas = new OffscreenCanvas(r.width, r.height);
    canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const blob = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    artifacts.push({
      name: `${base}_p${String(p + 1).padStart(3, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`,
      mime: blob.type, bytes,
    });
    progress({ done: i + 1, total: range.pages.length, stage: `渲染第 ${p + 1} 页` });
  }
  return { artifacts, summary: { pages: range.pages.length, dpi, format } };
};

// --- 嵌入图像提取 ---

const SUPPORTED_EXTRACT = new Set(['DCTDecode', 'FlateDecode']);

handlers['images.extract'] = async ({ docId, pages = 'all', mode = 'composite' }) => {
  const e = getDoc(docId);
  const doc = e.pdfLibDoc;
  const range = parsePageRange(pages, e.pages.length);
  if (!range.ok) throw toolkitError('ERR_RANGE', range.error);
  const pageSet = new Set(range.pages);
  // 页归属：遍历每页 Resources（含继承）
  const refPages = new Map(); // refKey → Set(pageNo)
  for (const p of range.pages) {
    const page = doc.getPage(p);
    for (const xo of pageImageRefs(doc, page)) {
      if (!refPages.has(xo)) refPages.set(xo, new Set());
      refPages.get(xo).add(p);
    }
  }
  const base = e.name.replace(/\.pdf$/i, '');
  const artifacts = [];
  const warnings = [];
  let found = 0, skipped = 0;
  const seen = new Set();
  let k = 0;
  const objects = doc.context.enumerateIndirectObjects();
  for (const [ref, obj] of objects) {
    checkAbort();
    if (!(obj instanceof pdfLib.PDFRawStream)) continue;
    const dict = obj.dict;
    const sub = dict.get(pdfLib.PDFName.of('Subtype'));
    if (!sub || sub.toString() !== '/Image') continue;
    const refKey = ref.toString();
    const smask = dict.get(pdfLib.PDFName.of('SMask'));
    const smaskKey = smask instanceof pdfLib.PDFRef ? smask.toString() : null;
    const dedupeKey = mode === 'composite' && smaskKey ? `${refKey}+${smaskKey}` : refKey;
    if (seen.has(dedupeKey) || (smaskKey && seen.has(smaskKey) && mode === 'raw')) { continue; }
    seen.add(dedupeKey);
    if (smaskKey) seen.add(smaskKey);
    const pages0 = refPages.get(refKey) || refPages.get(smaskKey);
    const ownerPage = pages0 ? [...pages0][0] : null;
    if (pages0 && ![...pages0].some((p) => pageSet.has(p))) continue;
    found++;
    const tag = ownerPage != null ? `p${String(ownerPage + 1).padStart(3, '0')}` : 'unk';
    try {
      const img = await decodeImageXObject(doc, obj, mode === 'composite', warnings);
      if (!img) { skipped++; found--; continue; }
      const ext = img.mime.includes('jpeg') ? 'jpg' : 'png';
      artifacts.push({
        name: `${base}_${tag}_图${String(++k).padStart(2, '0')}.${ext}`,
        mime: img.mime, bytes: img.bytes,
        meta: { page: ownerPage, width: img.width, height: img.height },
      });
    } catch (err) {
      skipped++;
      warnings.push(`第 ${ownerPage != null ? ownerPage + 1 : '?'} 页的图像无法提取：${err.message}`);
    }
    progress({ done: k, total: found, stage: `提取图像 ${k}` });
  }
  return { artifacts, warnings, summary: { found: artifacts.length, skipped } };
};

/** 页资源中的图像 ref 键（含继承） */
function pageImageRefs(doc, page) {
  const out = new Set();
  let node = page.node;
  let depth = 0;
  while (node && depth < 32) {
    const res = node.get(pdfLib.PDFName.of('Resources'));
    const resDict = res instanceof pdfLib.PDFRef ? doc.context.lookup(res) : res;
    if (resDict instanceof pdfLib.PDFDict) {
      const xo = resDict.get(pdfLib.PDFName.of('XObject'));
      const xoDict = xo instanceof pdfLib.PDFRef ? doc.context.lookup(xo) : xo;
      if (xoDict instanceof pdfLib.PDFDict) {
        for (const [, v] of xoDict.entries()) {
          const ref = v instanceof pdfLib.PDFRef ? v : null;
          if (ref) {
            const obj = doc.context.lookup(ref);
            if (obj instanceof pdfLib.PDFRawStream) {
              const sub = obj.dict.get(pdfLib.PDFName.of('Subtype'));
              if (sub && sub.toString() === '/Image') out.add(ref.toString());
            }
          }
        }
      }
    }
    const parent = node.get(pdfLib.PDFName.of('Parent'));
    node = parent instanceof pdfLib.PDFRef ? doc.context.lookup(parent) : null;
    depth++;
  }
  return out;
}

/** 解码图像 XObject → {bytes, mime, width, height} */
async function decodeImageXObject(doc, obj, composite, warnings) {
  const dict = obj.dict;
  const getN = (k) => {
    const v = dict.get(pdfLib.PDFName.of(k));
    return v == null ? null : (typeof v === 'object' && 'asNumber' in v ? v.asNumber() : Number(v?.toString?.() ?? NaN));
  };
  const w = getN('Width'), h = getN('Height'), bpc = getN('BitsPerComponent') || 8;
  if (!w || !h || w > 30000 || h > 30000) throw new Error('尺寸异常');
  const cs = dict.get(pdfLib.PDFName.of('ColorSpace'));
  const csStr = cs ? cs.toString() : '';
  const filter = dict.get(pdfLib.PDFName.of('Filter'));
  const filters = filter ? (filter.toString().startsWith('[') ? filter.asArray().map((f) => f.toString()) : [filter.toString()]) : [];
  // DCT：直接输出
  if (filters.includes('/DCTDecode') && filters.length === 1) {
    if (composite && dict.get(pdfLib.PDFName.of('SMask'))) {
      const raw = obj.getContents();
      const sm = await composeSMask(doc, dict, raw, warnings);
      if (sm) return sm;
    }
    return { bytes: obj.getContents(), mime: 'image/jpeg', width: w, height: h };
  }
  if (filters.includes('/JPXDecode')) throw new Error('JPEG2000 暂不支持');
  if (filters.includes('/CCITTFaxDecode')) throw new Error('CCITT 传真编码暂不支持');
  if (filters.includes('/JBIG2Decode')) throw new Error('JBIG2 暂不支持');
  if (filters.length > 1) throw new Error('多重过滤器暂不支持');
  if (csStr.includes('Indexed')) throw new Error('索引色暂不支持');
  if (!filters.includes('/FlateDecode')) throw new Error(`不支持的过滤器 ${filters.join(',') || '无'}`);
  // Flate → 原始像素
  let comps = 3;
  if (csStr === '/DeviceGray' || /ICCBased/.test(csStr)) {
    const n = await iccN(doc, cs);
    comps = n === 1 ? 1 : n === 3 ? 3 : n === 4 ? 4 : 3;
  } else if (csStr === '/DeviceRGB') comps = 3;
  else if (csStr === '/DeviceCMYK') comps = 4;
  else if (!csStr) comps = 3;
  else { throw new Error(`不支持的色彩空间 ${csStr}`); }
  let raw;
  try { raw = inflate(obj.getContents()); } catch (e2) { throw new Error('数据解压失败'); }
  // predictor 处理
  const parms = dict.get(pdfLib.PDFName.of('DecodeParms'));
  if (parms) {
    const pd = parms instanceof pdfLib.PDFRef ? doc.context.lookup(parms) : parms;
    if (pd instanceof pdfLib.PDFDict) {
      const predictor = pd.get(pdfLib.PDFName.of('Predictor'));
      const pv = predictor ? Number(predictor.toString()) : 1;
      if (pv >= 10) raw = unpngPredict(raw, w, h, comps, bpc, Number(pd.get(pdfLib.PDFName.of('Colors'))?.toString() || comps));
    }
  }
  if (bpc !== 8) raw = expandBits(raw, w * h * comps, bpc);
  const need = w * h * comps;
  if (raw.length < need) throw new Error('图像数据不完整');
  // 像素 → canvas → png（composite 时叠 SMask alpha）
  let alpha = null, aW = 0, aH = 0;
  if (composite) {
    const smRef = dict.get(pdfLib.PDFName.of('SMask'));
    if (smRef instanceof pdfLib.PDFRef) {
      const smObj = doc.context.lookup(smRef);
      if (smObj instanceof pdfLib.PDFRawStream) {
        try {
          const g = decodeGrayStream(doc, smObj);
          alpha = g.data; aW = g.w; aH = g.h;
        } catch (e3) { warnings.push('SMask 解码失败，按不透明处理'); }
      }
    }
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(w, h);
  const d = imageData.data;
  for (let i = 0; i < w * h; i++) {
    if (comps === 1) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = raw[i]; }
    else if (comps === 3) { d[i * 4] = raw[i * 3]; d[i * 4 + 1] = raw[i * 3 + 1]; d[i * 4 + 2] = raw[i * 3 + 2]; }
    else { // CMYK → 粗略 RGB
      const c = raw[i * 4], m = raw[i * 4 + 1], y = raw[i * 4 + 2], kk = raw[i * 4 + 3];
      d[i * 4] = 255 - Math.min(255, c + kk); d[i * 4 + 1] = 255 - Math.min(255, m + kk); d[i * 4 + 2] = 255 - Math.min(255, y + kk);
    }
    d[i * 4 + 3] = alpha && aW === w && aH === h ? alpha[i] : 255;
  }
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h };
}

async function composeSMask(doc, dict, jpegBytes, warnings) {
  const smRef = dict.get(pdfLib.PDFName.of('SMask'));
  if (!(smRef instanceof pdfLib.PDFRef)) return null;
  const smObj = doc.context.lookup(smRef);
  if (!(smObj instanceof pdfLib.PDFRawStream)) return null;
  const w = Number(dict.get(pdfLib.PDFName.of('Width'))?.toString());
  const h = Number(dict.get(pdfLib.PDFName.of('Height'))?.toString());
  const bmp = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
  const smaskData = decodeGrayStream(doc, smObj);
  if (smaskData.w !== w || smaskData.h !== h) { bmp.close(); return null; }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const im = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) im.data[i * 4 + 3] = smaskData.data[i];
  ctx.putImageData(im, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h };
}

/** 解码灰度（SMask）流 → {data:Uint8ClampedArray, w, h} */
function decodeGrayStream(doc, obj) {
  const dict = obj.dict;
  const w = Number(dict.get(pdfLib.PDFName.of('Width'))?.toString());
  const h = Number(dict.get(pdfLib.PDFName.of('Height'))?.toString());
  const bpc = Number(dict.get(pdfLib.PDFName.of('BitsPerComponent'))?.toString() || 8);
  const filter = dict.get(pdfLib.PDFName.of('Filter'));
  const fs = filter ? filter.toString() : '';
  if (!fs.includes('FlateDecode')) throw new Error('SMask 非 Flate');
  let raw = inflate(obj.getContents());
  const parms = dict.get(pdfLib.PDFName.of('DecodeParms'));
  if (parms) {
    const pd = parms instanceof pdfLib.PDFRef ? doc.context.lookup(parms) : parms;
    if (pd instanceof pdfLib.PDFDict) {
      const pv = Number(pd.get(pdfLib.PDFName.of('Predictor'))?.toString() || 1);
      if (pv >= 10) raw = unpngPredict(raw, w, h, 1, bpc, 1);
    }
  }
  const vals = bpc === 8 ? raw : expandBits(raw, w * h, bpc);
  return { data: vals.slice(0, w * h), w, h };
}

function expandBits(raw, n, bpc) {
  const maxV = (1 << bpc) - 1;
  const out = new Uint8Array(n);
  let bit = 0, cur = 0, oi = 0;
  for (let i = 0; i < raw.length && oi < n; i++) {
    for (let b = 7; b >= 0 && oi < n; b--) {
      const v = (raw[i] >> b) & 1;
      cur = (cur << 1) | v; bit++;
      if (bit === bpc) { out[oi++] = Math.round(cur * 255 / maxV); bit = 0; cur = 0; }
    }
  }
  return out;
}

/** 反 PNG predictor（Sub/Up/Average/Paeth） */
function unpngPredict(raw, w, h, comps, bpc, colors) {
  const bpp = Math.max(1, Math.floor((colors * bpc) / 8));
  const stride = Math.ceil((w * colors * bpc) / 8) + 1;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const ro = y * stride;
    const ft = raw[ro];
    for (let x = 1; x < stride; x++) {
      const rx = raw[ro + x];
      const left = x > bpp ? out[ro + x - bpp] : 0;
      const up = y > 0 ? out[ro + x - stride] : 0;
      const ul = y > 0 && x > bpp ? out[ro + x - stride - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = rx; break;
        case 1: v = rx + left; break;
        case 2: v = rx + up; break;
        case 3: v = rx + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          v = rx + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: v = rx;
      }
      out[ro + x] = v & 0xFF;
    }
  }
  // 展平为每像素 comps 字节
  const px = new Uint8Array(w * h * comps);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = y * stride + 1 + x * bpp;
      for (let c = 0; c < comps; c++) px[(y * w + x) * comps + c] = out[src + c] ?? 0;
    }
  }
  return px;
}

async function iccN(doc, cs) {
  const m = /ICCBased\s+(\d+)\s+0\s+R/.exec(cs.toString());
  if (!m) return null;
  const obj = doc.context.lookup(pdfLib.PDFRef.of(Number(m[1])));
  if (obj && obj.dict) {
    const n = obj.dict.get(pdfLib.PDFName.of('N'));
    return n ? Number(n.toString()) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 加密 / 解密（mupdf WASM）
// ---------------------------------------------------------------------------

const PERM_BITS = { print: 4, modify: 8, copy: 16, annotate: 32, forms: 256, assemble: 1024, printHq: 2048 };

handlers['crypto.encrypt'] = async ({ docId, userPassword, ownerPassword = '', permissions = null }) => {
  const e = getDoc(docId);
  if (!userPassword && !ownerPassword) throw toolkitError('ERR_BAD_ARGS', '请至少设置一个密码');
  for (const [label, pw] of [['用户密码', userPassword], ['所有者密码', ownerPassword]]) {
    if (pw && /[,=]/.test(pw)) throw toolkitError('ERR_BAD_ARGS', `${label}不能包含逗号或等号（引擎限制）`);
  }
  let mask;
  if (permissions) {
    mask = 0;
    for (const [k, v] of Object.entries(permissions)) if (v && PERM_BITS[k]) mask |= PERM_BITS[k];
  } else {
    mask = 0;
    for (const v of Object.values(PERM_BITS)) mask |= v;
  }
  const m = await getMupdf();
  const md = m.PDFDocument.openDocument(new Uint8Array(e.bytes.slice()), 'application/pdf');
  if (md.needsPassword() && !md.authenticatePassword('')) {
    throw toolkitError('ERR_ENCRYPTED', '请先解锁原文件');
  }
  const opts = `garbage=2,compress=yes,encrypt=aes-256,user-password=${userPassword || ''},owner-password=${ownerPassword || userPassword},permissions=${mask}`;
  const out = md.saveToBuffer(opts).asUint8Array();
  return {
    artifacts: [{ name: replaceExt(e.name, '加密.pdf'), mime: 'application/pdf', bytes: out }],
    summary: { encrypted: true, userPasswordSet: !!userPassword, ownerPasswordSet: !!(ownerPassword || userPassword) },
  };
};

handlers['crypto.decrypt'] = async ({ docId, password = '' }) => {
  const e = getDoc(docId);
  const m = await getMupdf();
  const md = m.PDFDocument.openDocument(new Uint8Array(e.bytes.slice()), 'application/pdf');
  if (md.needsPassword()) {
    const level = md.authenticatePassword(String(password ?? ''));
    if (!level) throw toolkitError('ERR_WRONG_PASSWORD');
  }
  const out = md.saveToBuffer('decrypt=yes,garbage=2,compress=yes').asUint8Array();
  const re = m.PDFDocument.openDocument(new Uint8Array(out.slice()), 'application/pdf');
  return {
    artifacts: [{ name: replaceExt(e.name, '已解密.pdf'), mime: 'application/pdf', bytes: out }],
    summary: { decrypted: true, stillEncrypted: re.needsPassword() },
  };
};

// ---------------------------------------------------------------------------
// 压缩
// ---------------------------------------------------------------------------

handlers['compress.run'] = async ({ docId, modes = { smart: true, raster: true, structural: true }, targetBytes = null, targetMargin = 1, minSsim = 0.9, evalSample = 5, evalDpi = 96 }) => {
  const e = getDoc(docId);
  const srcSize = e.bytes.byteLength;
  const effTarget = targetBytes ? targetBytes / Math.max(1, targetMargin) : null;
  // 参考页（SSIM）
  const pjs = await getPdfjs();
  const doc = await pdfjsOpen(e);
  const n = e.pages.length;
  const sampleN = Math.min(evalSample, n);
  const refPages = [];
  for (let i = 0; i < sampleN; i++) {
    const p = Math.floor(i * n / sampleN);
    refPages.push(p);
  }
  const refs = [];
  for (const p of refPages) {
    checkAbort();
    const r = await renderPageBitmap(e, p, { dpi: evalDpi, gray: true, bg: '#ffffff', maxPixels: 4e6 });
    const canvas = new OffscreenCanvas(r.width, r.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    refs.push({ page: p, gray: grayFromImageData(d.data, canvas.width, canvas.height), w: canvas.width, h: canvas.height });
  }

  const tried = new Set();
  let plan = planCandidates(modes, srcSize, effTarget);
  const rows = [];
  const artifacts = new Map();

  const runOne = async (cand) => {
    const id = candidateId(cand.mode, cand.params);
    tried.add(id);
    const t0 = Date.now();
    const row = { id, mode: cand.mode, params: { ...cand.params }, label: cand.label, status: 'running' };
    rows.push(row);
    progress({ done: rows.length, total: rows.length, stage: `尝试 ${cand.label}`, rows: snapshotRows(rows) });
    try {
      const res = await compressOne(e, cand, refs);
      row.ok = true;
      row.size = res.size;
      row.ratio = Math.round(res.size / srcSize * 1000) / 10;
      row.ssim = res.ssim;
      row.ssimMin = res.ssimMin;
      row.elapsed = Math.round((Date.now() - t0) / 100) / 10;
      artifacts.set(id, res.bytes);
    } catch (err) {
      row.ok = false;
      row.error = err.code ? err.message : `失败：${err.message}`;
    }
    progress({ done: rows.length, total: rows.length, stage: row.ok ? `${cand.label} → ${fmtMB(row.size)}` : `${cand.label} 失败`, rows: snapshotRows(rows) });
    return row;
  };

  const smallestOk = () => rows.filter((r) => r.ok).reduce((a, b) => (!a || b.size < a.size ? b : a), null);
  const reachedTarget = (row) => row && (!effTarget || row.size <= effTarget) && (row.ssim == null || row.ssim >= minSsim);

  // 粗搜
  for (const cand of plan) {
    checkAbort();
    await runOne(cand);
    if (reachedTarget(smallestOk())) break;
  }
  // 精搜：围绕最小体积候选生成邻域
  if (effTarget && !reachedTarget(smallestOk())) {
    const around = smallestOk();
    if (around && around.mode !== 'structural') {
      const neighbors = refineCandidates(around, tried);
      for (const cand of neighbors) {
        checkAbort();
        await runOne(cand);
      }
    }
  }
  // 控制候选产物内存：仅保留最好的 8 个
  if (artifacts.size > 8) {
    const sorted = rows.filter((r) => r.ok).sort((a, b) => a.size - b.size);
    const keep = new Set(sorted.slice(0, 8).map((r) => r.id));
    for (const [id] of artifacts) {
      if (!keep.has(id)) artifacts.delete(id);
    }
  }
  const { bestId, minId, qualityId } = pickBest(rows.map((r) => ({ ...r })), { targetBytes: effTarget, minSsim });
  return {
    rows: snapshotRows(rows),
    bestId, minId, qualityId,
    srcSize,
    artifacts: [...artifacts.entries()].map(([id, bytes]) => {
      const row = rows.find((r) => r.id === id);
      return { id, name: `${e.name.replace(/\.pdf$/i, '')}_${row.label.replace(/[^\u4e00-\u9fa5A-Za-z0-9%·]+/g, '')}.pdf`, mime: 'application/pdf', bytes };
    }),
  };
};

function snapshotRows(rows) {
  return rows.map((r) => ({ ...r, error: r.error ? String(r.error).slice(0, 120) : undefined }));
}

async function compressOne(entry, cand, refs) {
  let outBytes;
  if (cand.mode === 'structural') {
    outBytes = await structuralCompress(entry);
  } else if (cand.mode === 'raster') {
    outBytes = await rasterCompress(entry, cand.params);
  } else {
    outBytes = await smartCompress(entry, cand.params);
  }
  // SSIM 评估
  let ssim = null, ssimMin = null;
  if (refs.length) {
    const tmp = { docId: `cand_${Math.random()}`, name: entry.name, bytes: outBytes, pdfLibDoc: null, pdfjsDoc: null, pages: [], encrypted: false, needsPassword: false };
    try {
      const vals = [];
      for (const ref of refs) {
        const r = await renderPageBitmap(tmp, ref.page, { dpi: 96, gray: true, bg: '#ffffff', maxPixels: 4e6 });
        const canvas = new OffscreenCanvas(r.width, r.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(r.bitmap, 0, 0);
        r.bitmap.close();
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const gray = grayFromImageData(d.data, canvas.width, canvas.height);
        vals.push(ref.w === canvas.width && ref.h === canvas.height ? ssimGray(ref.gray, gray, canvas.width, canvas.height) : 0);
      }
      ssim = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10000) / 10000;
      ssimMin = Math.round(Math.min(...vals) * 10000) / 10000;
    } catch { ssim = null; }
  }
  return { bytes: outBytes, size: outBytes.byteLength, ssim, ssimMin };
}

async function structuralCompress(entry) {
  const doc = await pdfLibLoad(entry.bytes);
  return doc.save({ useObjectStreams: true });
}

async function rasterCompress(entry, { dpi, q }) {
  const n = entry.pages.length;
  const out = await pdfLib.PDFDocument.create();
  for (let p = 0; p < n; p++) {
    checkAbort();
    const r = await renderPageBitmap(entry, p, { dpi, bg: '#ffffff', maxPixels: 16e6 });
    const canvas = new OffscreenCanvas(r.width, r.height);
    canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q / 100 });
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = out.addPage([r.visualW, r.visualH]);
    page.drawImage(img, { x: 0, y: 0, width: r.visualW, height: r.visualH });
    progress({ done: p + 1, total: n, stage: `栅格化第 ${p + 1} 页`, op: 'raster' });
  }
  return out.save({ useObjectStreams: true });
}

/** 智能图像重压缩（旧版算法的浏览器移植：DCT RGB/Gray 重编码，SMask 尺寸守护） */
async function smartCompress(entry, { scale, q }) {
  const doc = await pdfLibLoad(entry.bytes);
  const ctx = doc.context;
  const objects = ctx.enumerateIndirectObjects();
  const imageObjs = [];
  for (const [ref, obj] of objects) {
    if (!(obj instanceof pdfLib.PDFRawStream)) continue;
    const d = obj.dict;
    const sub = d.get(pdfLib.PDFName.of('Subtype'));
    if (!sub || sub.toString() !== '/Image') continue;
    imageObjs.push({ ref, obj, dict: d });
  }
  // SMask 映射
  const smaskOf = new Map();
  for (const { ref, dict } of imageObjs) {
    const sm = dict.get(pdfLib.PDFName.of('SMask'));
    if (sm instanceof pdfLib.PDFRef) smaskOf.set(ref.toString(), sm.toString());
  }
  const smaskHosts = new Map(); // smaskKey → [hostRefs]
  for (const [host, sm] of smaskOf) {
    if (!smaskHosts.has(sm)) smaskHosts.set(sm, []);
    smaskHosts.get(sm).push(host);
  }
  const doneSmasks = new Map(); // smaskKey → {w,h}
  const stats = { recompressed: 0, skipped: 0, saved: 0 };

  const colorN = async (dict) => {
    const cs = dict.get(pdfLib.PDFName.of('ColorSpace'));
    if (!cs) return 3;
    const s = cs.toString();
    if (s === '/DeviceRGB') return 3;
    if (s === '/DeviceGray') return 1;
    const m = /ICCBased\s+(\d+)\s+R/.exec(s);
    if (m) {
      const o = ctx.lookup(pdfLib.PDFRef.of(Number(m[1])));
      if (o?.dict) {
        const n = o.dict.get(pdfLib.PDFName.of('N'));
        return n ? Number(n.toString()) : null;
      }
    }
    return null;
  };

  for (const item of imageObjs) {
    checkAbort();
    const { ref, obj, dict } = item;
    try {
      if ((dict.get(pdfLib.PDFName.of('ImageMask'))?.toString?.() || '') === 'true') { stats.skipped++; continue; }
      if (dict.get(pdfLib.PDFName.of('Mask'))) { stats.skipped++; continue; }
      const filter = dict.get(pdfLib.PDFName.of('Filter'));
      if (!filter || filter.toString() !== '/DCTDecode') { stats.skipped++; continue; }
      const nComp = await colorN(dict);
      const smKey = smaskOf.get(ref.toString());
      if (nComp !== 1 && nComp !== 3) { stats.skipped++; continue; }
      const w = Number(dict.get(pdfLib.PDFName.of('Width')).toString());
      const h = Number(dict.get(pdfLib.PDFName.of('Height')).toString());
      const raw = obj.getContents();
      const bmp = await createImageBitmap(new Blob([raw], { type: 'image/jpeg' }));
      const nw = Math.max(1, Math.round(bmp.width * scale));
      const nh = Math.max(1, Math.round(bmp.height * scale));
      // 共享 SMask 尺寸冲突守护
      if (smKey && smaskHosts.get(smKey).length > 1) {
        const prev = doneSmasks.get(smKey);
        if (prev && (prev.w !== nw || prev.h !== nh)) { stats.skipped++; bmp.close(); continue; }
        doneSmasks.set(smKey, { w: nw, h: nh });
      }
      if (nw === bmp.width && nh === bmp.height && q >= 90) { stats.skipped++; bmp.close(); continue; }
      const canvas = new OffscreenCanvas(nw, nh);
      const c2 = canvas.getContext('2d');
      c2.imageSmoothingQuality = 'high';
      c2.drawImage(bmp, 0, 0, nw, nh);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q / 100 });
      const newData = new Uint8Array(await blob.arrayBuffer());
      if (newData.byteLength >= raw.byteLength) { stats.skipped++; continue; }
      stats.saved += raw.byteLength - newData.byteLength;
      const newDict = ctx.obj({
        Type: 'XObject', Subtype: 'Image',
        Width: nw, Height: nh,
        ColorSpace: nComp === 1 ? 'DeviceGray' : 'DeviceRGB',
        BitsPerComponent: 8, Filter: 'DCTDecode',
      });
      ctx.assign(ref, pdfLib.PDFRawStream.of(newDict, newData));
      stats.recompressed++;
    } catch {
      stats.skipped++;
    }
    progress({ done: stats.recompressed + stats.skipped, total: imageObjs.length, stage: '图像重压缩', op: 'smart' });
  }
  return doc.save({ garbage: true, useObjectStreams: true });
}

// ---------------------------------------------------------------------------
// OCR / 文本
// ---------------------------------------------------------------------------

let tessWorker = null;
let tessLangs = '';

async function getTessWorker(langs, progressCb) {
  if (!tessWorker || tessLangs !== langs) notifyEngine('tesseract', 'loading', `加载 OCR 引擎与语言包（${langs}）…`);
  const T = await import('tesseract.js');
  if (tessWorker && tessLangs === langs) return tessWorker;
  if (tessWorker) { try { await tessWorker.terminate(); } catch { /* noop */ } }
  try {
    tessWorker = await T.createWorker(langs, 1, {
      langPath: `${assetBase()}tessdata/`,
      gzip: false, // 本地语言包为未压缩 .traineddata（tessdata_fast 原样分发）
      logger: (m) => {
        if (m.status === 'recognizing text') progressCb?.(Math.round(m.progress * 100));
      },
    });
  } catch (err) {
    notifyEngine('tesseract', 'error', err?.message || String(err));
    throw err;
  }
  tessLangs = langs;
  notifyEngine('tesseract', 'ready', `语言包 ${langs} 已就绪`);
  return tessWorker;
}

handlers['text.extract'] = async ({ docId, pages = 'all' }) => {
  const e = getDoc(docId);
  const range = parsePageRange(pages, e.pages.length);
  if (!range.ok) throw toolkitError('ERR_RANGE', range.error);
  const pjs = await getPdfjs();
  const doc = await pdfjsOpen(e);
  const out = [];
  for (let i = 0; i < range.pages.length; i++) {
    checkAbort();
    const p = range.pages[i];
    const page = await doc.getPage(p + 1);
    const tc = await page.getTextContent();
    // 行分组（y 坐标聚类）
    const items = tc.items.filter((it) => it.str !== undefined);
    const lines = groupLines(items);
    out.push({ page: p, text: lines.join('\n'), chars: items.reduce((s, it) => s + it.str.length, 0) });
    progress({ done: i + 1, total: range.pages.length, stage: `提取第 ${p + 1} 页` });
  }
  return { pages: out };
};

function groupLines(items) {
  const rows = new Map();
  for (const it of items) {
    const y = Math.round(it.transform[5] / 2) * 2;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], str: it.str });
  }
  const sorted = [...rows.entries()].sort((a, b) => b[0] - a[0]);
  return sorted.map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((i) => i.str).join(''));
}

handlers['ocr.run'] = async ({ docId, pages = 'all', langs = 'chi_sim+eng', dpi = 200, mode = 'auto', minNativeChars = 50 }) => {
  const e = getDoc(docId);
  const range = parsePageRange(pages, e.pages.length);
  if (!range.ok) throw toolkitError('ERR_RANGE', range.error);
  const worker = await getTessWorker(langs, (pct) => progress({ done: pct, total: 100, stage: '识别文字中' }));
  const base = e.name.replace(/\.pdf$/i, '');
  const pageResults = [];
  const searchTexts = [];
  let lastWordCount = 0, lastFontOk = false, lastFontErr = null, lastDrawErr = null;
  // 可搜索 PDF：整册重建（原生文字页直接拷贝，扫描页替换为图像+隐藏文字层）
  let searchable = null;
  if (mode === 'auto' || mode === 'searchable') {
    searchable = await pdfLib.PDFDocument.create();
  }
  const nativeDoc = await pdfjsOpen(e);
  for (let i = 0; i < range.pages.length; i++) {
    checkAbort();
    const p = range.pages[i];
    // 原生文字探测
    const pj = await nativeDoc.getPage(p + 1);
    const tc = await pj.getTextContent();
    const nativeText = groupLines(tc.items.filter((it) => it.str !== undefined)).join('\n');
    const useOcr = mode === 'ocr' || (mode === 'auto' && nativeText.replace(/\s/g, '').length < minNativeChars);
    let text = '';
    if (useOcr) {
      const r = await renderPageBitmap(e, p, { dpi, bg: '#ffffff', maxPixels: LIMITS.maxRenderPixels });
      const canvas = new OffscreenCanvas(r.width, r.height);
      canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
      r.bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
      text = data.text || '';
      const words = collectWords(data);
      lastWordCount = words.length;
      if (searchable) {
        // 图像页 + 隐藏文字层
        const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        const img = await searchable.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
        const page = searchable.addPage([r.visualW, r.visualH]);
        page.drawImage(img, { x: 0, y: 0, width: r.visualW, height: r.visualH });
        const scaleX = r.visualW / r.width, scaleY = r.visualH / r.height;
        let font = null;
        try { font = await resolveFont(searchable, 'auto', false, text); lastFontOk = true; } catch (fe) { font = null; lastFontErr = String(fe && fe.message || fe); }
        for (const w0 of words) {
          if (!w0.text?.trim() || !font) continue;
          // tesseract.js v7：坐标嵌在 w0.bbox（兼容顶层字段）
          const bb = w0.bbox || w0;
          const bx0 = Number(bb.x0), bx1 = Number(bb.x1), by0 = Number(bb.y0), by1 = Number(bb.y1);
          if (![bx0, bx1, by0, by1].every(Number.isFinite)) continue;
          try {
            const wx = bx0 * scaleX, wy = r.height - by1;
            if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(scaleY)) continue;
            page.drawText(w0.text, {
              x: wx, y: wy * scaleY,
              size: Math.max(1, (by1 - by0) * scaleY * 0.9),
              font, opacity: 0,
            });
          } catch (de) { if (!lastDrawErr) lastDrawErr = String(de && de.message || de); }
        }
      }
    } else {
      text = nativeText;
      if (searchable) {
        const [copied] = await searchable.copyPages(e.pdfLibDoc, [p]);
        searchable.addPage(copied);
      }
    }
    pageResults.push({ page: p, ocr: useOcr, text, chars: text.length });
    searchTexts.push(`--- 第 ${p + 1} 页 ---\n${text}`);
    progress({ done: i + 1, total: range.pages.length, stage: `第 ${p + 1} 页完成` });
  }
  const artifacts = [];
  if (searchable) {
    artifacts.push({ name: `${base}_可搜索.pdf`, mime: 'application/pdf', bytes: await searchable.save({ useObjectStreams: true }) });
  }
  artifacts.push({ name: `${base}_文字.txt`, mime: 'text/plain;charset=utf-8', bytes: new TextEncoder().encode(searchTexts.join('\n\n')) });
  return { artifacts, pages: pageResults.map(({ page, ocr, chars }) => ({ page, ocr, chars })), summary: { ocrPages: pageResults.filter((r) => r.ocr).length, nativePages: pageResults.filter((r) => !r.ocr).length, wordCount: lastWordCount, fontOk: lastFontOk, fontErr: lastFontErr, drawErr: lastDrawErr } };
};

function collectWords(data) {
  const words = [];
  const walk = (blocks) => {
    for (const b of blocks || []) {
      if (b.words) words.push(...b.words.filter((w0) => w0.bbox));
      if (b.paragraphs) for (const pa of b.paragraphs) {
        for (const l of pa.lines || []) for (const w0 of l.words || []) if (w0.bbox) words.push(w0);
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(data.blocks);
  return words;
}

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

handlers['compare.run'] = async ({ aDocId, bDocId, pagesA = 'all', pagesB = 'all', dpi = 110, threshold = 24, withText = true }) => {
  const A = getDoc(aDocId), B = getDoc(bDocId);
  const ra = parsePageRange(pagesA, A.pages.length);
  const rb = parsePageRange(pagesB, B.pages.length);
  if (!ra.ok || !rb.ok) throw toolkitError('ERR_RANGE', !ra.ok ? ra.error : rb.error);
  const pairs = [];
  const n = Math.min(ra.pages.length, rb.pages.length);
  const diffs = [];
  for (let i = 0; i < n; i++) {
    checkAbort();
    const pa = ra.pages[i], pb = rb.pages[i];
    const r1 = await renderPageBitmap(A, pa, { dpi, bg: '#ffffff', maxPixels: 6e6 });
    const r2 = await renderPageBitmap(B, pb, { dpi, bg: '#ffffff', maxPixels: 6e6 });
    const w = Math.min(r1.width, r2.width), h = Math.min(r1.height, r2.height);
    const c1 = new OffscreenCanvas(w, h); c1.getContext('2d').drawImage(r1.bitmap, 0, 0, w, h);
    const c2 = new OffscreenCanvas(w, h); c2.getContext('2d').drawImage(r2.bitmap, 0, 0, w, h);
    r1.bitmap.close(); r2.bitmap.close();
    const d1 = c1.getContext('2d').getImageData(0, 0, w, h);
    const d2 = c2.getContext('2d').getImageData(0, 0, w, h);
    let diffCount = 0;
    const mask = new OffscreenCanvas(w, h);
    const mctx = mask.getContext('2d');
    const mimg = mctx.createImageData(w, h);
    const fade = mctx.createImageData(w, h);
    for (let px = 0; px < w * h; px++) {
      const o = px * 4;
      const diff = Math.abs(d1.data[o] - d2.data[o]) > threshold
        || Math.abs(d1.data[o + 1] - d2.data[o + 1]) > threshold
        || Math.abs(d1.data[o + 2] - d2.data[o + 2]) > threshold;
      if (diff) diffCount++;
      // 高亮掩膜：白色底 + 红色差异
      mimg.data[o] = 255; mimg.data[o + 1] = 255; mimg.data[o + 2] = 255; mimg.data[o + 3] = 255;
      if (diff) { mimg.data[o] = 220; mimg.data[o + 1] = 38; mimg.data[o + 2] = 38; }
      // 底图（B 页）淡化
      fade.data[o] = d2.data[o]; fade.data[o + 1] = d2.data[o + 1]; fade.data[o + 2] = d2.data[o + 2];
      fade.data[o + 3] = 200;
    }
    mctx.putImageData(fade, 0, 0);
    mctx.putImageData(mimg, 0, 0);
    const pct = Math.round(diffCount / (w * h) * 10000) / 100;
    const bitmap = mask.transferToImageBitmap();
    diffs.push({ a: pa, b: pb, pct, same: pct < 0.05, bitmap, width: w, height: h });
    pairs.push({ a: pa, b: pb, pct, same: pct < 0.05 });
    progress({ done: i + 1, total: n, stage: `对比第 ${pa + 1} 页` });
  }
  // 文本 diff
  let textDiffs = [];
  if (withText) {
    const ta = await handlers['text.extract']({ docId: aDocId, pages: pagesA });
    const tb = await handlers['text.extract']({ docId: bDocId, pages: pagesB });
    const mapB = new Map(tb.pages.map((p) => [p.page, p.text]));
    textDiffs = pageTextDiffs(ta.pages.map((p) => ({ pageA: p.page, pageB: p.page, textA: p.text, textB: mapB.get(p.page) ?? '' })), { ignoreWhitespace: true });
  }
  return {
    pairs: diffs.map(({ a, b, pct, same }) => ({ a, b, pct, same })),
    textDiffs,
    extraA: ra.pages.slice(n).map((p) => p),
    extraB: rb.pages.slice(n).map((p) => p),
    bitmaps: diffs.map((d) => ({ a: d.a, b: d.b, pct: d.pct, bitmap: d.bitmap, width: d.width, height: d.height })),
  };
};

// ---------------------------------------------------------------------------
// 调度循环
// ---------------------------------------------------------------------------

let currentOp = null;

export function progress(data) {
  self.postMessage({ type: 'progress', id: currentOp?.id, ...data });
}

export function checkAbort() {
  if (currentOp?.aborted) throw toolkitError('ERR_CANCELLED');
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'abort') {
    if (currentOp && currentOp.id === msg.id) currentOp.aborted = true;
    return;
  }
  if (msg.type === 'run') {
    currentOp = { id: msg.id, aborted: false };
    try {
      const handler = handlers[msg.op];
      if (!handler) throw toolkitError('ERR_BAD_ARGS', `未知操作 ${msg.op}`);
      if (msg.args?.limits) {
        LIMITS = { ...LIMITS, ...msg.args.limits };
        if (msg.args.limits.assetBase) ASSET_BASE = msg.args.limits.assetBase;
      }
      const result = await handler(msg.args || {});
      self.postMessage({ type: 'result', id: msg.id, ok: true, result });
    } catch (err) {
      self.postMessage({
        type: 'result', id: msg.id, ok: false,
        code: err.code || 'ERR_ENGINE',
        message: err.message || String(err),
      });
    } finally {
      currentOp = null;
    }
  }
};
