// 引擎池（主线程侧）：管理 worker 池、op 调度、进度/取消、文档字节装载与驱逐重试。
import { uid } from './format.js';
import EngineWorkerCtor from './engine-worker.js?worker';

class EnginePool {
  constructor(size = 2) {
    this.size = Math.max(1, size);
    this.workers = [];
    this.queue = [];
  }

  _spawn() {
    const w = new EngineWorkerCtor();
    w.busy = null;
    w.jobs = new Map();
    w.onmessage = (ev) => {
      const msg = ev.data;
      const job = w.jobs.get(msg.id);
      if (!job) return;
      if (msg.type === 'progress') {
        job.onProgress?.(msg);
      } else if (msg.type === 'result') {
        w.jobs.delete(msg.id);
        w.busy = null;
        if (msg.ok) job.resolve(msg.result);
        else {
          const e = new Error(msg.message);
          e.code = msg.code;
          job.reject(e);
        }
        this._pump();
      }
    };
    w.onerror = (ev2) => {
      // worker 崩溃：拒绝所有在途任务
      for (const [, job] of w.jobs) job.reject(new Error(`引擎崩溃：${ev2.message || '未知错误'}`));
      w.jobs.clear();
      this.workers = this.workers.filter((x) => x !== w);
      this._pump();
    };
    this.workers.push(w);
    return w;
  }

  _worker() {
    return this.workers.find((w) => !w.busy) || null;
  }

  _pump() {
    while (this.queue.length) {
      const w = this._worker();
      if (!w) {
        if (this.workers.length < this.size) { this._spawn(); continue; }
        break;
      }
      const job = this.queue.shift();
      this._exec(w, job);
    }
  }

  _exec(w, job) {
    w.busy = job;
    w.jobs.set(job.id, job);
    w.postMessage({ type: 'run', id: job.id, op: job.op, args: job.args }, job.transfer || []);
  }

  /**
   * 执行引擎操作
   * @param {string} op
   * @param {object} args
   * @param {{onProgress?:Function, transfer?:Array, priority?:boolean, onSpawn?:Function}} opts
   */
  run(op, args = {}, opts = {}) {
    const job = {
      id: uid('op'), op, args,
      onProgress: opts.onProgress,
      transfer: opts.transfer,
      resolve: null, reject: null,
    };
    opts.onSpawn?.(job.id);
    const p = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    if (opts.priority) this.queue.unshift(job);
    else this.queue.push(job);
    this._pump();
    return p;
  }

  abort(opId) {
    for (const w of this.workers) {
      const job = w.jobs.get(opId);
      if (job) w.postMessage({ type: 'abort', id: opId });
    }
    // 队列中尚未执行的直接取消
    this.queue = this.queue.filter((j) => {
      if (j.id === opId) {
        const e = new Error('已取消');
        e.code = 'ERR_CANCELLED';
        j.reject(e);
        return false;
      }
      return true;
    });
  }

  destroy() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
  }
}

let pool = null;
const inflightOpens = new Map(); // docKey → Promise
const openedDocs = new Map(); // docId → { key, info }（已装载记忆化：避免后续 run 重发 doc.open 覆盖 worker 内已变更的文档）

function getPool() {
  if (!pool) {
    let n = 2;
    try {
      const s = JSON.parse(localStorage.getItem('pdftoolkit.settings.v1') || '{}');
      n = s.workerCount > 0 ? s.workerCount : Math.min(3, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    } catch { /* 默认 */ }
    pool = new EnginePool(n);
  }
  return pool;
}

/** limits 附加到所有 op（渲染像素上限、资产基址等） */
function limitsArg(args) {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('pdftoolkit.settings.v1') || '{}'); } catch { /* 默认 */ }
  const limits = {};
  if (s.maxRenderPixels) limits.maxRenderPixels = s.maxRenderPixels;
  limits.assetBase = new URL(import.meta.env.BASE_URL || '/', document.baseURI).href;
  return { ...args, limits };
}

/**
 * 确保文档已在引擎内打开（发送字节，worker 缓存解析结果）。
 * 记忆化：同一 docId 已成功装载且 file 未变时跳过重发（否则两步 op 链会拿到未变更副本）。
 * @param {{id,name,size,file}} doc documents.addDocument 的结果
 * @param {{force?:boolean}} opts 强制重装（引擎驱逐重试时用）
 */
export async function ensureDoc(doc, opts = {}) {
  const key = `${doc.id}:${doc.size}`;
  const memo = openedDocs.get(doc.id);
  if (!opts.force && memo && memo.key === key) return memo.info;
  if (!opts.force && inflightOpens.has(key)) return inflightOpens.get(key);
  const p = (async () => {
    const bytes = await doc.file.arrayBuffer();
    return getPool().run('doc.open', limitsArg({
      docId: doc.id, name: doc.name, bytes,
      limits: {},
    }), { transfer: [bytes], priority: true });
  })()
    .then((info) => { openedDocs.set(doc.id, { key, info }); return info; })
    .finally(() => inflightOpens.delete(key));
  if (!opts.force) inflightOpens.set(key, p);
  return p;
}

/**
 * 运行引擎 op（自动确保文档已装载；驱逐错误自动重装重试一次）
 * @param {string} op
 * @param {object} args  含 docId / docIds
 * @param {object} docs  docId → document（用于自动 ensure）
 * @returns {Promise} 可配合 abort(handle.id) 取消
 */
export async function run(op, args = {}, opts = {}, docs = new Map()) {
  // 先确保涉及的文档已打开
  const ids = new Set();
  if (args.docId) ids.add(args.docId);
  for (const k of ['docIds', 'baseDocId', 'overlayDocId']) {
    if (args[k]) Array.isArray(args[k]) ? args[k].forEach((i) => ids.add(i)) : ids.add(args[k]);
  }
  if (Array.isArray(args.items)) args.items.forEach((i) => ids.add(i.docId));
  for (const id of ids) {
    const d = docs.get(id);
    if (d) await ensureDoc(d);
  }
  let jobId = null;
  const exec = () => getPool().run(op, limitsArg(args), { ...opts, onSpawn: (id) => { jobId = id; opts.onSpawn?.(id); } });
  try {
    const result = await exec();
    result._opId = jobId;
    return result;
  } catch (e) {
    if (e.code === 'ERR_NO_INPUT' && /引擎/.test(e.message)) {
      // worker 内存驱逐：强制重装所有文档后重试一次
      for (const id of ids) {
        const d = docs.get(id);
        if (d) await ensureDoc(d, { force: true });
      }
      const result = await exec();
      result._opId = jobId;
      return result;
    }
    throw e;
  }
}

export function abort(opId) { if (opId) getPool().abort(opId); }
export function destroyEngine() { pool?.destroy(); pool = null; }
