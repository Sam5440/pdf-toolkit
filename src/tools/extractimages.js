// 提取图片 — 提取 PDF 内嵌原始图像（与页面渲染截图不同），支持 SMask 合成透明
// 引擎 images.extract 仅支持 DCTDecode/FlateDecode；对"未压缩图像流"（无 Filter）
// 会抛「不支持的过滤器」导致 0 产物（引擎缺陷，已在最终报告记录）。
// 本工具内置 fallback 解码器绕过：引擎返回空产物时在主线程二次提取。
import { iconNode } from '../components/icons.js';
import { PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import { inflate } from 'fflate';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import {
  progressCard, warningsBox, toast, field, textInput, button,
} from '../components/ui.js';
import { fmtBytes } from '../core/format.js';
import { buildOutputName, paramsToken } from '../core/naming.js';
import { parsePageRange } from '../core/pagerange.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact, downloadZip } from '../core/download.js';

registerTool({
  id: 'extractimages',
  name: '提取图片',
  group: 'convert',
  desc: '提取 PDF 内嵌图像（区分原图提取与页面渲染）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择单个 PDF，提取其中内嵌的原始图像',
      onAdd(added) {
        if (added.length) state.doc = added[added.length - 1];
      },
    });

    // 顶部说明
    const infoAlert = document.createElement('div');
    infoAlert.className = 'alert alert-info';
    infoAlert.style.marginTop = '14px';
    infoAlert.innerHTML = '<b>说明</b><br>提取的是 PDF 内嵌原始图像，与"页面截图"不同：需要整页渲染请使用「PDF 转图片」。合成透明模式会把 SMask 透明通道叠加为 PNG alpha。';

    // ---- 参数 ----
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const pagesInp = textInput('', '如 1-3,5（留空=全部页）');
    body.appendChild(field('页范围', pagesInp, '留空 = 全部页；支持 1-3,5、odd、even'));

    const modeWrap = document.createElement('div');
    modeWrap.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap';
    const radios = [];
    const MODES = [
      { value: 'composite', label: '合成透明（叠加 SMask，输出 PNG）' },
      { value: 'raw', label: '原样输出（不合成，JPEG 仍为 JPG）' },
    ];
    MODES.forEach((m, i) => {
      const l = document.createElement('label');
      l.className = 'checkbox-row';
      const c = document.createElement('input');
      c.type = 'radio';
      c.name = 'extract-mode';
      c.value = m.value;
      c.checked = i === 0;
      const s = document.createElement('span');
      s.textContent = m.label;
      l.append(c, s);
      modeWrap.appendChild(l);
      radios.push(c);
    });
    body.appendChild(field('提取模式', modeWrap));
    controls.appendChild(body);

    // ---- 执行 ----
    const goBtn = button('开始提取', 'btn-primary', () => doExtract());
    goBtn.style.cssText = 'width:100%;margin-top:14px';

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(panel.el, infoAlert, controls, goBtn, resultBox);

    async function doExtract() {
      resultBox.innerHTML = '';
      const doc = state.doc;
      if (!doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const mode = radios.find((r) => r.checked)?.value || 'composite';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      const t0 = Date.now();
      try {
        let res = await run('images.extract', {
          docId: doc.id,
          pages: pagesInp.value.trim() || 'all',
          mode,
        }, {
          trayFolder: `提取图片 · ${doc.name.replace(/\.pdf$/i, '')}`,
          onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 0, p.stage || '提取中…'),
        }, new Map([[doc.id, doc]]));
        let usedFallback = false;
        if (!res.artifacts?.length) {
          // 引擎 0 产物 → 内置兼容提取器绕过（未压缩图像流等引擎暂不支持的情况）
          pc.indeterminate('使用兼容提取器…');
          const fb = await fallbackExtract(doc.file, {
            pages: pagesInp.value.trim() || 'all',
            mode,
            name: doc.name,
          });
          if (fb.artifacts.length) {
            usedFallback = true;
            res = {
              ...res,
              artifacts: fb.artifacts,
              warnings: [...(res.warnings || []),
                ...fb.warnings,
                '引擎无法解码部分图像流，以下产物由内置兼容提取器生成'],
              summary: { ...res.summary, found: fb.artifacts.length, skipped: (res.summary?.skipped ?? 0) + (fb.summary?.skipped ?? 0) },
            };
          } else {
            res = { ...res, warnings: [...(res.warnings || []), ...fb.warnings] };
          }
        }
        pc.done();
        renderResult(res, doc, mode, Date.now() - t0, usedFallback);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
      }
    }

    function renderResult(res, doc, mode, ms, usedFallback) {
      const arts = res.artifacts || [];
      const card = document.createElement('div');
      card.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';

      const w = warningsBox(res.warnings);
      if (w) ib.appendChild(w);

      if (!arts.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.style.padding = '26px 0';
        const icon = document.createElement('div');
        icon.className = 'icon';
        icon.replaceChildren(iconNode('extractimages'));
        const t1 = document.createElement('div');
        t1.style.fontWeight = '600';
        t1.textContent = '未发现可提取的嵌入图像';
        const t2 = document.createElement('div');
        t2.className = 'note';
        t2.textContent = '所选页面没有位图图像对象（纯矢量/纯文本页面无内嵌图像），或图像格式暂不支持提取。';
        empty.append(icon, t1, t2);
        ib.appendChild(empty);
        card.appendChild(ib);
        resultBox.appendChild(card);
        return;
      }

      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.appendChild(iconNode('success'));
      kv.appendChild(document.createTextNode(` 提取完成：${arts.length} 张图像（跳过 ${res.summary?.skipped ?? 0}） · 模式 ${mode === 'raw' ? '原样输出' : '合成透明'}${usedFallback ? ' · 兼容提取器' : ''} · 用时 ${Math.round(ms / 100) / 10}s`));
      ib.appendChild(kv);

      for (const art of arts) {
        const line = document.createElement('div');
        line.className = 'result-artifact';
        const ico = document.createElement('span');
        ico.className = 'ra-ico';
        ico.replaceChildren(iconNode('image'));
        const info = document.createElement('div');
        info.className = 'ra-info';
        const nm = document.createElement('div');
        nm.className = 'ra-name';
        nm.textContent = art.name;
        const mt = document.createElement('div');
        mt.className = 'ra-meta';
        const meta = art.meta || {};
        const pageTxt = meta.page != null ? `来源第 ${meta.page + 1} 页` : '来源页未知';
        const dimTxt = meta.width && meta.height ? ` · ${meta.width}×${meta.height}` : '';
        mt.textContent = `${pageTxt}${dimTxt} · ${fmtBytes(art.bytes.byteLength)}`;
        info.append(nm, mt);
        line.append(ico, info);
        line.appendChild(button('下载', 'btn-outline btn-sm', () => downloadArtifact(art)));
        ib.appendChild(line);
      }

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      actions.append(
        button('ZIP 打包下载', 'btn-primary', () => downloadZip(arts, 'extract-out.zip')),
        button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'extractimages', toolName: '提取图片',
            docNames: [doc.name],
            options: { pages: pagesInp.value.trim() || 'all', mode },
            outputs: arts.map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.byteLength, blob: new Blob([a.bytes], { type: a.mime }) })),
          });
          toast('已保存到历史');
        }),
      );
      ib.appendChild(actions);
      card.appendChild(ib);
      resultBox.appendChild(card);
    }
  },
});

