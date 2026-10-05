// WASM / 引擎加载状态注册表（纯状态中心，不 import 任何重型模块，避免循环依赖）。
// 各加载点（engine.js 转发 worker 上报、mdpandoc、mdtypst、fonts）通过
// setEngineStatus 上报；设置面板「引擎状态」分区订阅展示并可按需 probe 预载。
// 状态机：idle（未加载）→ loading（下载/初始化中，detail 为阶段文本）
//        → ready（就绪，detail 可为版本号）| error（失败，detail 为错误摘要）。

const engines = new Map(); // id → { id, label, desc, size, status, detail, probe }
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 注册引擎元信息（幂等：已存在则仅补齐缺失字段，不覆盖运行时状态） */
export function defineEngine(def) {
  const prev = engines.get(def.id);
  engines.set(def.id, prev
    ? {
        ...def, ...prev,
        label: prev.label || def.label,
        desc: prev.desc || def.desc,
      }
    : { status: 'idle', detail: '', ...def });
  notify();
}

/**
 * 更新引擎状态。
 * ready → loading 允许通过：Worker 池内多个 worker 各自懒加载（mupdf、tesseract
 * 换语言包重载）是真实的加载阶段，如实展示短促的 loading 回摆。
 */
export function setEngineStatus(id, status, detail = '') {
  const e = engines.get(id);
  if (!e) return;
  e.status = status;
  e.detail = detail || '';
  notify();
}

/** 快照（拷贝，供渲染层安全遍历） */
export function engineList() {
  return [...engines.values()].map((e) => ({ ...e }));
}

export function onEngines(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 手动预载（设置面板「加载」按钮）：状态流转在 probe 内部上报 */
export async function probeEngine(id) {
  const e = engines.get(id);
  if (!e?.probe || e.status === 'loading') return;
  try {
    await e.probe();
  } catch (err) {
    // probe 内部通常已上报 error；此处兜底（如 probe 忘记上报）
    setEngineStatus(id, 'error', err?.message || String(err));
  }
}
