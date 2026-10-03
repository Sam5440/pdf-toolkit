// PDF 暂存区数据层：跨页面导航持久的内存文档架（File 引用不复制字节）。
// 上传与生成结果自动镜像到这里；只有 PDF 入架。文件全部留在浏览器内存，不出网络。
import { uid } from './format.js';

/** 暂存项内部拖放的数据类型（dragstart/drop 约定） */
export const TRAY_MIME = 'application/x-pdf-toolkit-tray';

/** 暂存项：{id, name, size, mime, file:File, addedAt, source:'upload'|'result'} */
const items = [];

const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 订阅方异常不影响其他 */ }
  }
}

export function onTrayChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isPdf(name, mime) {
  return /\.pdf$/i.test(String(name || '')) || String(mime || '') === 'application/pdf';
}

export function trayItems() { return [...items]; }
export function trayCount() { return items.length; }
export function trayBytes() { return items.reduce((s, i) => s + (i.size || 0), 0); }
export function getTrayItem(id) { return items.find((i) => i.id === id) || null; }

/**
 * 入架一个文件。同一 File 对象重复入架会被识别并返回已有项（从暂存区拖回编辑区时不产生二份）。
 * @param {File|Blob} file
 * @param {{source?:'upload'|'result', name?:string, mime?:string}} meta
 */
export function addToTray(file, { source = 'upload', name, mime } = {}) {
  if (file.__trayId) {
    const existing = getTrayItem(file.__trayId);
    if (existing) return existing;
  }
  const fname = name ?? file.name ?? '未命名.pdf';
  const item = {
    id: uid('tray'),
    name: fname,
    size: file.size ?? 0,
    mime: mime ?? file.type ?? 'application/pdf',
    file,
    addedAt: Date.now(),
    source,
  };
  try { file.__trayId = item.id; } catch { /* 只读对象忽略 */ }
  items.push(item);
  emit();
  return item;
}

/**
 * 批量入架 PDF 文件（上传镜像入口）。非 PDF 自动跳过。
 * @param {File[]} files
 * @param {{source?:'upload'|'result'}} meta
 * @returns {object[]} 实际入架的项
 */
export function addPdfsToTray(files, meta = {}) {
  const added = [];
  for (const f of files || []) {
    if (!isPdf(f.name, f.type)) continue;
    added.push(addToTray(f, meta));
  }
  return added;
}

/**
 * 生成产物入架（引擎 run()/本地工具调用）：过滤出 PDF 产物，字节包装为 File。
 * @param {Array<{name:string, mime?:string, bytes:Uint8Array|Blob}>|undefined} artifacts
 * @returns {number} 新入架数量
 */
export function addResultArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return 0;
  let n = 0;
  for (const a of artifacts) {
    if (!a || !isPdf(a.name, a.mime) || a.bytes == null) continue;
    const mime = a.mime || 'application/pdf';
    const blob = a.bytes instanceof Blob ? a.bytes : new Blob([a.bytes], { type: mime });
    const file = a.bytes instanceof File && isPdf(a.bytes.name, a.bytes.type)
      ? a.bytes
      : new File([blob], a.name, { type: mime });
    const before = items.length;
    addToTray(file, { source: 'result', name: a.name, mime });
    if (items.length > before) n += 1;
  }
  return n;
}

/** @returns {boolean} 是否真的移除了 */
export function removeFromTray(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  items.splice(i, 1);
  emit();
  return true;
}

export function clearTray() {
  items.length = 0;
  emit();
}

/** 按拖放携带的 id 列表还原 File（丢给左侧编辑区的 addFiles） */
export function resolveTrayFiles(ids) {
  return (ids || []).map((id) => getTrayItem(id)?.file).filter(Boolean);
}
