// 历史记录 — IndexedDB 本地存储，含输出 Blob 与配额 LRU 管理。
// v2：完整任务记录 —— 参数无损深存（仅剔除敏感键）、输入/输出文件字节随档，
// 支撑历史页「一键复原」与工作流复用。隐私：不记录任何密码。

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

/** 敏感键（pass/password/pw/secret/token）：一律不落盘 */
export function isSecretKey(k) {
  return /pass|pw|secret|token/i.test(String(k || ''));
}

/**
 * 无损参数深存：对象/数组深拷贝进记录（v1 会把对象替换成 '[对象]' 丢失结构）。
 * Blob/File/函数等无法 JSON 化的值替换为描述串；敏感键整键剔除。
 */
export function sanitizeOptions(options) {
  const seen = typeof options === 'object' && options !== null ? new WeakSet() : null;
  function walk(v, key) {
    if (key && isSecretKey(key)) return undefined;
    if (v == null || typeof v !== 'object') return v;
    if (seen) {
      if (seen.has(v)) return '[循环引用]';
      seen.add(v);
    }
    if (v instanceof Blob) return `[文件 ${v.size} 字节]`;
    if (Array.isArray(v)) {
      const arr = v.map((x) => walk(x)).filter((x) => x !== undefined);
      seen?.delete(v); // 遍历完出栈：共享引用（DAG）不算环
      return arr;
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const w = walk(val, k);
      if (w !== undefined) out[k] = w;
    }
    seen?.delete(v);
    return out;
  }
  return walk(options);
}

/** 输入/输出文件条目统一为 {name, mime, size, blob} */
function fileEntry(f) {
  return { name: f.name, mime: f.mime || f.type || '', size: f.size ?? 0, blob: f.blob || f.file || f };
}

/**
 * 写入一条完整任务记录（v2）：
 * @param {{id,time,tool,toolName,docNames,options,inputs,outputs,warnings,form,auto}} record
 *  - inputs: 输入文件数组（File/Blob 或 {name,mime,size,blob}）
 *  - form: 表单快照 [{label,type,value}]（一键复原用，由 tasklog 采集）
 *  - auto: 是否自动记录
 */
export async function addHistory(record) {
  const db = await openDB();
  const rec = {
    id: record.id,
    time: record.time || Date.now(),
    tool: record.tool,
    toolName: record.toolName || record.tool,
    docNames: record.docNames || [],
    options: sanitizeOptions(record.options),
    inputs: (record.inputs || []).map(fileEntry),
    warnings: record.warnings || [],
    form: Array.isArray(record.form) ? record.form : [],
    auto: !!record.auto,
    outputs: (record.outputs || []).map(fileEntry),
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
    auto: !!r.auto,
    hasForm: Array.isArray(r.form) && r.form.length > 0,
    form: r.form || [],
    inputCount: (r.inputs || []).length,
    inputs: (r.inputs || []).map((o) => ({ name: o.name, mime: o.mime, size: o.size })),
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

/** 记录占用 = 输入 + 输出字节（配额按完整记录计） */
export function recordBytes(r) {
  const sum = (list) => (list || []).reduce((s, o) => s + (o.size || 0), 0);
  return sum(r.inputs) + sum(r.outputs);
}

export async function historyUsedBytes() {
  const db = await openDB();
  const all = await req2p(tx(db, STORE, 'readonly').getAll());
  return all.reduce((s, r) => s + recordBytes(r), 0);
}

/** 配额：超出时从最旧开始删整条记录 */
async function enforceQuota() {
  const { getSettings } = await import('./settings.js');
  const quota = getSettings().historyQuotaMB * 1024 * 1024;
  const db = await openDB();
  const all = await req2p(tx(db, STORE, 'readonly').getAll());
  const sorted = all.sort((a, b) => (a.time || 0) - (b.time || 0));
  let total = sorted.reduce((s, r) => s + recordBytes(r), 0);
  for (const r of sorted) {
    if (total <= quota) break;
    await req2p(tx(db, STORE, 'readwrite').delete(r.id));
    total -= recordBytes(r);
  }
}
