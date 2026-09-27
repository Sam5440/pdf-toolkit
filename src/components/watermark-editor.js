// 水印编辑器 + 水印/叠加绘制实现（代理 B）。
//
// 引擎缺陷绕过（详见交付报告，未改动 src/core/**）：
// engine-worker.js 的 pageMeta() 产出 crop/media 为 {x,y,w,h} 形状，而 geometry.js 的
// normBox()/visualSize()/visualToUser() 只认 {x,y,width,height} 或 {x0,y0,x1,y1}，
// 导致 worker 内所有视觉坐标计算得到 NaN：wm.preview/wm.apply 平铺静默画空、单个锚点
// 抛 ReferenceError（anchorPoint 也未导入）、overlay.apply 静默输出零缩放内容。
// 因此本模块在主线程用同一套纯模块（geometry.js / watermark-model.js，传入正确盒形状）
// 实现绘制：预览（composeWatermarkPreview）与导出（applyWatermarkMain / applyOverlayMain）
// 共用 drawWatermarkLayers，"预览=导出" 仍然成立；引擎修复后可将工具切回 run('wm.*')。
//
// 真实预览协议：spec 变化 → 防抖 → 递增版本号 → composeWatermarkPreview（复制单页 →
// 与导出同一 drawWatermarkLayers 绘制 → pdf.js 渲染位图）→ 画到 canvas；旧响应按版本号丢弃。
import { iconNode } from './icons.js';
import * as pdfLib from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getSettings } from '../core/settings.js';
import { BUILTIN_FONTS, FONTS, probeFonts, getFontBytes, ensureCJKFontFace, CJK_FONT_STACK, isCJKText } from '../core/fonts.js';
import * as geometry from '../core/geometry.js';
import { sanitizeLayer, resolveLayerPages, applyTemplateVars, tileLayout, fullscreenLayout, hexToRgb01 } from '../core/watermark-model.js';
import { anchorPoint } from '../core/geometry.js';
import { pickFiles } from '../core/files.js';
import { downloadArtifact } from '../core/download.js';
import { toast, field, select, numberInput, textInput, checkbox, button } from './ui.js';
import { uid, todayStr, nowTimeStr, fmtBytes, baseName } from '../core/format.js';

const PRESET_KEY = 'pdftoolkit.wmPresets';
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const ANCHOR_NAMES = { tl: '左上', tc: '上中', tr: '右上', ml: '左中', mc: '居中', mr: '右中', bl: '左下', bc: '下中', br: '右下' };
const TEMPLATE_HINT = '可用变量：{页码} {总页数} {文件名} {日期} {时间}（导出与预览同样替换）';
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;

// ============================================================================
// 绘制实现（主线程；与 engine-worker wm 路径同构，但盒形状与 geometry.js 兼容）
// ============================================================================

const libCache = new Map(); // docId:size → 只读 PDFDocument（仅用于 copyPages，绝不改动）

async function loadFreshLib(doc) {
  const buf = await doc.file.arrayBuffer();
  const lib = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  if (lib.isEncrypted) {
    throw Object.assign(new Error('文件已加密，请先使用「密码保护」工具解密后再添加水印'), { code: 'ERR_ENCRYPTED' });
  }
  return lib;
}

async function getReadonlyLib(doc) {
  const key = `${doc.id}:${doc.size}`;
  if (!libCache.has(key)) libCache.set(key, await loadFreshLib(doc));
  return libCache.get(key);
}

/** 页面元信息 —— 与 geometry.js 兼容的盒形状（width/height 键） */
function pageMetaOf(page) {
  const size = page.getSize();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  let crop;
  try {
    const cb = page.getCropBox();
    crop = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
  } catch {
    crop = { x: 0, y: 0, width: size.width, height: size.height };
  }
  const vis = geometry.visualSize(crop, rot);
  return { w: size.width, h: size.height, rot, crop, visualW: vis.w, visualH: vis.h };
}

async function resolveFont(doc, fontId, bold, text) {
  let id = fontId;
  if (id === 'auto' || !id) id = CJK_RE.test(text || '') ? 'noto-sc' : 'helvetica';
  if (id === 'helvetica') return doc.embedFont(pdfLib.StandardFonts.Helvetica);
  if (id === 'times') return doc.embedFont(bold ? pdfLib.StandardFonts.TimesRomanBold : pdfLib.StandardFonts.TimesRoman);
  if (id === 'courier') return doc.embedFont(pdfLib.StandardFonts.Courier);
  const bytes = await getFontBytes(id, { bold: !!bold });
  doc.registerFontkit(fontkit);
  return doc.embedFont(bytes, { subset: true });
}

function drawTextLayerDirect(page, font, lines, opts) {
  // opts: {cx, cy (用户空间块中心), fontSize, color01, opacity, angleUser, align, pageRotation}
  const { fontSize, color01, opacity, angleUser, align } = opts;
  const lh = fontSize * 1.3;
  const widthOf = (s) => { try { return font.widthOfTextAtSize(s, fontSize); } catch { return s.length * fontSize * 0.6; } };
  const maxW = Math.max(...lines.map(widthOf));
  const n = lines.length;
  const color = pdfLib.rgb(color01.r, color01.g, color01.b);
  lines.forEach((line, i) => {
    const offVx = align === 'left' ? -(maxW / 2 - widthOf(line) / 2)
      : align === 'right' ? (maxW / 2 - widthOf(line) / 2) : 0;
    const offVy = (i - (n - 1) / 2) * lh;
    const vec = geometry.visualVecToUser(offVx, offVy, opts.pageRotation);
    const ux = opts.cx + vec.dx, uy = opts.cy + vec.dy;
    const w = widthOf(line);
    const baseVec = geometry.visualVecToUser(-w / 2, fontSize * 0.36, opts.pageRotation);
    page.drawText(line, {
      x: ux + baseVec.dx, y: uy + baseVec.dy,
      size: fontSize, font, color, opacity,
      rotate: pdfLib.degrees(angleUser),
    });
  });
}

function drawImageOnPage(page, img, { cx, cy, drawW, drawH, opacity, angleUser }) {
  page.drawImage(img, {
    x: cx - drawW / 2, y: cy - drawH / 2,
    width: drawW, height: drawH,
    opacity,
    rotate: pdfLib.degrees(angleUser),
  });
}

// --- CJK 文字栅格化路径（pdf-lib subset:true 对大型 CJK 字体产出损坏字形，
// 全量嵌入 +6MB 不可接受；Canvas→透明 PNG→drawImage 体积 KB 级且任意字符可用） ---

const RASTER_SCALE = 3; // px per pt
const rasterLineCache = new Map(); // key → { bytes, wPt, hPt }
const rasterEmbedCache = new WeakMap(); // PDFDocument → Map(key → PDFImage)
let measureCtx = null;

function getMeasureCtx() {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    measureCtx = c.getContext('2d');
  }
  return measureCtx;
}

function cjkFontSpec(fontSizePt, bold) {
  return `${bold ? 700 : 400} ${fontSizePt * RASTER_SCALE}px ${CJK_FONT_STACK}`;
}

/** 测量一行文字的 pt 宽度（与栅格渲染同字体栈，保证布局一致） */
export function measureCJK(text, fontSizePt, bold) {
  const ctx = getMeasureCtx();
  ctx.font = cjkFontSpec(fontSizePt, bold);
  return ctx.measureText(text).width / RASTER_SCALE;
}