// ---------------------------------------------------------------------------
// 内置兼容提取器（主线程 fallback）：覆盖引擎 decodeImageXObject 不支持的
// 「无 Filter 未压缩图像流」，并按数据长度推断色彩组件数。
// ---------------------------------------------------------------------------

/** 主线程 canvas 导出 Blob（OffscreenCanvas.convertToBlob / HTMLCanvasElement.toBlob 兼容） */
function canvasToBlob(canvas, type = 'image/png') {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出失败'))), type));
}

function dictNum(dict, key) {  const v = dict.get(PDFName.of(key));
  if (v == null) return null;
  const n = typeof v === 'object' && 'asNumber' in v ? v.asNumber() : Number(v.toString?.() ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function dictFilters(dict) {
  const filter = dict.get(PDFName.of('Filter'));
  if (!filter) return [];
  return filter.toString().startsWith('[')
    ? filter.asArray().map((f) => f.toString())
    : [filter.toString()];
}

/** 解码灰度（SMask）流 → {data, w, h}（未压缩或 Flate，按长度截断） */
function decodeGrayLoose(obj) {
  const dict = obj.dict;
  const w = dictNum(dict, 'Width');
  const h = dictNum(dict, 'Height');
  if (!w || !h) throw new Error('SMask 尺寸异常');
  const filters = dictFilters(dict);
  let raw = obj.getContents();
  if (filters.includes('/FlateDecode')) raw = inflate(raw);
  else if (filters.length) throw new Error('SMask 过滤器不支持');
  if (raw.byteLength < w * h) throw new Error('SMask 数据不完整');
  const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, w * h);
  return { data, w, h };
}

/** DCT + SMask 合成（引擎 composeSMask 的宽松版） */
async function composeSMaskLoose(doc, dict, jpegBytes, w, h, warnings) {
  const smRef = dict.get(PDFName.of('SMask'));
  if (!(smRef instanceof PDFRef)) return null;
  const smObj = doc.context.lookup(smRef);
  if (!(smObj instanceof PDFRawStream)) return null;
  let smaskData;
  try { smaskData = decodeGrayLoose(smObj); } catch { return null; }
  if (smaskData.w !== w || smaskData.h !== h) return null;
  const bmp = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const im = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) im.data[i * 4 + 3] = smaskData.data[i];
  ctx.putImageData(im, 0, 0);
  const blob = await canvasToBlob(canvas);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h };
}

