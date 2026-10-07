// 外挂字体管理：网页端上传 / 远程 URL 订阅，全部持久化在本机（IndexedDB + Cache Storage）。
// 统一 id 前缀 'user-'，供水印/文字工具的字体选择与 Typst 排版引擎注入。
// 远程字体每次启动自动从配置 URL 下载（fetchEngineAsset：Cache Storage 持久化，命中零网络）。
import { uid, baseName } from './format.js';
import { getSettings, setSetting } from './settings.js';
import { fetchEngineAsset } from './asset-cache.js';

const DB_NAME = 'pdftoolkit-fonts';
const DB_VERSION = 1;
const STORE = 'fonts';

export const FONT_EXT_RE = /\.(ttf|otf|ttc|woff2?)$/i;
export const FONT_ACCEPT = '.ttf,.otf,.ttc,.woff,.woff2';

let dbPromise = null;
const memBytes = new Map(); // id → ArrayBuffer（会话内缓存）

export const isUserFontId = (id) => String(id || '').startsWith('user-');

function openDB() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB 不可用'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('字体数据库被其他标签页占用'));
    });
  }
  return dbPromise;
}

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function stripBytes(rec) {
  const { bytes, ...meta } = rec;
  return meta;
}

/** 字体清单（不含字节），按加入时间升序 */
export async function listUserFonts() {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await openDB();
    const all = (await req2p(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) || [];
    return all.map(stripBytes).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  } catch {
    return [];
  }
}

/** 读取字体字节（会话内存缓存） */
export async function getUserFontBytes(id) {
  if (memBytes.has(id)) return memBytes.get(id);
  const db = await openDB();
  const rec = await req2p(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  if (!rec?.bytes) throw new Error(`外挂字体不存在或已被删除（${id}）`);
  memBytes.set(id, rec.bytes);
  return rec.bytes;
}

/**
 * 入库一个字体（上传或远程）。family 从字体二进制 name 表解析；解析失败回退文件名。
 * source='remote' 时按 url 幂等覆盖（同 URL 重复同步不产生重复条目）。
 */
export async function addUserFont({ bytes, name, source = 'upload', url = '' }) {
  const fname = String(name || 'font.ttf');
  if (!FONT_EXT_RE.test(fname)) throw new Error(`不支持的字体文件：${fname}（支持 ttf/otf/ttc/woff/woff2）`);
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const family = readFontFamily(buf) || baseName(fname);
  const db = await openDB();
  if (source === 'remote' && url) {
    const all = (await req2p(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) || [];
    const prev = all.find((r) => r.url === url);
    if (prev) {
      memBytes.delete(prev.id);
      const rec = { ...prev, name: baseName(fname) || prev.name, family, size: buf.byteLength, addedAt: Date.now(), bytes: buf };
      await req2p(db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec));
      return { rec: stripBytes(rec), replaced: true };
    }
  }
  const rec = {
    id: uid('user'),
    name: baseName(fname) || 'font',
    family,
    ext: (fname.match(/([a-z0-9]+)$/i)?.[1] || 'ttf').toLowerCase(),
    size: buf.byteLength,
    addedAt: Date.now(),
    source,
    url,
    bytes: buf,
  };
  await req2p(db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec));
  return { rec: stripBytes(rec), replaced: false };
}