/** 单行文字 → 透明 PNG（紧致 bbox）；颜色烘入位图，透明度由 drawImage 的 opacity 承担 */
async function rasterLinePng(text, { fontSize, bold, color01 }) {
  const key = `${text}|${fontSize}|${bold ? 'b' : 'r'}|${color01.r},${color01.g},${color01.b}`;
  if (rasterLineCache.has(key)) return rasterLineCache.get(key);
  await ensureCJKFontFace();
  const K = RASTER_SCALE;
  const canvas = new OffscreenCanvas(8, 8);
  const ctx = canvas.getContext('2d');
  ctx.font = cjkFontSpec(fontSize, bold);
  const m = ctx.measureText(text);
  const ascent = Math.ceil((m.actualBoundingBoxAscent || fontSize * K * 0.8)) + 2;
  const descent = Math.ceil((m.actualBoundingBoxDescent || fontSize * K * 0.25)) + 2;
  const w = Math.max(4, Math.ceil(m.width) + 4);
  const h = ascent + descent;
  canvas.width = w;
  canvas.height = h;
  const ctx2 = canvas.getContext('2d'); // 尺寸变更后重取（状态重置）
  ctx2.font = cjkFontSpec(fontSize, bold);
  ctx2.fillStyle = `rgb(${Math.round(color01.r * 255)},${Math.round(color01.g * 255)},${Math.round(color01.b * 255)})`;
  ctx2.textBaseline = 'alphabetic';
  ctx2.fillText(text, 2, ascent);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const entry = { bytes: new Uint8Array(await blob.arrayBuffer()), wPt: w / K, ascentPt: ascent / K, hPt: h / K, key };
  rasterLineCache.set(key, entry);
  if (rasterLineCache.size > 300) { // 防膨胀：模板变量长文档的极端情形
    const first = rasterLineCache.keys().next().value;
    rasterLineCache.delete(first);
  }
  return entry;
}

async function embedRasterLine(doc, entry) {
  let cache = rasterEmbedCache.get(doc);
  if (!cache) {
    cache = new Map();
    rasterEmbedCache.set(doc, cache);
  }
  if (!cache.has(entry.key)) {
    cache.set(entry.key, await doc.embedPng(entry.bytes));
  }
  return cache.get(entry.key);
}

/** 旋转后包围盒中心对齐的图片绘制（等价 drawTextLayerDirect 的绕块中心旋转） */
function drawRasterLineOnPage(page, img, e, { cx, cy, opacity, angleUser }) {
  const w = e.wPt, h = e.hPt;
  // 视觉行中心：位图 bbox 的垂直中心在 baseline 上方 (ascent - h/2)；视觉 y 向下，
  // 这里直接用包围盒中心即 visualToUser 的 cy（调用方已给出行块中心），再按锚点公式回退
  const rad = (angleUser * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // 锚点 = 中心 − R·(w/2, h/2)
  const ax = cx - (w / 2) * cos + (h / 2) * sin;
  const ay = cy - (w / 2) * sin - (h / 2) * cos;
  page.drawImage(img, { x: ax, y: ay, width: w, height: h, opacity, rotate: pdfLib.degrees(angleUser) });
}

function tilePositions(layer, visW, visH, cellW, cellH) {
  if (layer.placement === 'single') {
    const a = anchorPoint(layer.anchor, visW, visH);
    return [{ vx: a.vx + layer.offsetX, vy: a.vy + layer.offsetY }];
  }
  if (layer.placement === 'diagonal') {
    return [{ vx: visW / 2 + layer.offsetX, vy: visH / 2 + layer.offsetY }];
  }
  if (layer.placement === 'fullscreen') {
    // 全屏高密度平铺：均匀格子 + 四周出血，旋转后仍覆盖页角
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

async function embedImageAny(doc, bytes, mime) {
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
    throw Object.assign(new Error('浏览器无法解码该图片格式（TIFF 等请先转换为 PNG/JPG）'), { code: 'ERR_UNSUPPORTED' });
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

// --- under 层：Form XObject 前置（与 engine-worker 同方案，保真：保留注释/链接） ---

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
  }
  if (res instanceof pdfLib.PDFDict) return res;
  const d = doc.context.obj({});
  node.set(pdfLib.PDFName.of('Resources'), d);
  return d;
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

function nodeContents(page) {
  const c = page.node.get(pdfLib.PDFName.of('Contents'));
  const out = [];
  if (c instanceof pdfLib.PDFRef) out.push(c);
  else if (c instanceof pdfLib.PDFArray) for (let i = 0; i < c.size(); i++) out.push(c.get(i));
  return out;
}

async function prependAsFormXObject(doc, page, drawFn, mediaBox) {
  const tmp = await pdfLib.PDFDocument.create();
  const tp = tmp.addPage([mediaBox.w, mediaBox.h]);
  tp.node.set(pdfLib.PDFName.of('MediaBox'), doc.context.obj([mediaBox.x0, mediaBox.y0, mediaBox.x1, mediaBox.y1]));
  await drawFn(tmp, tp);
  const tmpBytes = await tmp.save({ useObjectStreams: false });
  const tmpLoad = await pdfLib.PDFDocument.load(tmpBytes, { ignoreEncryption: true });
  const [copied] = await doc.copyPages(tmpLoad, [0]);
  const node = copied.node;
  const contents = node.get(pdfLib.PDFName.of('Contents'));
  const streamRefs = [];
  if (contents instanceof pdfLib.PDFRef) streamRefs.push(contents);
  else if (contents instanceof pdfLib.PDFArray) {
    for (let i = 0; i < contents.size(); i++) streamRefs.push(contents.get(i));
  }
  if (!streamRefs.length) return;
  const cRes = node.get(pdfLib.PDFName.of('Resources'));
  const cResRef = cRes instanceof pdfLib.PDFRef ? cRes : doc.context.register(cRes);
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
  const res = pageResourcesDict(doc, page);
  const key = uniqueXObjectKey(res);
  ensureDict(res, 'XObject').set(pdfLib.PDFName.of(key), formRef);
  const ops = new TextEncoder().encode(`q\n/${key} Do\nQ\n`);
  const opsRef = doc.context.register(pdfLib.PDFRawStream.of(doc.context.obj({}), ops));
  const existing = nodeContents(page);
  page.node.set(pdfLib.PDFName.of('Contents'), doc.context.obj([opsRef, ...existing]));
}

/**
 * 核心：将水印层集合绘制到 doc 的指定页（预览与导出共用 → 预览=导出）。
 * @param {pdfLib.PDFDocument} doc
 * @param {{layers: object[]}} spec 原始层规格（契约 §3）
 * @param {object} vars {docName, date, time}
 * @param {number[]|null} scopePages 非 null 时所有层都画到这些页（0 基，预览用）
 */
export async function drawWatermarkLayers(doc, spec, vars = {}, scopePages = null) {
  const pageCount = doc.getPageCount();
  const layers = [];
  for (const raw of spec.layers || []) {
    const l = sanitizeLayer(raw);
    if (l.type === 'image') {
      if (!raw.imageBytes) throw Object.assign(new Error('图片水印缺少图片数据'), { code: 'ERR_BAD_ARGS' });
      const img = await embedImageAny(doc, raw.imageBytes, raw.imageMime);
      l._img = img;
      l._imgW = img.width || 1;
      l._imgH = img.height || 1;
    }
    layers.push(l);
  }
  if (!layers.length) throw Object.assign(new Error('没有水印层'), { code: 'ERR_BAD_ARGS' });
  for (const layer of layers) {
    let pageIdxs;
    if (scopePages) pageIdxs = scopePages;
    else pageIdxs = resolveLayerPages(layer, pageCount);
    // CJK 文字走栅格路径（pdf-lib subset:true 损坏 CJK 字形；全量嵌入 +6MB）
    const sampleResolved = layer.type === 'text'
      ? applyTemplateVars(layer.text, { ...vars, pageNo: 1, pageCount })
      : '';
    const useRaster = layer.type === 'text' && (layer.fontId === 'noto-sc' || isCJKText(sampleResolved));
    const font = layer.type === 'text' && !useRaster
      ? await resolveFont(doc, layer.fontId, layer.bold, sampleResolved)
      : null;
    for (const pageNo of pageIdxs) {
      if (pageNo < 0 || pageNo >= pageCount) continue;
      const page = doc.getPage(pageNo);
      const pm = pageMetaOf(page);
      const vtext = layer.type === 'text' ? applyTemplateVars(layer.text, {
        ...vars, pageNo: pageNo + 1, pageCount,
        date: vars.date, time: vars.time, docName: vars.docName,
      }) : '';
      const lines = vtext.split('\n');
      let cellW, cellH;
      if (layer.type === 'text') {
        const widthOf = useRaster
          ? (s) => measureCJK(s, layer.fontSize, layer.bold)
          : (s) => { try { return font.widthOfTextAtSize(s, layer.fontSize); } catch { return s.length * layer.fontSize * 0.6; } };
        cellW = Math.max(4, Math.max(...lines.map(widthOf)));
        cellH = lines.length * layer.fontSize * 1.3;
      } else {
        cellW = layer.imageScale * pm.visualW;
        cellH = cellW * (layer._imgH / layer._imgW);
      }
      if (layer.rotation % 180 !== 0) {
        const rad = Math.abs(layer.rotation) * Math.PI / 180;
        const bw = cellW * Math.cos(rad) + cellH * Math.sin(rad);
        const bh = cellW * Math.sin(rad) + cellH * Math.cos(rad);
        cellW = bw; cellH = bh;
      }
      const positions = tilePositions(layer, pm.visualW, pm.visualH, cellW, cellH);
      const angleUser = geometry.userAngleForVisual(layer.rotation, pm.rot);
      const drawOn = async (targetDoc, targetPage) => {
        for (const pos of positions) {
          const c = geometry.visualToUser(pos.vx, pos.vy, pm.crop, pm.rot);
          if (layer.type === 'text') {
            if (useRaster) {
              // 栅格逐行：行偏移与矢量路径一致（对齐/行距），颜色烘入位图、透明度走 ExtGState
              const color01 = hexToRgb01(layer.color);
              const widthOf = (s) => measureCJK(s, layer.fontSize, layer.bold);
              const maxW = Math.max(...lines.map(widthOf));
              const lh = layer.fontSize * 1.3;
              const n = lines.length;
              for (let i = 0; i < n; i++) {
                const line = lines[i];
                if (!line) continue;
                const offVx = layer.align === 'left' ? -(maxW / 2 - widthOf(line) / 2)
                  : layer.align === 'right' ? (maxW / 2 - widthOf(line) / 2) : 0;
                const offVy = (i - (n - 1) / 2) * lh;
                const vec = geometry.visualVecToUser(offVx, offVy, pm.rot);
                const entry = await rasterLinePng(line, { fontSize: layer.fontSize, bold: layer.bold, color01 });
                const img = await embedRasterLine(targetDoc, entry);
                drawRasterLineOnPage(targetPage, img, entry, {
                  cx: c.x + vec.dx, cy: c.y + vec.dy,
                  opacity: layer.opacity, angleUser,
                });
              }
            } else {
              drawTextLayerDirect(targetPage, font, lines, {
                cx: c.x, cy: c.y, fontSize: layer.fontSize,
                color01: hexToRgb01(layer.color), opacity: layer.opacity,
                angleUser, align: layer.align, pageRotation: pm.rot,
              });
            }
          } else {
            drawImageOnPage(targetPage, layer._img, {
              cx: c.x, cy: c.y,
              drawW: layer.imageScale * pm.visualW,
              drawH: layer.imageScale * pm.visualW * (layer._imgH / layer._imgW),
              opacity: layer.opacity, angleUser,
            });
          }
        }
      };
      if (layer.layerSide === 'under') {
        await prependAsFormXObject(doc, page, async (tmpDoc, tmpPage) => {
          await drawOn(tmpDoc, tmpPage);
        }, { x0: 0, y0: 0, w: pm.w, h: pm.h, x1: pm.w, y1: pm.h });
      } else {
        await drawOn(doc, page);
      }
    }
  }
}

let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjsLib;
}

/** pdf.js 渲染字节 → ImageBitmap（主线程） */
async function renderBytesToBitmap(bytes, dpi) {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true });
  const pdoc = await task.promise;
  try {
    const page = await pdoc.getPage(1);
    const scale = dpi / 72;
    const vp0 = page.getViewport({ scale: 1 });
    let s = scale;
    const px = vp0.width * s * vp0.height * s;
    const maxPixels = getSettings().maxRenderPixels || 4096 * 4096;
    if (px > maxPixels) s *= Math.sqrt(maxPixels / px);
    const vp = page.getViewport({ scale: s });
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const bitmap = canvas.transferToImageBitmap();
    return { bitmap, width: canvas.width, height: canvas.height, visualW: vp0.width, visualH: vp0.height };
  } finally {
    try { await pdoc.destroy(); } catch { /* noop */ }
  }
}

