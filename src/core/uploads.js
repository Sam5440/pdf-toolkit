// 上传登记册 —— 图床/文件床上传记录的本地永久存档（IndexedDB 独立库 pdftoolkit-uploads）。
// 与任务历史不同：不参与配额 LRU 淘汰（按用户要求永久保存，删除只能手动）；原文件字节
// 一并保存，外链失效后可在「上传记录」页一键重新上传。隐私：记录只含服务/链接/文件元
// 信息与文件本体，不含任何凭证（GitHub token 仅工具页内存，且走 password 输入不进表单快照）。
// 失效探测分三档：图片→Image 元素（不受 CORS 限制，可精确判定 200/404）、视频→video
// 元素、其它→fetch HEAD（跨域被拦时如实报「无法自动判定」，绝不把跨域限制误报成失效）。

const DB_NAME = 'pdftoolkit-uploads';
const STORE = 'files';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 确保库与 store 已创建（整库导入等外部直写 IndexedDB 前调用；导出供 userdb） */
export async function ensureUploadStore() {
  const db = await openDB();
  db.close();
}

function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 登记一次上传。rec: {name,size,type,service,host,url,apiUrl?,meta?,bytes?}
 * bytes（Blob/Uint8Array）可选保存，链接失效后支撑一键重传；
 * apiUrl 为实际上传端点（匿名可直传的服务才有重传能力）；
 * meta 存服务附加信息（rentry 编辑码、paste.gg 删除码、raw 直链等）。
 */
export async function addUpload(rec) {
  const db = await openDB();
  const item = {
    id: `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    name: rec.name || 'file',
    size: rec.size || 0,
    type: rec.type || '',
    service: rec.service || '',
    host: rec.host || '',
    url: rec.url || '',
    apiUrl: rec.apiUrl || '',
    meta: rec.meta && typeof rec.meta === 'object' ? rec.meta : null,
    bytes: rec.bytes == null ? null : (rec.bytes instanceof Blob ? rec.bytes : new Blob([rec.bytes], { type: rec.type || 'application/octet-stream' })),
    lastCheck: null, // {ts, status:'ok'|'dead'|'unknown', note}
  };
  await req2p(tx(db, 'readwrite').put(item));
  return item.id;
}

/** 轻列表（不带字节，hasBytes 标志），按上传时间倒序 */
export async function listUploads() {
  const db = await openDB();
  const all = await req2p(tx(db, 'readonly').getAll());
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return all.map((r) => ({
    id: r.id, ts: r.ts, name: r.name, size: r.size, type: r.type,
    service: r.service, host: r.host, url: r.url, apiUrl: r.apiUrl || '',
    meta: r.meta || null,
    hasBytes: !!r.bytes, lastCheck: r.lastCheck || null,
  }));
}

export async function getUpload(id) {
  const db = await openDB();
  const rec = await req2p(tx(db, 'readonly').get(id));
  return rec || null;
}

/** 局部更新（url / lastCheck 等；字节不在此通道改） */
export async function updateUpload(id, patch) {
  const db = await openDB();
  const rec = await req2p(tx(db, 'readonly').get(id));
  if (!rec) throw new Error('上传记录不存在');
  Object.assign(rec, patch, { id: rec.id, bytes: rec.bytes });
  await req2p(tx(db, 'readwrite').put(rec));
  return rec;
}

export async function deleteUpload(id) {
  const db = await openDB();
  await req2p(tx(db, 'readwrite').delete(id));
}

export async function clearUploads() {
  const db = await openDB();
  await req2p(tx(db, 'readwrite').clear());
}

export async function uploadsUsedBytes() {
  const db = await openDB();
  const all = await req2p(tx(db, 'readonly').getAll());
  return all.reduce((s, r) => s + (r.size || 0), 0);
}

// ---------- 多格式外链 ----------

/** 一键生成常用嵌入格式（导出供单测） */
export function formatLinks(url, name = 'file') {
  return {
    url,
    markdown: `![${name}](${url})`,
    html: `<img src="${url}" alt="${name}">`,
    bbcode: `[img]${url}[/img]`,
  };
}

// ---------- 失效探测 ----------

const IMG_EXT = /^(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const VID_EXT = /^(mp4|webm|mov|m4v)$/i;

export function extOfUrl(url) {
  try {
    const base = new URL(url).pathname.split('/').pop() || '';
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1).toLowerCase() : '';
  } catch { return ''; }
}

/** 探测策略选择（导出供单测）：图片/视频走元素加载（不受 CORS 限制），其余走 HEAD */
export function probeStrategy(url) {
  const ext = extOfUrl(url);
  if (IMG_EXT.test(ext)) return 'image';
  if (VID_EXT.test(ext)) return 'video';
  return 'head';
}

function withCacheBuster(url) {
  return url + (url.includes('?') ? '&' : '?') + `_pdftk=${Date.now()}`;
}

function probeByImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; resolve({ status: 'unknown', note: '探测超时' }); }, 15_000);
    img.onload = () => { clearTimeout(timer); resolve({ status: 'ok', note: '' }); };
    img.onerror = () => { clearTimeout(timer); resolve({ status: 'dead', note: '图片加载失败' }); };
    img.src = withCacheBuster(url);
  });
}

function probeByVideo(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const timer = setTimeout(() => { v.src = ''; resolve({ status: 'unknown', note: '探测超时' }); }, 20_000);
    v.onloadedmetadata = () => { clearTimeout(timer); resolve({ status: 'ok', note: '' }); };
    v.onerror = () => { clearTimeout(timer); resolve({ status: 'dead', note: '视频加载失败' }); };
    v.src = withCacheBuster(url);
  });
}

async function probeByHead(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (r.ok) return { status: 'ok', note: '' };
    if (r.status === 404 || r.status === 410) return { status: 'dead', note: `HTTP ${r.status}` };
    return { status: 'unknown', note: `HTTP ${r.status}（可能防盗链）` };
  } catch {
    // 跨域被 CORS 拦截 ≠ 失效：直链能访问但 JS 读不到响应，如实报未知
    return { status: 'unknown', note: '跨域限制，无法自动判定（可用「打开」人工验证）' };
  }
}

/** 探测单条记录的链接有效性（不写库；结果由调用方决定是否 updateUpload） */
export async function probeUpload(rec) {
  if (!rec?.url) return { status: 'unknown', note: '无链接' };
  const s = probeStrategy(rec.url);
  if (s === 'image') return probeByImage(rec.url);
  if (s === 'video') return probeByVideo(rec.url);
  return probeByHead(rec.url);
}

/** 并发批量探测；onResult(id, result) 逐条回调（进度即时上屏） */
export async function probeAll(list, { concurrency = 4, onResult } = {}) {
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const rec = queue.shift();
      const result = await probeUpload(rec);
      onResult?.(rec.id, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