export async function removeUserFont(id) {
  memBytes.delete(id);
  const db = await openDB();
  await req2p(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
}

// ---------------------------------------------------------------------------
// 远程字体订阅
// ---------------------------------------------------------------------------

/** 配置的远程字体 URL 列表（设置持久化） */
export function getRemoteUrls() {
  try {
    const v = getSettings().remoteFontUrls;
    return Array.isArray(v) ? v.filter((u) => typeof u === 'string' && u.trim()) : [];
  } catch {
    return [];
  }
}

export function setRemoteUrls(urls) {
  const clean = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  setSetting('remoteFontUrls', clean);
  return clean;
}

function urlFileName(u) {
  try {
    const p = new URL(u).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(p || '') || 'remote-font.ttf';
  } catch {
    return 'remote-font.ttf';
  }
}

/**
 * 同步全部远程字体：逐个下载（进度回调）并入库（按 URL 幂等）。
 * 单个失败不阻塞其他；返回 {ok, updated, failed:[{url,error}]}。
 */
export async function syncRemoteFonts({ onProgress, onItem } = {}) {
  const urls = getRemoteUrls();
  let ok = 0;
  let updated = 0;
  const failed = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const bytes = await fetchEngineAsset(url, {
        label: urlFileName(url),
        retries: 1,
        onProgress: (loaded, total) => onProgress?.(url, loaded, total),
      });
      const { rec, replaced } = await addUserFont({ bytes, name: urlFileName(url), source: 'remote', url });
      if (replaced) updated += 1; else ok += 1;
      onItem?.(rec, null);
    } catch (err) {
      failed.push({ url, error: err?.message || String(err) });
      onItem?.(null, { url, error: err?.message || String(err) });
    }
  }
  return { ok, updated, failed };
}

// ---------------------------------------------------------------------------
// 字体家族名解析（sfnt name 表；ttc 取第一个字体；woff/woff2 不解析回退文件名）
// ---------------------------------------------------------------------------

/**
 * 从 ttf/otf/ttc 二进制解析字体家族名（nameID 16 优先，回退 1）。
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {string} 解析失败返回 ''
 */
export function readFontFamily(buf) {
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 12) return '';
    const tag = dv.getUint32(0);
    let base = 0;
    if (tag === 0x74746366) { // 'ttcf' 集合：取第一个字体偏移
      base = dv.getUint32(12);
    } else if (tag !== 0x00010000 && tag !== 0x4F54544F && tag !== 0x74727565) {
      // 非 sfnt（true/OTTO/trure）：woff = 'wOFF'(0x774F4646)，woff2 = 'wOF2'，直接放弃
      return '';
    }
    const numTables = dv.getUint16(base + 4);
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + 16 * i;
      if (rec + 16 > u8.length) return '';
      if (dv.getUint32(rec) !== 0x6E616D65) continue; // 'name'
      // 表偏移相对字体头（ttc 集合中非文件头），需加 base
      const off = base + dv.getUint32(rec + 8);
      return parseNameTable(u8, dv, off) || '';
    }
    return '';
  } catch {
    return '';
  }
}

/** UTF-16BE 手动解码（浏览器无 'utf-16be' TextDecoder 标签支持） */
function utf16be(u8, start, len) {
  let s = '';
  for (let i = start; i + 1 < start + len; i += 2) {
    s += String.fromCharCode((u8[i] << 8) | u8[i + 1]);
  }
  return s;
}

function parseNameTable(u8, dv, off) {
  if (off + 6 > u8.length) return '';
  const count = dv.getUint16(off + 2);
  const strOff = off + dv.getUint16(off + 4);
  let fallback = '';
  for (let i = 0; i < count; i++) {
    const rec = off + 6 + 12 * i;
    if (rec + 12 > u8.length) break;
    const platform = dv.getUint16(rec);
    const nameID = dv.getUint16(rec + 6);
    const len = dv.getUint16(rec + 8);
    const sOff = strOff + dv.getUint16(rec + 10);
    if (nameID !== 16 && nameID !== 1) continue;
    if (sOff + len > u8.length) continue;
    let s = '';
    if (platform === 0 || platform === 3) {
      s = utf16be(u8, sOff, len).replace(/\0+$/, '');
    } else {
      s = String.fromCharCode(...u8.subarray(sOff, Math.min(sOff + len, sOff + 512)));
    }
    s = s.trim();
    if (!s) continue;
    if (nameID === 16) return s;
    if (!fallback) fallback = s;
  }
  return fallback;
}