/**
 * 真实预览：复制单页 → 与导出同一 drawWatermarkLayers → pdf.js 渲染位图。
 * 返回 {bitmap, width, height, visualW, visualH}（与引擎 wm.preview 协议一致）。
 */
export async function composeWatermarkPreview({ doc, page, spec, vars = {}, dpi = 110 }) {
  const lib = await getReadonlyLib(doc);
  const single = await pdfLib.PDFDocument.create();
  const [p] = await single.copyPages(lib, [Math.min(page, lib.getPageCount() - 1)]);
  single.addPage(p);
  if ((spec.layers || []).length) {
    await drawWatermarkLayers(single, spec, vars, [0]);
  }
  const bytes = await single.save({ useObjectStreams: false });
  return renderBytesToBitmap(bytes, dpi);
}

/** 文档信息（页数 + 各页视觉尺寸；加密文件抛错） */
export async function readDocInfo(doc) {
  const lib = await getReadonlyLib(doc);
  const pages = lib.getPages().map((p) => {
    const pm = pageMetaOf(p);
    return { visualW: pm.visualW, visualH: pm.visualH };
  });
  return { pageCount: pages.length, pages, encrypted: false };
}

/**
 * 导出：对整份文档应用水印并保存（与预览共用 drawWatermarkLayers）。
 * 返回 {name, mime, bytes}。
 */
export async function applyWatermarkMain({ doc, spec, vars = {} }) {
  const lib = await loadFreshLib(doc); // 每次全新加载：避免重复应用叠加
  await drawWatermarkLayers(lib, spec, vars, null);
  const bytes = await lib.save({ useObjectStreams: true });
  return { name: `${baseName(doc.name)}_水印.pdf`, mime: 'application/pdf', bytes };
}

// --- 叠加（主线程实现；引擎 overlay.apply 因同一几何缺陷静默输出零缩放内容） ---

function pdfNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 1e6) / 1e6);
}

/**
 * 以 ExtGState 透明度绘制嵌入页（over=追加内容流 / under=前置内容流）。
 * 注：不用 pdf-lib pushOperators —— 实测其会丢弃 PDFName 操作数（pdf-lib 1.17.1 缺陷），
 * 这里直接向 Contents 数组追加/前置原始内容流（与 under 层同一机制，已验证可靠）。
 */
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
  const opsRef = doc.context.register(pdfLib.PDFRawStream.of(doc.context.obj({}), opsU8));
  const existing = nodeContents(page);
  if (under) {
    page.node.set(pdfLib.PDFName.of('Contents'), doc.context.obj([opsRef, ...existing]));
  } else {
    page.node.set(pdfLib.PDFName.of('Contents'), doc.context.obj([...existing, opsRef]));
  }
}

/**
 * 导出：按配对模式把覆盖稿叠加到底稿（与引擎 overlay.apply 协议一致）。
 * 返回 {name, mime, bytes, pairs}。
 */
export async function applyOverlayMain({ baseDoc, overlayDoc, mapping = { mode: 'oneToOne' }, options = {} }) {
  const base = await loadFreshLib(baseDoc);
  const over = await loadFreshLib(overlayDoc);
  const scale = options.scale ?? 1;
  const opacity = Math.min(1, Math.max(0.01, options.opacity ?? 1));
  const under = !!options.under;
  const offX = options.offsetX ?? 0, offY = options.offsetY ?? 0;
  const baseCount = base.getPageCount();
  const overCount = over.getPageCount();
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
  if (!pairs.length) throw Object.assign(new Error('没有有效的页面配对'), { code: 'ERR_BAD_ARGS' });
  for (const { base: bi, over: oi } of pairs) {
    const bPage = base.getPage(bi);
    const oPage = over.getPage(oi);
    const bm = pageMetaOf(bPage);
    const om = pageMetaOf(oPage);
    const emb = await base.embedPage(oPage);
    const drawW = om.visualW * scale, drawH = om.visualH * scale;
    const cVis = { vx: bm.visualW / 2 + offX, vy: bm.visualH / 2 + offY };
    const p1 = geometry.visualToUser(cVis.vx - drawW / 2, cVis.vy - drawH / 2, bm.crop, bm.rot);
    const p3 = geometry.visualToUser(cVis.vx + drawW / 2, cVis.vy + drawH / 2, bm.crop, bm.rot);
    const x = Math.min(p1.x, p3.x), y = Math.min(p1.y, p3.y);
    await drawEmbeddedWithOpacity(base, bPage, emb, {
      x, y, xScale: drawW / om.w, yScale: drawH / om.h, opacity, under,
    });
  }
  const bytes = await base.save({ useObjectStreams: true });
  return { name: `${baseName(baseDoc.name)}_叠加.pdf`, mime: 'application/pdf', bytes, pairs: pairs.length };
}

