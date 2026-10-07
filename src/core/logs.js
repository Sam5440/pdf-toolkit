// 运行日志：内存环形缓冲 + localStorage 持久化，设置面板「运行日志」分区消费。
// 只记录我们可控的静态文案与元信息（op 名、耗时、错误消息），绝不记录参数值、
// 文件字节与密码类内容；日志仅保存在本机浏览器。
const KEY = 'pdftoolkit.logs.v1';
const MAX_ENTRIES = 500;      // 内存上限（环形）
const PERSIST_MAX = 200;      // 持久化保留最近条数（防 localStorage 膨胀）

const LEVELS = { info: 0, warn: 1, error: 2 };

let entries = [];
let hydrated = false;
const listeners = new Set();

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(raw)) entries = raw.filter((e) => e && typeof e.msg === 'string').slice(-MAX_ENTRIES);
  } catch { /* 损坏即弃用 */ }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-PERSIST_MAX)));
  } catch { /* 配额满时静默放弃持久化（内存里仍有） */ }
}

/**
 * 记录一条日志。
 * @param {string} tag 来源模块（如 'engine' 'tray' 'pandoc'）
 * @param {string} msg 主文案
 * @param {{level?:'info'|'warn'|'error', detail?:string}} [opts]
 */
export function log(tag, msg, opts = {}) {
  hydrate();
  const level = LEVELS[opts.level] != null ? opts.level : 'info';
  entries.push({ t: Date.now(), level, tag: String(tag), msg: String(msg), detail: opts.detail ? String(opts.detail).slice(0, 500) : '' });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persist();
  for (const fn of [...listeners]) {
    try { fn(entries[entries.length - 1]); } catch { /* 订阅方异常不影响其他 */ }
  }
}

export { LEVELS };

/** 快照（可选按最低级别过滤），时间正序 */
export function getLogs({ minLevel = 'info' } = {}) {
  hydrate();
  const min = LEVELS[minLevel] ?? 0;
  return entries.filter((e) => LEVELS[e.level] >= min).map((e) => ({ ...e }));
}

export function clearLogs() {
  hydrate();
  entries = [];
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
  for (const fn of [...listeners]) {
    try { fn(null); } catch { /* noop */ }
  }
}

export function onLogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 导出为可读文本（设置面板「复制/下载」用） */
export function logsToText(list = getLogs()) {
  const fmt = (t) => {
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  return list.map((e) => `[${fmt(e.t)}] [${e.level.toUpperCase()}] [${e.tag}] ${e.msg}${e.detail ? ` — ${e.detail}` : ''}`).join('\n');
}
