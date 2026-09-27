// 历史记录 — IndexedDB 本地存储，含输出 Blob 与配额 LRU 管理。
// 隐私：不记录任何密码；参数摘要需经 sanitizeOptions 脱敏。

const DB_NAME = 'pdftoolkit';
const STORE = 'history';
const META = 'meta';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) { return db.transaction(store, mode).objectStore(store); }

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 脱敏：移除任何疑似敏感键（password/pw/secret），保留工具与参数摘要 */
export function sanitizeOptions(options) {
  const clean = {};
  for (const [k, v] of Object.entries(options || {})) {
    if (/pass|pw|secret|token/i.test(k)) continue;
    clean[k] = typeof v === 'object' && v !== null ? '[对象]' : v;
  }
  return clean;
}

export async function addHistory(record) {
  const db = await openDB();
  const rec = {
    id: record.id,
    time: record.time || Date.now(),
    tool: record.tool,
    toolName: record.toolName || record.tool,
    docNames: record.docNames || [],
    options: sanitizeOptions(record.options),
    warnings: record.warnings || [],
    outputs: (record.outputs || []).map((o) => ({
      name: o.name, mime: o.mime, size: o.size, blob: o.blob,
    })),
  };
  await req2p(tx(db, STORE, 'readwrite').put(rec));
  await enforceQuota();
  return rec.id;
}

export async function listHistory({ tool = null, limit = 100 } = {}) {
  const db = await openDB();
  const all = await req2p(tx(db, STORE, 'readonly').getAll());
  all.sort((a, b) => (b.time || 0) - (a.time || 0));
  const filtered = tool ? all.filter((r) => r.tool === tool) : all;
  return filtered.slice(0, limit).map(lightRecord);
}

function lightRecord(r) {
  return {
    id: r.id, time: r.time, tool: r.tool, toolName: r.toolName,
    docNames: r.docNames, options: r.options, warnings: r.warnings,
    outputs: (r.outputs || []).map((o) => ({ name: o.name, mime: o.mime, size: o.size })),
  };
}

export async function getHistory(id) {
  const db = await openDB();
  const rec = await req2p(tx(db, STORE, 'readonly').get(id));
  return rec || null;
}

export async function deleteHistory(id) {
  const db = await openDB();
  await req2p(tx(db, STORE, 'readwrite').delete(id));
}

export async function clearHistory() {
  const db = await openDB();
  await req2p(tx(db, STORE, 'readwrite').clear());
}

export async function historyUsedBytes() {
  const db = await openDB();
  const all = await req2p(tx(db, STORE, 'readonly').getAll());
  return all.reduce((s, r) => s + (r.outputs || []).reduce((s2, o) => s2 + (o.size || 0), 0), 0);
}

/** 配额：超出时从最旧开始删整条记录 */
async function enforceQuota() {
  const { getSettings } = await import('./settings.js');
  const quota = getSettings().historyQuotaMB * 1024 * 1024;
  const db = await openDB();
  const all = await req2p(tx(db, STORE, 'readonly').getAll());
  const sorted = all.sort((a, b) => (a.time || 0) - (b.time || 0));
  let total = sorted.reduce((s, r) => s + (r.outputs || []).reduce((s2, o) => s2 + (o.size || 0), 0), 0);
  for (const r of sorted) {
    if (total <= quota) break;
    const sz = (r.outputs || []).reduce((s2, o) => s2 + (o.size || 0), 0);
    await req2p(tx(db, STORE, 'readwrite').delete(r.id));
    total -= sz;
  }
}
