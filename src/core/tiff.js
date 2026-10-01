// TIFF 编解码（纯 JS，worker/主线程通用）。
// 编码：多页无压缩 RGB/灰度（Pillow / 预览器均可读）。
// 解码：无压缩 / LZW / PackBits / Deflate(Adobe)，灰度 / RGB / 调色板 / 16bit，支持水平差分预测器。

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

/**
 * 多页 TIFF 编码（无压缩）
 * @param {Array<{data:Uint8ClampedArray|Uint8Array, w:number, h:number, gray?:boolean}>} pages
 */
export function encodeTiff(pages) {
  if (!pages?.length) throw new Error('TIFF 编码：无页面数据');
  // 布局：header(8) | IFD1 (+BitsPerSample 附表) | IFD2 ... | 像素数据...
  const tagCount = 10;
  const ifdSize = 2 + tagCount * 12 + 4;
  const bpsExtra = 6; // RGB: 3 × SHORT
  let off = 8;
  const ifdOffsets = [];
  for (let i = 0; i < pages.length; i++) {
    ifdOffsets.push(off);
    off += ifdSize + (pages[i].gray ? 0 : bpsExtra);
  }
  const dataOffsets = [];
  for (const p of pages) {
    dataOffsets.push(off);
    off += p.w * p.h * (p.gray ? 1 : 3);
  }
  const out = new Uint8Array(off);
  const view = new DataView(out.buffer);
  // header
  out[0] = 0x49; out[1] = 0x49; // 'II'
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffsets[0], true);

  pages.forEach((p, i) => {
    const o = ifdOffsets[i];
    const bpsOff = o + ifdSize; // RGB 附表紧跟 IFD
    const entries = [
      [256, 4, 1, p.w],           // ImageWidth
      [257, 4, 1, p.h],           // ImageLength
      [258, 3, p.gray ? 1 : 3, p.gray ? 8 : bpsOff], // BitsPerSample
      [259, 3, 1, 1],             // Compression = none
      [262, 3, 1, p.gray ? 1 : 2],// Photometric = BlackIsZero / RGB
      [273, 4, 1, dataOffsets[i]],// StripOffsets
      [277, 3, 1, p.gray ? 1 : 3],// SamplesPerPixel
      [278, 4, 1, p.h],           // RowsPerStrip（单条带）
      [279, 4, 1, p.w * p.h * (p.gray ? 1 : 3)], // StripByteCounts
      [284, 3, 1, 1],             // PlanarConfiguration = chunky
    ].sort((a, b) => a[0] - b[0]);
    view.setUint16(o, entries.length, true);
    entries.forEach((e, k) => {
      const eo = o + 2 + k * 12;
      view.setUint16(eo, e[0], true);
      view.setUint16(eo + 2, e[1], true);
      view.setUint32(eo + 4, e[2], true);
      if (e[1] === 3 && e[2] === 1) view.setUint16(eo + 8, e[3], true);
      else view.setUint32(eo + 8, e[3], true);
    });
    view.setUint32(o + 2 + entries.length * 12, i + 1 < pages.length ? ifdOffsets[i + 1] : 0, true);
    // BitsPerSample 附表（RGB: 8,8,8）
    if (!p.gray) {
      for (let c = 0; c < 3; c++) view.setUint16(bpsOff + c * 2, 8, true);
    }
    // 像素：源数据为 canvas ImageData（RGBA，4 字节/像素），RGB 页必须压缩为
    // 3 字节/像素再写入条带——此前直接按 w*h*4 拷贝，超出 w*h*3 的条带声明
    // （RangeError 或像素错位，致 pdf.toTiff 对任何彩色页崩溃/花屏）。
    const px = new Uint8Array(p.w * p.h * (p.gray ? 1 : 3));
    const src = p.data;
    if (p.gray) {
      px.set(src.subarray(0, px.length));
    } else {
      for (let i = 0; i < p.w * p.h; i++) {
        px[i * 3] = src[i * 4];
        px[i * 3 + 1] = src[i * 4 + 1];
        px[i * 3 + 2] = src[i * 4 + 2];
      }
    }
    out.set(px, dataOffsets[i]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

function readTagValue(view, u8, entryOff, le) {
  const type = view.getUint16(entryOff + 2, le);
  const count = view.getUint32(entryOff + 4, le);
  const size = (TYPE_SIZE[type] || 1) * count;
  let pos = entryOff + 8;
  if (size > 4) pos = view.getUint32(entryOff + 8, le);
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = pos + i * (TYPE_SIZE[type] || 1);
    switch (type) {
      case 1: case 6: case 7: out.push(u8[p]); break;
      case 3: case 8: out.push(view.getUint16(p, le)); break;
      case 4: case 9: out.push(view.getUint32(p, le)); break;
      case 5: out.push(view.getUint32(p, le) / (view.getUint32(p + 4, le) || 1)); break;
      case 11: out.push(view.getFloat32(p, le)); break;
      case 12: out.push(view.getFloat64(p, le)); break;
      default: out.push(0);
    }
  }
  return out.length === 1 ? out[0] : out;
}

/** PackBits 解码 */
function unpackBits(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const n = src[i] | 0; // 有符号
    i++;
    if (n >= 0) {
      const cnt = n + 1;
      for (let k = 0; k < cnt && i < src.length; k++) out.push(src[i++]);
    } else if (n !== -128) {
      const cnt = 1 - n;
      const b = i < src.length ? src[i++] : 0;
      for (let k = 0; k < cnt; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** LZW 解码（TIFF 变体：提前+1 位宽） */
function lzwDecode(src) {
  const out = [];
  let dict = new Map();
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(i, [i]);
    let clearCode = 256, eoiCode = 257;
    return { next: 258, width: 9 };
  };
  let st = reset();
  let prev = null;
  let bitPos = 0;
  const readCode = (width) => {
    let code = 0;
    for (let b = 0; b < width; b++) {
      const byte = (bitPos >> 3);
      if (byte >= src.length) return null;
      const bit = (src[byte] >> (bitPos & 7)) & 1;
      code |= bit << b;
      bitPos++;
    }
    return code;
  };
  let { next, width } = st;
  for (;;) {
    const code = readCode(width);
    if (code == null) break;
    if (code === 256) { st = reset(); ({ next, width } = st); prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (dict.has(code)) entry = dict.get(code);
    else if (code === next && prev) entry = [...prev, prev[0]];
    else break; // 损坏
    out.push(...entry);
    if (prev) {
      dict.set(next, [...prev, entry[0]]);
      next++;
      if (next + 1 >= 1 << width && width < 12) width++;
    }
    prev = entry;
  }
  return Uint8Array.from(out);
}

async function inflateTiff(src) {
  // DecompressionStream 支持 zlib('deflate')
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([src]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function undoPredictor(raw, w, h, comps, bpc) {
  if (bpc !== 8) return raw; // 16bit 差分此处不支持（罕见），按原样返回
  const stride = w * comps;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = comps; x < stride; x++) {
      raw[row + x] = (raw[row + x] + raw[row + x - comps]) & 0xFF;
    }
  }
  return raw;
}

/**
 * 解析 TIFF → 页数组
 * @returns {Promise<Array<{data:Uint8ClampedArray(rgba), w, h}>>}
 */
export async function decodeTiff(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let le;
  if (u8[0] === 0x49 && u8[1] === 0x49) le = true;
  else if (u8[0] === 0x4D && u8[1] === 0x4D) le = false;
  else throw new Error('不是有效的 TIFF 文件');
  if (view.getUint16(2, le) !== 42) throw new Error('TIFF 魔数错误');
  const pages = [];
  let ifd = view.getUint32(4, le);
  let guard = 0;
  while (ifd && guard++ < 256) {
    const n = view.getUint16(ifd, le);
    const tags = new Map();
    for (let k = 0; k < n; k++) {
      const eo = ifd + 2 + k * 12;
      const tag = view.getUint16(eo, le);
      tags.set(tag, readTagValue(view, u8, eo, le));
    }
    ifd = view.getUint32(ifd + 2 + n * 12, le);
    if (!tags.has(256) || !tags.has(257)) continue;
    const w = Number(tags.get(256)), h = Number(tags.get(257));
    const bps = Array.isArray(tags.get(258)) ? tags.get(258) : [tags.get(258) || 1];
    const compression = Number(tags.get(259) || 1);
    const photo = Number(tags.get(262) || 1);
    const spp = Number(tags.get(277) || (photo === 2 ? 3 : 1));
    const rowsPerStrip = Math.min(Number(tags.get(278) || h), h);
    const stripOffsets = Array.isArray(tags.get(273)) ? tags.get(273) : [tags.get(273)];
    const stripCounts = Array.isArray(tags.get(279)) ? tags.get(279) : [tags.get(279)];
    const predictor = Number(tags.get(317) || 1);
    const colormap = tags.get(320);
    const strips = Math.ceil(h / rowsPerStrip);
    const bpc = bps[0] || 1;
    if (bpc !== 8 && bpc !== 1 && bpc !== 16) throw new Error(`不支持的位深 ${bpc}`);
    // 拼接解压后的全部条带
    let raw = new Uint8Array(0);
    for (let s = 0; s < strips; s++) {
      const so = stripOffsets[s], sc = stripCounts[s] ?? (u8.length - so);
      let part = u8.subarray(so, so + sc);
      if (compression === 5) part = lzwDecode(part);
      else if (compression === 8 || compression === 32946) part = await inflateTiff(part);
      else if (compression === 32773) part = unpackBits(part);
      else if (compression !== 1) throw new Error(`不支持的 TIFF 压缩方式 ${compression}`);
      const merged = new Uint8Array(raw.length + part.length);
      merged.set(raw); merged.set(part, raw.length);
      raw = merged;
    }
    const comps = spp;
    const bytesPer = bpc === 16 ? 2 : 1;
    if (bpc === 8 && predictor === 2) {
      const rows = Math.floor(raw.length / (w * comps));
      raw = undoPredictor(raw, w, rows, comps, bpc);
    }
    // 1bit 展开
    if (bpc === 1) {
      const rows = Math.ceil(w / 8);
      const exp = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bit = (raw[y * rows + (x >> 3)] >> (7 - (x & 7))) & 1;
          exp[y * w + x] = bit ? 255 : 0;
        }
      }
      raw = exp;
    } else if (bpc === 16) {
      const exp = new Uint8Array(Math.floor(raw.length / 2));
      for (let i = 0; i < exp.length; i++) exp[i] = raw[i * 2 + (le ? 1 : 0)];
      raw = exp;
    }
    // → RGBA
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (photo === 3 && colormap) {
        const v = raw[i] || 0;
        rgba[i * 4] = (colormap[v] || 0) >> 8;
        rgba[i * 4 + 1] = (colormap[256 + v] || 0) >> 8;
        rgba[i * 4 + 2] = (colormap[512 + v] || 0) >> 8;
      } else if (comps >= 3) {
        rgba[i * 4] = raw[i * comps];
        rgba[i * 4 + 1] = raw[i * comps + 1];
        rgba[i * 4 + 2] = raw[i * comps + 2];
        rgba[i * 4 + 3] = comps >= 4 ? raw[i * comps + 3] : 255;
      } else {
        let g = raw[i];
        if (photo === 0) g = 255 - g;
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g;
      }
      if (photo !== 3 && !(comps >= 4)) rgba[i * 4 + 3] = 255;
    }
    pages.push({ data: rgba, w, h });
  }
  if (!pages.length) throw new Error('TIFF 中没有可读取的页面');
  return pages;
}
