// 最近使用记录：首页第一行展示最近用过的功能（最多 10 个）。
// localStorage 持久化，设置里可整体关闭/清空；单条可在首页行内删除。
const KEY = 'pdftoolkit.recent.v1';
export const RECENT_MAX = 10;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) || '[]');
    cache = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 隐私模式忽略 */ }
}

/** 最近使用的工具 id（最新在前，已去重，≤RECENT_MAX） */
export function getRecent() {
  return [...load()];
}

/** 记录一次使用：置顶并去重，超出上限截断。返回是否发生变更 */
export function pushRecent(id) {
  if (!id) return false;
  const list = load();
  const i = list.indexOf(id);
  if (i === 0) return false;
  if (i > 0) list.splice(i, 1);
  list.unshift(id);
  if (list.length > RECENT_MAX) list.length = RECENT_MAX;
  cache = list;
  save();
  return true;
}

/** 删除单条记录，返回是否删除 */
export function removeRecent(id) {
  const list = load();
  const i = list.indexOf(id);
  if (i < 0) return false;
  list.splice(i, 1);
  cache = list;
  save();
  return true;
}

export function clearRecent() {
  cache = [];
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