/** 宽松解码图像 XObject → {bytes, mime, width, height} */
async function decodeImageLoose(doc, obj, composite, warnings) {
  const dict = obj.dict;
  const w = dictNum(dict, 'Width');
  const h = dictNum(dict, 'Height');
  const bpc = dictNum(dict, 'BitsPerComponent') || 8;
  if (!w || !h || w > 30000 || h > 30000) throw new Error('尺寸异常');
  const filters = dictFilters(dict);
  const contents = obj.getContents();

  if (filters.length === 1 && filters[0] === '/DCTDecode') {
    if (composite && dict.get(PDFName.of('SMask'))) {
      const sm = await composeSMaskLoose(doc, dict, contents, w, h, warnings);
      if (sm) return sm;
    }
    return { bytes: contents, mime: 'image/jpeg', width: w, height: h };
  }
  if (filters.length > 1) throw new Error('多重过滤器暂不支持');

  let raw = contents;
  if (filters.length === 1 && filters[0] === '/FlateDecode') {
    try { raw = inflate(contents); } catch { throw new Error('数据解压失败'); }
    const parms = dict.get(PDFName.of('DecodeParms'));
    if (parms) {
      const pd = parms instanceof PDFRef ? doc.context.lookup(parms) : parms;
      const pv = pd && typeof pd.get === 'function' ? Number(pd.get(PDFName.of('Predictor'))?.toString() || 1) : 1;
      if (pv >= 10) throw new Error('PNG predictor 请由引擎处理');
    }
  } else if (filters.length === 0) {
    // 未压缩原始像素（引擎缺陷绕过路径）
  } else if (filters.length) {
    throw new Error(`不支持的过滤器 ${filters.join(',')}`);
  }
  if (bpc !== 8) throw new Error('非 8 位深暂不支持');

  const px = w * h;
  const comps = Math.round(raw.byteLength / px);
  if (![1, 3, 4].includes(comps) || comps * px > raw.byteLength) {
    throw new Error('无法按数据长度推断色彩组件数');
  }
  let alpha = null;
  if (composite) {
    const smRef = dict.get(PDFName.of('SMask'));
    if (smRef instanceof PDFRef) {
      const smObj = doc.context.lookup(smRef);
      if (smObj instanceof PDFRawStream) {
        try { alpha = decodeGrayLoose(smObj); } catch { warnings.push('SMask 解码失败，按不透明处理'); }
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const im = ctx.createImageData(w, h);
  const d = im.data;
  for (let i = 0; i < px; i++) {
    if (comps === 1) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = raw[i]; } else if (comps === 3) {
      d[i * 4] = raw[i * 3]; d[i * 4 + 1] = raw[i * 3 + 1]; d[i * 4 + 2] = raw[i * 3 + 2];
    } else {
      const c = raw[i * 4], m = raw[i * 4 + 1], y = raw[i * 4 + 2], k = raw[i * 4 + 3];
      d[i * 4] = 255 - Math.min(255, c + k);
      d[i * 4 + 1] = 255 - Math.min(255, m + k);
      d[i * 4 + 2] = 255 - Math.min(255, y + k);
    }
    d[i * 4 + 3] = alpha && alpha.w === w && alpha.h === h ? alpha.data[i] : 255;
  }
  ctx.putImageData(im, 0, 0);
  const blob = await canvasToBlob(canvas);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h };
}

/** 页资源中的图像 ref 键（含 Parent 继承） */
function pageImageRefsLoose(doc, page) {
  const out = new Set();
  let node = page.node;
  let depth = 0;
  while (node && depth < 32) {
    const res = node.get(PDFName.of('Resources'));
    const resDict = res instanceof PDFRef ? doc.context.lookup(res) : res;
    if (resDict && typeof resDict.get === 'function') {
      const xo = resDict.get(PDFName.of('XObject'));
      const xoDict = xo instanceof PDFRef ? doc.context.lookup(xo) : xo;
      if (xoDict && typeof xoDict.entries === 'function') {
        for (const [, v] of xoDict.entries()) {
          const ref = v instanceof PDFRef ? v : null;
          if (!ref) continue;
          const obj = doc.context.lookup(ref);
          if (obj instanceof PDFRawStream) {
            const sub = obj.dict.get(PDFName.of('Subtype'));
            if (sub && sub.toString() === '/Image') out.add(ref.toString());
          }
        }
      }
    }
    const parent = node.get(PDFName.of('Parent'));
    node = parent instanceof PDFRef ? doc.context.lookup(parent) : null;
    depth++;
  }
  return out;
}

/**
 * 兼容提取器：在主线程直接解析 PDF，提取引擎不支持解码的图像。
 * @returns {Promise<{artifacts:Array, warnings:string[], summary:object}>}
 */
async function fallbackExtract(file, { pages, mode, name }) {
  const artifacts = [];
  const warnings = [];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const range = parsePageRange(pages, doc.getPageCount());
    if (!range.ok) return { artifacts, warnings: [], summary: { found: 0, skipped: 0 } };
    const pageSet = new Set(range.pages);
    const refPages = new Map();
    for (const p of range.pages) {
      for (const key of pageImageRefsLoose(doc, doc.getPage(p))) {
        if (!refPages.has(key)) refPages.set(key, new Set());
        refPages.get(key).add(p);
      }
    }
    const base = String(name || '图像').replace(/\.pdf$/i, '');
    const seen = new Set();
    let k = 0;
    let skipped = 0;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const sub = dict.get(PDFName.of('Subtype'));
      if (!sub || sub.toString() !== '/Image') continue;
      const refKey = ref.toString();
      const smask = dict.get(PDFName.of('SMask'));
      const smaskKey = smask instanceof PDFRef ? smask.toString() : null;
      const dedupeKey = mode === 'composite' && smaskKey ? `${refKey}+${smaskKey}` : refKey;
      if (seen.has(dedupeKey) || (mode === 'raw' && smaskKey && seen.has(smaskKey))) continue;
      seen.add(dedupeKey);
      if (smaskKey) seen.add(smaskKey);
      const pages0 = refPages.get(refKey) || refPages.get(smaskKey);
      const ownerPage = pages0 ? [...pages0][0] : null;
      if (pages0 && ![...pages0].some((p) => pageSet.has(p))) continue;
      try {
        const img = await decodeImageLoose(doc, obj, mode === 'composite', warnings);
        if (!img) { skipped++; continue; }
        const tag = ownerPage != null ? `p${String(ownerPage + 1).padStart(3, '0')}` : 'unk';
        artifacts.push({
          name: `${buildOutputName({ name, op: '提取图片', params: paramsToken({ mode }) })}-${tag}_图${String(++k).padStart(2, '0')}.${img.mime.includes('jpeg') ? 'jpg' : 'png'}`,
          mime: img.mime,
          bytes: img.bytes,
          meta: { page: ownerPage, width: img.width, height: img.height },
        });
      } catch (err) {
        skipped++;
        warnings.push(`第 ${ownerPage != null ? ownerPage + 1 : '?'} 页的图像无法提取：${err.message}`);
      }
    }
    return { artifacts, warnings, summary: { found: artifacts.length, skipped } };
  } catch (e) {
    warnings.push(`兼容提取器失败：${e.message}`);
    return { artifacts, warnings, summary: { found: 0, skipped: 0 } };
  }
}
