// WASM 扩展引擎资产持久化缓存（Cache Storage）。
// pandoc(58MB)/typst(28MB) 等大体积扩展包默认只靠 HTTP 缓存，浏览器清缓存或
// 存储压力下会被逐出，用户每次都要重新下载；这里写入持久 Cache Storage，
// 之后的访问零网络（离线也可用）。设置面板「引擎状态」分区展示占用并可清空。
const CACHE_NAME = 'pdftoolkit-assets-v1';

const hasCacheAPI = () => typeof caches !== 'undefined';

function cacheOpen() {
  return hasCacheAPI() ? caches.open(CACHE_NAME) : null;
}

/**
 * 持久化缓存优先的资源获取：命中缓存零网络返回；未命中走 fetch（带 404/断流重试
 * 与下载进度），成功后写入缓存。逻辑与各加载点原有的 fetchWithProgress 一致，
 * 仅多出缓存两步。
 * @param {string} url
 * @param {{onProgress?:(loaded:number,total:number)=>void, retries?:number, label?:string, missingError?:string}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchEngineAsset(url, opts = {}) {
  const { onProgress, retries = 2, label = '资产', missingError = '' } = opts;
  const cache = await cacheOpen();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        onProgress?.(buf.byteLength, buf.byteLength);
        return new Uint8Array(buf);
      }
    } catch { /* 缓存读取失败按未命中处理 */ }
  }
  const bytes = await fetchWithProgress(url, onProgress, retries, label, missingError);
  if (cache) {
    try {
      // clone 一份写缓存；Blob 包装避免结构化克隆大 ArrayBuffer 的额外拷贝语义差异
      await cache.put(url, new Response(new Blob([bytes]), { headers: { 'content-type': 'application/octet-stream' } }));
    } catch { /* 写缓存失败不影响本次使用（如配额/隐私模式） */ }
  }
  return bytes;
}

async function fetchWithProgress(url, onProgress, retries, label, missingError) {
  for (let attempt = 0; ; attempt++) {
    let notFound = false;
    try {
      const res = await fetch(url);
      if (res.status === 404) { notFound = true; throw new TypeError('404'); }
      if (!res.ok) throw new Error(`${label}加载失败：HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress?.(loaded, total);
      }
      const out = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch (err) {
      if (!(notFound || err instanceof TypeError)) throw err;
      if (attempt >= (notFound ? retries : 1)) {
        if (notFound && missingError) throw new Error(missingError);
        if (notFound) throw new Error(`${label}未找到（404）`);
        throw new Error(`${label}下载失败（已重试）：${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

/** 缓存清单（设置面板展示）：[{url, size}]，按大小降序 */
export async function assetCacheEntries() {
  const cache = await cacheOpen();
  if (!cache) return [];
  const keys = await cache.keys().catch(() => []);
  const out = [];
  for (const req of keys) {
    let size = 0;
    try { size = Number(req.headers.get('content-length')) || 0; } catch { /* 忽略 */ }
    if (!size) {
      try {
        const res = await cache.match(req);
        size = res ? (await res.arrayBuffer()).byteLength : 0;
      } catch { /* 忽略单条 */ }
    }
    out.push({ url: req.url, size });
  }
  return out.sort((a, b) => b.size - a.size);
}

export async function clearAssetCache() {
  if (!hasCacheAPI()) return;
  await caches.delete(CACHE_NAME).catch(() => {});
}

/** 本源整体存储用量（含 IndexedDB/Cache，设置面板展示用） */
export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch { /* 忽略 */ }
  return { usage: 0, quota: 0 };
}