// ============================================================================
// 编辑器 UI
// ============================================================================

let styleInjected = false;
function ensureStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
.wm-editor { display: grid; grid-template-columns: minmax(0, 1fr) 370px; gap: 14px; align-items: start; }
@media (max-width: 1100px) { .wm-editor { grid-template-columns: 1fr; } }
.wm-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.wm-page-label { font-size: 13px; font-weight: 600; min-width: 86px; text-align: center; }
.wm-status { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--bg-soft, #eef1f5); color: var(--text-soft, #556); }
.wm-status[data-state="rendering"] { background: var(--primary-soft, #e8effc); color: var(--primary, #2563eb); }
.wm-status[data-state="ready"] { background: var(--ok-soft, #e5f7ec); color: var(--ok, #16803c); }
.wm-status[data-state="error"] { background: var(--no-soft, #fdeaea); color: var(--no, #c02626); }
.wm-status[data-state="draft"] { background: var(--warn-soft, #fdf3e0); color: var(--warn, #b45309); }
.wm-stage { position: relative; border: 1px solid var(--border, #d8dee8); border-radius: 10px; background:
  repeating-conic-gradient(#f4f6fa 0 25%, #ffffff 0 50%) 0 0/22px 22px;
  display: flex; justify-content: center; align-items: flex-start; min-height: 340px; padding: 14px; overflow: auto; }
.wm-stage canvas { max-width: 100%; height: auto; box-shadow: 0 2px 14px rgba(15, 23, 42, .16); background: #fff; cursor: grab; }
.wm-stage canvas:active { cursor: grabbing; }
.wm-ghost { position: absolute; pointer-events: none; border: 1.5px dashed var(--warn, #b45309); color: var(--warn, #b45309);
  display: flex; align-items: center; justify-content: center; font-weight: 700; white-space: pre; text-align: center;
  background: rgba(180, 83, 9, .07); z-index: 5; }
.wm-ghost::after { content: '（草稿）'; position: absolute; right: -2px; top: -2px; transform: translateY(-100%);
  font-size: 10.5px; background: var(--warn, #b45309); color: #fff; border-radius: 4px; padding: 1px 5px; font-weight: 600; }
.wm-layer-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.wm-layer-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--border, #d8dee8);
  border-radius: 8px; cursor: pointer; font-size: 13px; background: var(--card, #fff); }
.wm-layer-item:hover { border-color: var(--border-strong, #b9c3d3); }
.wm-layer-item.sel { border-color: var(--primary, #2563eb); background: var(--primary-soft, #e8effc); }
.wm-li-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-li-x { cursor: pointer; color: var(--muted, #8892a4); font-weight: 700; padding: 0 3px; }
.wm-li-x:hover { color: var(--no, #c02626); }
.wm-anchor-grid { display: grid; grid-template-columns: repeat(3, 40px); gap: 4px; }
.wm-anchor-btn { width: 40px; height: 30px; border: 1px solid var(--border, #d8dee8); border-radius: 6px; background: var(--card, #fff);
  cursor: pointer; font-size: 13px; color: var(--muted, #8892a4); padding: 0; }
.wm-anchor-btn:hover { border-color: var(--border-strong, #b9c3d3); }
.wm-anchor-btn.sel { border-color: var(--primary, #2563eb); background: var(--primary-soft, #e8effc); color: var(--primary, #2563eb); font-weight: 700; }
.wm-param-sec { border-top: 1px dashed var(--border, #d8dee8); margin-top: 12px; padding-top: 10px; }
.wm-sec-title { font-size: 12px; font-weight: 700; color: var(--muted, #8892a4); letter-spacing: .04em; margin-bottom: 8px; }
.wm-range-row { display: flex; align-items: center; gap: 8px; }
.wm-range-row input[type="range"] { flex: 1; }
.wm-range-val { font-size: 12px; min-width: 46px; text-align: right; color: var(--text-soft, #556); font-variant-numeric: tabular-nums; }
`;
  document.head.appendChild(st);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function defaultLayer(type) {
  const base = {
    eid: uid('wml'),
    type,
    anchor: 'mc', offsetX: 0, offsetY: 0, rotation: 0,
    placement: 'single',
    tileSpacingX: 80, tileSpacingY: 80, stagger: false, marginX: 20, marginY: 20,
    layerSide: 'over', pages: 'all', customRange: '',
    imageBytes: null, imageMime: '', imageName: '', imageScale: 0.5,
    text: '', fontId: 'auto', fontSize: 48, bold: false, align: 'center', color: '#888888', opacity: 0.35,
  };
  if (type === 'text') base.text = '水印文字';
  return base;
}

function readPresets() {
  try {
    const o = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function writePresets(o) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(o)); } catch { toast('预设保存失败（存储空间不足）', 'error'); }
}

/**
 * 创建水印编辑器
 * @param {{doc: object, page?: number, onChange?: Function, dpi?: number}} opts
 * @returns {{el: HTMLElement, getSpec: Function, getVars: Function, getPage: Function, setPage: Function, refreshPreview: Function}}
 */
export function createWatermarkEditor({ doc, page = 0, onChange = null, dpi = 110 } = {}) {
  ensureStyles();
  const state = {
    layers: [],
    selIdx: -1,
    curPage: Math.max(0, Math.floor(page) || 0),
    pageCount: 0,
    visual: { w: 595, h: 842 },
    fontAvail: {},
    vars: { date: todayStr(), time: nowTimeStr(), docName: doc.name },
  };

  // ---------- DOM 骨架 ----------
  const root = document.createElement('div');
  root.className = 'wm-editor';
  const left = document.createElement('div');
  const right = document.createElement('div');

  // 左侧：工具栏 + 画布舞台
  const toolbar = document.createElement('div');
  toolbar.className = 'wm-toolbar';
  const btnPrev = button('◀ 上一页', 'btn-outline btn-sm', () => setPage(state.curPage - 1));
  const btnNext = button('下一页 ▶', 'btn-outline btn-sm', () => setPage(state.curPage + 1));
  const pageLabel = document.createElement('span');
  pageLabel.className = 'wm-page-label';
  pageLabel.textContent = '第 – / – 页';
  const statusEl = document.createElement('span');
  statusEl.className = 'wm-status';
  statusEl.dataset.state = 'rendering';
  statusEl.textContent = '正在打开文档…';
  toolbar.append(btnPrev, pageLabel, btnNext, statusEl);

  const stage = document.createElement('div');
  stage.className = 'wm-stage';
  stage.dataset.wm = 'stage';
  const canvas = document.createElement('canvas');
  canvas.dataset.wm = 'previewCanvas';
  canvas.width = 1; canvas.height = 1;
  const ghost = document.createElement('div');
  ghost.className = 'wm-ghost';
  ghost.style.display = 'none';
  stage.append(canvas, ghost);

  left.append(toolbar, stage);

  // 右侧：图层管理 / 图层参数 / 模板变量 / 预设
  const layerCard = document.createElement('div');
  layerCard.className = 'card';
  const layerBody = document.createElement('div');
  layerBody.className = 'card-body';
  const addBtns = document.createElement('div');
  addBtns.style.cssText = 'display:flex;gap:8px';
  addBtns.append(
    button('＋ 添加文字层', 'btn-primary btn-sm', () => addLayer('text')),
    button('＋ 添加图片层', 'btn-outline btn-sm', () => addLayer('image')),
  );
  const layerList = document.createElement('div');
  layerList.className = 'wm-layer-list';
  const incompleteHint = document.createElement('div');
  incompleteHint.className = 'hint';
  incompleteHint.style.color = 'var(--warn, #b45309)';
  incompleteHint.style.display = 'none';
  layerBody.append(addBtns, layerList, incompleteHint);
  layerCard.appendChild(layerBody);

  const paramCard = document.createElement('div');
  paramCard.className = 'card';
  const paramBody = document.createElement('div');
  paramBody.className = 'card-body';
  const paramHost = document.createElement('div');
  paramBody.appendChild(paramHost);
  paramCard.appendChild(paramBody);

  const varsCard = document.createElement('div');
  varsCard.className = 'card';
  const varsBody = document.createElement('div');
  varsBody.className = 'card-body';
  const varsHint = document.createElement('div');
  varsHint.className = 'hint';
  varsHint.textContent = TEMPLATE_HINT;
  const varDate = textInput(state.vars.date);
  varDate.dataset.wm = 'varsDate';
  varDate.oninput = () => { state.vars.date = varDate.value.trim(); };
  const varTime = textInput(state.vars.time);
  varTime.dataset.wm = 'varsTime';
  varTime.oninput = () => { state.vars.time = varTime.value.trim(); };
  const varName = textInput(state.vars.docName);
  varName.dataset.wm = 'varsDocName';
  varName.oninput = () => { state.vars.docName = varName.value.trim(); };
  varsBody.append(
    varsHint,
    field('变量 {日期} 的值', varDate),
    field('变量 {时间} 的值', varTime),
    field('变量 {文件名} 的值', varName, '预览与导出使用同一组变量值'),
  );
  varsCard.appendChild(varsBody);

  const presetCard = document.createElement('div');
  presetCard.className = 'card';
  const presetBody = document.createElement('div');
  presetBody.className = 'card-body';
  const presetName = textInput('', '预设名称，如：合同密水印');
  presetName.dataset.wm = 'presetName';
  const presetSel = document.createElement('select');
  presetSel.dataset.wm = 'presetSelect';
  presetSel.style.width = '100%';
  const presetRow1 = document.createElement('div');
  presetRow1.style.cssText = 'display:flex;gap:8px';
  presetRow1.append(
    button('保存预设', 'btn-primary btn-sm', savePreset),
    button('导出 JSON', 'btn-outline btn-sm', exportPreset),
    button('导入 JSON', 'btn-outline btn-sm', importPreset),
  );
  const presetRow2 = document.createElement('div');
  presetRow2.style.cssText = 'display:flex;gap:8px;margin-top:8px;align-items:center';
  const loadBtn = button('载入', 'btn-outline btn-sm', loadPreset);
  const delBtn = button('删除预设', 'btn-ghost btn-sm', deletePreset);
  presetRow2.append(presetSel, loadBtn, delBtn);
  presetBody.append(
    field('保存当前设置为预设', presetName),
    presetRow1,
    document.createElement('div'),
    presetRow2,
  );
  presetCard.appendChild(presetBody);

  right.append(layerCard, paramCard, varsCard, presetCard);
  root.append(left, right);

  // ---------- 状态与预览 ----------
  function emitChange() {
    try { onChange?.(getSpec()); } catch { /* 回调异常不阻塞编辑 */ }
  }

  function setStatus(st, text) {
    statusEl.dataset.state = st;
    statusEl.textContent = text;
  }

  function selected() { return state.layers[state.selIdx] || null; }

  /** 内部层 → 契约 §3 spec 层（含 imageBytes；layer 字段兼容 sanitizeLayer 现实现） */
  function toSpecLayer(l) {
    const base = {
      type: l.type,
      anchor: l.anchor,
      offsetX: clamp(num(l.offsetX, 0), -2000, 2000),
      offsetY: clamp(num(l.offsetY, 0), -2000, 2000),
      rotation: clamp(num(l.rotation, 0), -180, 180),
      placement: l.placement,
      tileSpacingX: clamp(num(l.tileSpacingX, 80), 4, 1000),
      tileSpacingY: clamp(num(l.tileSpacingY, 80), 4, 1000),
      stagger: !!l.stagger,
      marginX: clamp(num(l.marginX, 20), 0, 500),
      marginY: clamp(num(l.marginY, 20), 0, 500),
      layerSide: l.layerSide === 'under' ? 'under' : 'over',
      layer: l.layerSide === 'under' ? 'under' : 'over',
      pages: l.pages,
      customRange: String(l.customRange ?? ''),
      opacity: clamp(num(l.opacity, 0.35), 0.01, 1),
    };
    if (l.type === 'text') {
      Object.assign(base, {
        text: String(l.text ?? ''),
        fontId: l.fontId || 'auto',
        fontSize: clamp(num(l.fontSize, 48), 4, 300),
        bold: !!l.bold,
        align: l.align,
        color: l.color,
      });
    } else {
      Object.assign(base, {
        imageBytes: l.imageBytes,
        imageMime: l.imageMime || '',
        imageScale: clamp(num(l.imageScale, 0.5), 0.01, 5),
        imageName: l.imageName || '',
      });
    }
    return base;
  }

  function buildSpecLayers() {
    // 图片层缺少图片数据时不能进入 spec（引擎会拒绝），由 incompleteHint 提示
    return state.layers.filter((l) => l.type !== 'image' || l.imageBytes).map(toSpecLayer);
  }

  function getSpec() { return { layers: buildSpecLayers() }; }

  function getVars() {
    return {
      docName: state.vars.docName || doc.name,
      date: state.vars.date || todayStr(),
      time: state.vars.time || nowTimeStr(),
    };
  }

  let reqVersion = 0;
  let previewTimer = null;
  let previewChain = Promise.resolve(); // 串行化预览请求

  function requestPreviewNow() {
    if (!stage.isConnected) return;
    const myVersion = ++reqVersion;
    setStatus('rendering', state.layers.length ? '预览生成中…' : '生成页面预览…');
    previewChain = previewChain.catch(() => {}).then(async () => {
      if (myVersion !== reqVersion || !stage.isConnected) return;
      try {
        // 真实预览：与导出共用 drawWatermarkLayers（见文件头说明的引擎绕过）
        const res = await composeWatermarkPreview({
          doc, page: state.curPage, spec: { layers: buildSpecLayers() }, vars: getVars(), dpi,
        });
        if (myVersion !== reqVersion || !stage.isConnected) { res.bitmap.close?.(); return; } // 过期响应丢弃
        state.visual = { w: res.visualW || 595, h: res.visualH || 842 };
        canvas.width = res.width;
        canvas.height = res.height;
        canvas.getContext('2d').drawImage(res.bitmap, 0, 0);
        try { res.bitmap.close?.(); } catch { /* noop */ }
        setStatus('ready', state.layers.length ? '预览就绪（与导出同一绘制代码）' : '预览就绪（尚未添加水印层）');
      } catch (e) {
        if (myVersion !== reqVersion) return; // 过期失败也丢弃
        setStatus('error', `预览失败：${e.message}`);
      }
    });
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(requestPreviewNow, getSettings().previewDebounceMs || 350);
  }

  function updateNav() {
    pageLabel.textContent = state.pageCount ? `第 ${state.curPage + 1} / ${state.pageCount} 页` : '第 – / – 页';
    btnPrev.disabled = !state.pageCount || state.curPage <= 0;
    btnNext.disabled = !state.pageCount || state.curPage >= state.pageCount - 1;
  }

  function setPage(n) {
    if (!state.pageCount) return;
    const next = clamp(Math.floor(n), 0, state.pageCount - 1);
    if (next === state.curPage) return;
    state.curPage = next;
    updateNav();
    requestPreviewNow();
  }

  // ---------- 图层管理 ----------
  function layerName(l) {
    if (l.type === 'text') return (String(l.text || '').split('\n')[0].trim() || '文字层').slice(0, 16);
    return l.imageName || '图片层（未选择图片）';
  }

  function refreshIncompleteHint() {
    const miss = state.layers.some((l) => l.type === 'image' && !l.imageBytes);
    incompleteHint.style.display = miss ? 'block' : 'none';
    if (miss) {
      incompleteHint.replaceChildren(iconNode('warn'), document.createTextNode(' 有图片层缺少图片数据（可能来自预设导入），请在图层参数中重新选择图片，否则该层不会被应用。'));
    }
  }

  function renderLayerList() {
    layerList.textContent = '';
    state.layers.forEach((l, i) => {
      const item = document.createElement('div');
      item.className = 'wm-layer-item' + (i === state.selIdx ? ' sel' : '');
      item.dataset.wm = 'layerItem';
      const icon = document.createElement('span');
      if (l.type === 'text') { icon.textContent = 'T'; } else { icon.replaceChildren(iconNode('image')); }
      const name = document.createElement('span');
      name.className = 'wm-li-name';
      name.textContent = layerName(l);
      item.append(icon, name);
      if (l.layerSide === 'under') {
        const b = document.createElement('span');
        b.className = 'badge badge-muted';
        b.textContent = '背景';
        item.appendChild(b);
      }
      if (l.placement === 'tile') {
        const b = document.createElement('span');
        b.className = 'badge badge-muted';
        b.textContent = '平铺';
        item.appendChild(b);
      }
      if (l.placement === 'fullscreen') {
        const b = document.createElement('span');
        b.className = 'badge badge-muted';
        b.textContent = `全屏×${l.density ?? 4}`;
        item.appendChild(b);
      }
      if (l.type === 'image' && !l.imageBytes) {
        const b = document.createElement('span');
        b.className = 'badge badge-warn';
        b.textContent = '缺图片';
        item.appendChild(b);
      }
      const x = document.createElement('span');
      x.className = 'wm-li-x';
      x.textContent = '✕';
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', `删除图层 ${layerName(l)}`);
      x.onclick = (e) => { e.stopPropagation(); removeLayer(i); };
      item.appendChild(x);
      item.onclick = () => { state.selIdx = i; renderLayerList(); buildParamPanel(); };
      layerList.appendChild(item);
    });
    refreshIncompleteHint();
  }

  function addLayer(type) {
    state.layers.push(defaultLayer(type));
    state.selIdx = state.layers.length - 1;
    renderLayerList();
    buildParamPanel();
    schedulePreview();
    emitChange();
  }

  function removeLayer(i) {
    state.layers.splice(i, 1);
    if (state.selIdx >= state.layers.length) state.selIdx = state.layers.length - 1;
    renderLayerList();
    buildParamPanel();
    schedulePreview();
    emitChange();
  }

  // ---------- 图层参数面板 ----------
  let offsetXInput = null;
  let offsetYInput = null;
  let fontHintEl = null;

  function bindCommon(l) {
    const onSpec = () => { schedulePreview(); emitChange(); };

    // 锚点九宫格
    const anchorWrap = document.createElement('div');
    const anchorTitle = document.createElement('div');
    anchorTitle.className = 'wm-sec-title';
    anchorTitle.textContent = '定位（锚点 + 偏移，单位 pt）';
    const grid = document.createElement('div');
    grid.className = 'wm-anchor-grid';
    for (const a of ANCHORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wm-anchor-btn' + (l.anchor === a ? ' sel' : '');
      b.dataset.anchor = a;
      b.textContent = '●';
      b.title = ANCHOR_NAMES[a];
      b.setAttribute('aria-label', `锚点 ${ANCHOR_NAMES[a]}`);
      b.onclick = () => {
        l.anchor = a;
        grid.querySelectorAll('.wm-anchor-btn').forEach((x) => x.classList.toggle('sel', x.dataset.anchor === a));
        onSpec();
      };
      grid.appendChild(b);
    }
    const anchorRow = document.createElement('div');
    anchorRow.style.cssText = 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap';
    anchorRow.append(grid, (() => {
      const d = document.createElement('div');
      d.style.flex = '1';
      d.style.minWidth = '150px';
      offsetXInput = numberInput(l.offsetX, { min: -2000, max: 2000, step: 1 });
      offsetXInput.dataset.wm = 'offsetX';
      offsetYInput = numberInput(l.offsetY, { min: -2000, max: 2000, step: 1 });
      offsetYInput.dataset.wm = 'offsetY';
      offsetXInput.oninput = () => { l.offsetX = num(offsetXInput.value, 0); onSpec(); };
      offsetYInput.oninput = () => { l.offsetY = num(offsetYInput.value, 0); onSpec(); };
      d.append(
        field('水平偏移（右为正）', offsetXInput),
        field('垂直偏移（下为正）', offsetYInput),
      );
      return d;
    })());
    anchorWrap.append(anchorTitle, anchorRow);

    // 旋转
    const rotVal = document.createElement('span');
    rotVal.className = 'wm-range-val';
    rotVal.textContent = `${Math.round(l.rotation)}°`;
    const rot = document.createElement('input');
    rot.type = 'range'; rot.min = '-180'; rot.max = '180'; rot.step = '1'; rot.value = String(Math.round(l.rotation));
    rot.dataset.wm = 'rotation';
    rot.oninput = () => { l.rotation = num(rot.value, 0); rotVal.textContent = `${Math.round(l.rotation)}°`; onSpec(); };
    const rotRow = document.createElement('div');
    rotRow.className = 'wm-range-row';
    rotRow.append(rot, rotVal);

    // 平铺 / 位置方式
    const placeWrap = document.createElement('div');
    const placeTitle = document.createElement('div');
    placeTitle.className = 'wm-sec-title';
    placeTitle.textContent = '平铺方式';
    const placeRow = document.createElement('div');
    placeRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap';
    for (const [val, label] of [['single', '单个'], ['tile', '平铺'], ['diagonal', '对角线'], ['fullscreen', '全屏铺满']]) {
      const lab = document.createElement('label');
      lab.className = 'checkbox-row';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'wmplacement';
      r.value = val;
      r.checked = l.placement === val;
      r.dataset.wm = 'placement';
      r.onchange = () => { if (r.checked) { l.placement = val; syncPlaceVis(); onSpec(); } };
      const s = document.createElement('span');
      s.textContent = label;
      lab.append(r, s);
      placeRow.appendChild(lab);
    }
    const staggerCb = checkbox('奇偶行交错（stagger）', l.stagger);
    staggerCb._input.dataset.wm = 'stagger';
    staggerCb._input.onchange = () => { l.stagger = staggerCb._input.checked; onSpec(); };
    // 全屏密度：每行列数（行数按页面纵横比自动推得）
    const densIn = numberInput(l.density ?? 4, { min: 1, max: 16, step: 1 });
    densIn.dataset.wm = 'density';
    densIn.oninput = () => { l.density = num(densIn.value, 4); onSpec(); };
    const densRow = document.createElement('div');
    densRow.className = 'field-row';
    densRow.append(field('全屏密度（横向列数，行数自动）', densIn));
    const syncPlaceVis = () => {
      const fs = l.placement === 'fullscreen';
      densRow.style.display = fs ? '' : 'none';
      spRow.style.display = fs ? 'none' : '';
      mgRow.style.display = fs ? 'none' : '';
    };
    const spX = numberInput(l.tileSpacingX, { min: 4, max: 1000, step: 1 });
    spX.dataset.wm = 'tileSpacingX';
    const spY = numberInput(l.tileSpacingY, { min: 4, max: 1000, step: 1 });
    spY.dataset.wm = 'tileSpacingY';
    spX.oninput = () => { l.tileSpacingX = num(spX.value, 80); onSpec(); };
    spY.oninput = () => { l.tileSpacingY = num(spY.value, 80); onSpec(); };
    const spRow = document.createElement('div');
    spRow.className = 'field-row';
    spRow.append(field('平铺间距 X（pt）', spX), field('平铺间距 Y（pt）', spY));
    const mgX = numberInput(l.marginX, { min: 0, max: 500, step: 1 });
    mgX.dataset.wm = 'marginX';
    const mgY = numberInput(l.marginY, { min: 0, max: 500, step: 1 });
    mgY.dataset.wm = 'marginY';
    mgX.oninput = () => { l.marginX = num(mgX.value, 20); onSpec(); };
    mgY.oninput = () => { l.marginY = num(mgY.value, 20); onSpec(); };
    const mgRow = document.createElement('div');
    mgRow.className = 'field-row';
    mgRow.append(field('页边距 X（pt）', mgX), field('页边距 Y（pt）', mgY));
    placeWrap.append(placeTitle, placeRow, staggerCb, densRow, spRow, mgRow);
    syncPlaceVis();

    // 层级 / 页范围
    const sideSel = select(
      [{ value: 'over', label: '前景（页面内容上方）' }, { value: 'under', label: '背景（页面内容下方）' }],
      l.layerSide,
    );
    sideSel.dataset.wm = 'layerSide';
    sideSel.onchange = () => { l.layerSide = sideSel.value; renderLayerList(); onSpec(); };
    const pagesSel = select(
      [
        { value: 'all', label: '全部页' },
        { value: 'odd', label: '奇数页（1、3…）' },
        { value: 'even', label: '偶数页（2、4…）' },
        { value: 'custom', label: '自定义范围' },
      ],
      l.pages,
    );
    pagesSel.dataset.wm = 'pages';
    const rangeInput = textInput(l.customRange, '示例：1-3,5');
    rangeInput.dataset.wm = 'customRange';
    rangeInput.oninput = () => { l.customRange = rangeInput.value.trim(); onSpec(); };
    const rangeField = field('自定义页范围（1 基）', rangeInput);
    rangeField.style.display = l.pages === 'custom' ? '' : 'none';
    pagesSel.onchange = () => { l.pages = pagesSel.value; rangeField.style.display = l.pages === 'custom' ? '' : 'none'; onSpec(); };

    const sec3 = document.createElement('div');
    sec3.className = 'wm-param-sec';
    sec3.append(
      field('水印层级', sideSel),
      field('应用页范围', pagesSel),
      rangeField,
    );
    return { anchorWrap, rotRow, placeWrap, sec3 };
  }

  function updateFontHint(l) {
    if (!fontHintEl) return;
    const cjk = CJK_RE.test(l.text || '');
    if (cjk && l.fontId !== 'auto' && l.fontId !== 'noto-sc') {
      fontHintEl.replaceChildren(iconNode('warn'), document.createTextNode(' 文字包含中文：所选字体不含中文字形，导出会失败。建议选择「自动」或「思源黑体（中英文）」。'));
    } else if ((l.fontId === 'auto' || l.fontId === 'noto-sc') && state.fontAvail['noto-sc'] === false) {
      fontHintEl.replaceChildren(iconNode('warn'), document.createTextNode(' 中文字体文件不可用（站点缺少 public/fonts/NotoSansSC），中文水印将无法渲染，请联系部署方补充字体包。'));
    } else if ((l.fontId === 'auto' || l.fontId === 'noto-sc') && state.fontAvail['noto-sc'] == null) {
      fontHintEl.textContent = '中文字体可用性检测中…';
    } else {
      fontHintEl.textContent = '';
    }
  }

  function buildParamPanel() {
    paramHost.textContent = '';
    offsetXInput = null; offsetYInput = null; fontHintEl = null;
    const l = selected();
    if (!l) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<div class="icon"></div>尚未添加水印层<br>点击上方「添加文字层 / 添加图片层」开始';
      empty.querySelector('.icon').appendChild(iconNode('watermark'));
      paramHost.appendChild(empty);
      return;
    }
    const head = document.createElement('div');
    head.className = 'wm-sec-title';
    head.textContent = l.type === 'text' ? '文字层参数' : '图片层参数';
    paramHost.appendChild(head);

    if (l.type === 'text') {
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.value = l.text;
      ta.dataset.wm = 'text';
      ta.placeholder = '支持多行；可插入变量，如：绝密 {页码} / {总页数}';
      ta.oninput = () => { l.text = ta.value; renderLayerList(); updateFontHint(l); schedulePreview(); emitChange(); };
      paramHost.appendChild(field('水印文字（支持多行与变量）', ta));

      fontHintEl = document.createElement('div');
      fontHintEl.className = 'hint';
      fontHintEl.style.marginBottom = '10px';

      const fontSel = select(
        [
          { value: 'auto', label: '自动（按内容选择）' },
          ...BUILTIN_FONTS.map((f) => ({ value: f.id, label: f.name })),
          ...FONTS.map((f) => ({ value: f.id, label: f.name })),
        ],
        l.fontId,
      );
      fontSel.dataset.wm = 'fontId';
      fontSel.onchange = () => { l.fontId = fontSel.value; updateFontHint(l); schedulePreview(); emitChange(); };
      paramHost.append(field('字体', fontSel), fontHintEl);
      updateFontHint(l);

      const size = numberInput(l.fontSize, { min: 4, max: 300, step: 1 });
      size.dataset.wm = 'fontSize';
      size.oninput = () => { l.fontSize = num(size.value, 48); schedulePreview(); emitChange(); };
      const color = document.createElement('input');
      color.type = 'color';
      color.value = /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '#888888';
      color.dataset.wm = 'color';
      color.oninput = () => { l.color = color.value; schedulePreview(); emitChange(); };
      const opVal = document.createElement('span');
      opVal.className = 'wm-range-val';
      opVal.textContent = `${Math.round(l.opacity * 100)}%`;
      const op = document.createElement('input');
      op.type = 'range'; op.min = '0'; op.max = '100'; op.step = '1';
      op.value = String(Math.round(l.opacity * 100));
      op.dataset.wm = 'opacity';
      op.oninput = () => {
        l.opacity = clamp(num(op.value, 35) / 100, 0.01, 1);
        opVal.textContent = `${Math.round(op.value)}%`;
        schedulePreview(); emitChange();
      };
      const opRow = document.createElement('div');
      opRow.className = 'wm-range-row';
      opRow.append(op, opVal);
      const boldCb = checkbox('粗体', l.bold);
      boldCb._input.dataset.wm = 'bold';
      boldCb._input.onchange = () => { l.bold = boldCb._input.checked; schedulePreview(); emitChange(); };
      const alignSel = select(
        [{ value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' }],
        l.align,
      );
      alignSel.dataset.wm = 'align';
      alignSel.onchange = () => { l.align = alignSel.value; schedulePreview(); emitChange(); };
      const rowSC = document.createElement('div');
      rowSC.className = 'field-row';
      rowSC.append(field('对齐（多行时）', alignSel), (() => { const d = document.createElement('div'); d.style.alignSelf = 'end'; d.appendChild(boldCb); return d; })());
      paramHost.append(
        field('字号（pt）', size),
        field('颜色', color),
        field('透明度', opRow),
        rowSC,
      );
    } else {
      const nameEl = document.createElement('div');
      nameEl.className = 'hint';
      nameEl.dataset.wm = 'imageName';
      nameEl.textContent = l.imageBytes
        ? `已选择：${l.imageName}（${fmtBytes(l.imageBytes.byteLength)}）`
        : '未选择图片';
      const pickBtn = button(l.imageBytes ? '重新选择图片' : '选择图片', 'btn-primary btn-sm', async () => {
        const files = await pickFiles({
          multiple: false,
          accept: 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif',
        });
        if (!files.length) return;
        const f = files[0];
        const buf = await f.arrayBuffer();
        l.imageBytes = new Uint8Array(buf);
        l.imageMime = f.type || (/\.jpe?g$/i.test(f.name) ? 'image/jpeg' : 'image/png');
        l.imageName = f.name;
        nameEl.textContent = `已选择：${f.name}（${fmtBytes(f.size)}）`;
        pickBtn.textContent = '重新选择图片';
        renderLayerList();
        schedulePreview();
        emitChange();
      });
      const scale = numberInput(l.imageScale, { min: 0.01, max: 5, step: 0.05 });
      scale.dataset.wm = 'imageScale';
      scale.oninput = () => { l.imageScale = num(scale.value, 0.5); schedulePreview(); emitChange(); };
      paramHost.append(
        (() => { const d = document.createElement('div'); d.append(pickBtn, nameEl); return d; })(),
        field('图片宽度占页面宽度的比例', scale, '高度按图片原始比例自动换算'),
      );
    }

    const common = bindCommon(l);
    const sec2 = document.createElement('div');
    sec2.className = 'wm-param-sec';
    sec2.append(common.anchorWrap, field('旋转（°，视觉逆时针）', common.rotRow), common.placeWrap);
    paramHost.append(sec2, common.sec3);
  }

  // ---------- 预设 ----------
  function serializeSpec() {
    // localStorage / JSON 导出不携带图片字节：图片层保留元信息，载入后需重新选择图片
    return {
      savedAt: new Date().toISOString(),
      layers: state.layers.map((l) => {
        const s = toSpecLayer(l);
        if (s.type === 'image') {
          s.imageBytes = null;
          s._needsImage = true;
        }
        return s;
      }),
    };
  }

  function normalizeImportedLayer(raw) {
    const type = raw.type === 'image' ? 'image' : 'text';
    const l = defaultLayer(type);
    if (type === 'text') {
      l.text = String(raw.text ?? '');
      l.fontId = String(raw.fontId || 'auto');
      l.fontSize = clamp(num(raw.fontSize, 48), 4, 300);
      l.bold = !!raw.bold;
      l.align = ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center';
      l.color = /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : '#888888';
    } else {
      l.imageScale = clamp(num(raw.imageScale, 0.5), 0.01, 5);
      l.imageMime = String(raw.imageMime || '');
      l.imageName = String(raw.imageName || '');
      l.imageBytes = raw.imageBytes instanceof Uint8Array ? raw.imageBytes : null;
    }
    l.opacity = clamp(num(raw.opacity, 0.35), 0.01, 1);
    l.anchor = ANCHORS.includes(raw.anchor) ? raw.anchor : 'mc';
    l.offsetX = clamp(num(raw.offsetX, 0), -2000, 2000);
    l.offsetY = clamp(num(raw.offsetY, 0), -2000, 2000);
    l.rotation = clamp(num(raw.rotation, 0), -180, 180);
    l.placement = ['single', 'tile', 'diagonal'].includes(raw.placement) ? raw.placement : 'single';
    l.tileSpacingX = clamp(num(raw.tileSpacingX, 80), 4, 1000);
    l.tileSpacingY = clamp(num(raw.tileSpacingY, 80), 4, 1000);
    l.stagger = !!raw.stagger;
    l.marginX = clamp(num(raw.marginX, 20), 0, 500);
    l.marginY = clamp(num(raw.marginY, 20), 0, 500);
    l.layerSide = (raw.layerSide === 'under' || raw.layer === 'under') ? 'under' : 'over';
    l.pages = ['all', 'odd', 'even', 'custom'].includes(raw.pages) ? raw.pages : 'all';
    l.customRange = String(raw.customRange ?? '');
    return l;
  }

  function importLayers(data) {
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.layers) ? data.layers : null);
    if (!arr || !arr.length) throw new Error('预设格式不正确：应为 { layers: [...] } 或图层数组');
    return arr.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new Error(`预设第 ${i + 1} 层无效`);
      if (raw.type === 'text' && !String(raw.text ?? '').trim()) throw new Error(`预设第 ${i + 1} 层（文字层）内容为空`);
      return normalizeImportedLayer(raw);
    });
  }

  function applyLayers(layers) {
    state.layers = layers;
    state.selIdx = layers.length ? layers.length - 1 : -1;
    renderLayerList();
    buildParamPanel();
    schedulePreview();
    emitChange();
  }

  function savePreset() {
    const name = presetName.value.trim();
    if (!name) { toast('请先输入预设名称', 'error'); return; }
    const presets = readPresets();
    presets[name] = serializeSpec();
    writePresets(presets);
    refreshPresetSelect();
    presetSel.value = name;
    toast(`预设「${name}」已保存`);
  }

  function loadPreset() {
    const name = presetSel.value;
    if (!name) { toast('请先选择要载入的预设', 'error'); return; }
    try {
      const layers = importLayers(readPresets()[name]);
      applyLayers(layers);
      presetName.value = name;
      toast(`预设「${name}」已载入`);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function deletePreset() {
    const name = presetSel.value;
    if (!name) { toast('请先选择要删除的预设', 'error'); return; }
    const presets = readPresets();
    delete presets[name];
    writePresets(presets);
    refreshPresetSelect();
    toast(`预设「${name}」已删除`);
  }

  function exportPreset() {
    if (!state.layers.length) { toast('当前没有水印层可导出', 'error'); return; }
    const bytes = new TextEncoder().encode(JSON.stringify(serializeSpec(), null, 2));
    downloadArtifact({ name: '水印预设.json', mime: 'application/json', bytes });
  }

  async function importPreset() {
    const files = await pickFiles({ multiple: false, accept: '.json,application/json' });
    if (!files.length) return;
    try {
      const text = await files[0].text();
      const data = JSON.parse(text); // 校验失败 → toast 提示
      const layers = importLayers(data);
      applyLayers(layers);
      toast(`已导入 ${layers.length} 个水印层`);
    } catch (e) {
      toast(e.name === 'SyntaxError' ? 'JSON 解析失败：文件不是有效的预设' : e.message, 'error');
    }
  }

  function refreshPresetSelect() {
    presetSel.textContent = '';
    presetSel.add(new Option('— 选择预设 —', ''));
    for (const k of Object.keys(readPresets())) presetSel.add(new Option(k, k));
  }
  refreshPresetSelect();

  // ---------- 画布拖动（草稿反馈 → 松手触发真实预览） ----------
  let drag = null;

  function showGhost(l, ox, oy) {
    const rect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const a = anchorPoint(l.anchor, state.visual.w, state.visual.h);
    const px = (a.vx + ox) / state.visual.w * rect.width + (rect.left - stageRect.left) + stage.scrollLeft;
    const py = (a.vy + oy) / state.visual.h * rect.height + (rect.top - stageRect.top) + stage.scrollTop;
    const scale = rect.width / state.visual.w;
    ghost.style.display = 'flex';
    ghost.style.left = `${px}px`;
    ghost.style.top = `${py}px`;
    ghost.style.transform = 'translate(-50%, -50%)';
    if (l.type === 'text') {
      const lines = String(l.text || '水印文字').split('\n');
      ghost.textContent = lines[0] || '水印文字';
      ghost.style.fontSize = `${Math.max(11, Math.min(64, l.fontSize * scale))}px`;
      ghost.style.padding = '2px 6px';
    } else {
      ghost.replaceChildren(iconNode('image'), document.createTextNode(' 图片水印'));
      ghost.style.fontSize = '13px';
      ghost.style.padding = '6px 10px';
    }
  }

  function hideGhost() { ghost.style.display = 'none'; }

  canvas.addEventListener('mousedown', (e) => {
    const l = selected();
    if (!l || !state.visual.w || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    drag = {
      startX: e.clientX, startY: e.clientY,
      baseX: num(l.offsetX, 0), baseY: num(l.offsetY, 0),
      moved: false, rect, layer: l,
    };
    e.preventDefault();
  });

  function onDragMove(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / drag.rect.width * state.visual.w;
    const dy = (e.clientY - drag.startY) / drag.rect.height * state.visual.h;
    if (!drag.moved && Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 3) return;
    drag.moved = true;
    const nx = clamp(drag.baseX + dx, -2000, 2000);
    const ny = clamp(drag.baseY + dy, -2000, 2000);
    if (offsetXInput) offsetXInput.value = String(Math.round(nx));
    if (offsetYInput) offsetYInput.value = String(Math.round(ny));
    showGhost(drag.layer, nx, ny);
    setStatus('draft', `拖动中（草稿 Δ${Math.round(dx) >= 0 ? '+' : ''}${Math.round(dx)}, ${Math.round(dy) >= 0 ? '+' : ''}${Math.round(dy)}pt）— 松手后更新真实预览`);
  }

  function onDragUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    hideGhost();
    if (!d.moved) return;
    d.layer.offsetX = clamp(num(offsetXInput?.value, d.baseX), -2000, 2000);
    d.layer.offsetY = clamp(num(offsetYInput?.value, d.baseY), -2000, 2000);
    emitChange();
    requestPreviewNow(); // 松手立即触发真实预览（与导出同一绘制路径）
  }
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);

  // ---------- 初始化：读取文档信息（页数） + 探测中文字体可用性 ----------
  updateNav();
  buildParamPanel();
  readDocInfo(doc).then((info) => {
    if (!stage.isConnected) return;
    state.pageCount = info.pageCount || 0;
    updateNav();
    requestPreviewNow();
  }).catch((e) => {
    if (stage.isConnected) setStatus('error', `打开文档失败：${e.message}`);
  });
  probeFonts().then((m) => {
    state.fontAvail = m || {};
    const l = selected();
    if (l) updateFontHint(l);
  }).catch(() => { state.fontAvail = { 'noto-sc': false }; });

  return {
    el: root,
    getSpec,
    getVars,
    getPage: () => state.curPage,
    setPage,
    refreshPreview: requestPreviewNow,
  };
}
