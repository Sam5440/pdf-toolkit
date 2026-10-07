// PDF 暂存区数据层：跨页面导航持久的文档架（File 引用不复制字节）。
// 上传与生成结果自动镜像到这里；PDF / 图片 / 其他产物均可入架。
// 支持文件夹分组（类文件管理），全部内容经 IndexedDB（tray-store）持久化，
// 刷新/重启浏览器后自动恢复。文件全部留在浏览器本机，不出网络。
import { uid } from './format.js';
import { log } from './logs.js';

/** 暂存项内部拖放的数据类型（dragstart/drop 约定） */
export const TRAY_MIME = 'application/x-pdf-toolkit-tray';

/** 暂存项：{id, name, size, mime, file:File, addedAt, source:'upload'|'result'|'restored', folder:string} */
const items = [];

/** 文件夹集合：path → {path, addedAt}（空文件夹也持久化） */
const folders = new Map();

const listeners = new Set();

let hydrated = false;
let persistEnabled = false; // 水合完成前不写回，避免启动竞态覆盖存储

function emit() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 订阅方异常不影响其他 */ }
  }
}

function openStore() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null); // node 单测环境
  return import('./tray-store.js').catch((e) => {
    log('tray', '暂存区存储不可用（本次会话不持久化）', { level: 'warn', detail: String(e?.message || e) });
    return null;
  });
}

function persistPut(item) {
  if (!persistEnabled) return;
  openStore().then((m) => m?.putItem({
    id: item.id, name: item.name, mime: item.mime, size: item.size,
    blob: item.file, addedAt: item.addedAt, source: item.source, folder: item.folder,
  })).catch((e) => log('tray', '暂存区写入失败', { level: 'warn', detail: String(e?.message || e) }));
}

function persistDelete(id) {
  if (!persistEnabled) return;
  openStore().then((m) => m?.deleteItem(id)).catch(() => { /* 存储层已记日志 */ });
}

export function onTrayChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isPdf(name, mime) {
  return /\.pdf$/i.test(String(name || '')) || String(mime || '') === 'application/pdf';
}

/** 预览器可渲染的类型：PDF（分页）或图片（直接显示）；MIME 缺失时按扩展名推断 */
export function isPreviewable(item) {
  const mime = inferMime(item.name, item.mime);
  return mime === 'application/pdf' || mime.startsWith('image/');
}

const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
};

/** 按扩展名推断 MIME（产物常缺 mime 字段） */
function inferMime(name, mime) {
  if (mime) return mime;
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (IMG_MIME[ext]) return IMG_MIME[ext];
  if (ext === 'zip') return 'application/zip';
  return 'application/octet-stream';
}

/** 规范化文件夹路径：去首尾空白与斜杠、折叠连续斜杠 */
export function normalizeFolderPath(p) {
  return String(p || '').trim().replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').slice(0, 80);
}

export function trayItems() { return [...items]; }
export function trayCount() { return items.length; }
export function trayBytes() { return items.reduce((s, i) => s + (i.size || 0), 0); }
export function getTrayItem(id) { return items.find((i) => i.id === id) || null; }

/** 文件夹清单（含每个文件夹的条目统计），按名称排序；根目录不在其中 */
export function trayFolders() {
  return [...folders.values()]
    .map((f) => {
      const members = items.filter((i) => i.folder === f.path);
      return { path: f.path, count: members.length, bytes: members.reduce((s, i) => s + (i.size || 0), 0) };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

/** 新建文件夹（幂等）：返回是否新建 */
export function createTrayFolder(path) {
  const p = normalizeFolderPath(path);
  if (!p) return false;
  if (folders.has(p)) return false;
  folders.set(p, { path: p, addedAt: Date.now() });
  if (persistEnabled) openStore().then((m) => m?.putFolder(p)).catch(() => {});
  emit();
  return true;
}

/** 移动暂存项到文件夹（'' = 根目录；目标不存在时自动创建） */
export function setTrayItemFolder(id, folderPath) {
  const it = getTrayItem(id);
  if (!it) return false;
  const p = normalizeFolderPath(folderPath);
  if (p && !folders.has(p)) createTrayFolder(p);
  it.folder = p;
  persistPut(it);
  emit();
  return true;
}

/** 重命名文件夹（级联子路径），返回受影响条目数 */
export function renameTrayFolder(oldPath, newPathRaw) {
  const from = normalizeFolderPath(oldPath);
  const to = normalizeFolderPath(newPathRaw);
  if (!from || !to || from === to) return 0;
  if (to === from || to.startsWith(`${from}/`)) return 0; // 不能移进自己的子目录
  if (folders.has(to)) return 0; // 目标已存在，避免合并歧义
  const affected = [];
  for (const it of items) {
    if (it.folder === from || it.folder?.startsWith(`${from}/`)) {
      it.folder = to + it.folder.slice(from.length);
      affected.push(it);
    }
  }
  // 文件夹本体（含子路径）改名
  for (const p of [...folders.keys()]) {
    if (p === from || p.startsWith(`${from}/`)) {
      const np = to + p.slice(from.length);
      folders.delete(p);
      folders.set(np, { path: np, addedAt: Date.now() });
    }
  }
  persistFolderRewrite(affected);
  emit();
  return affected.length;
}

/** 删除文件夹：其中条目移回根目录，返回移回的条目数 */
export function removeTrayFolder(path) {
  const p = normalizeFolderPath(path);
  if (!p || !folders.has(p)) return 0;
  const affected = items.filter((it) => it.folder === p || it.folder?.startsWith(`${p}/`));
  for (const it of affected) {
    it.folder = '';
    persistPut(it);
  }
  for (const fp of [...folders.keys()]) {
    if (fp === p || fp.startsWith(`${p}/`)) {
      folders.delete(fp);
      if (persistEnabled) openStore().then((m) => m?.deleteFolder(fp)).catch(() => {});
    }
  }
  emit();
  return affected.length;
}

/** 文件夹改名/条目移动后批量重写持久层 */
function persistFolderRewrite(affectedItems) {
  if (!persistEnabled) return;
  openStore().then(async (m) => {
    if (!m) return;
    await m.updateFolders(affectedItems.map((it) => ({
      id: it.id, name: it.name, mime: it.mime, size: it.size,
      blob: it.file, addedAt: it.addedAt, source: it.source, folder: it.folder,
    })));
    for (const f of folders.values()) await m.putFolder(f.path);
  }).catch(() => { /* 存储层已记日志 */ });
}

/**
 * 入架一个文件。同一 File 对象重复入架会被识别并返回已有项（从暂存区拖回编辑区时不产生二份）。
 * @param {File|Blob} file
 * @param {{source?:'upload'|'result', name?:string, mime?:string, folder?:string}} meta
 */
export function addToTray(file, { source = 'upload', name, mime, folder } = {}) {
  if (file.__trayId) {
    const existing = getTrayItem(file.__trayId);
    if (existing) return existing;
  }
  const fname = name ?? file.name ?? '未命名文件';
  const item = {
    id: uid('tray'),
    name: fname,
    size: file.size ?? 0,
    mime: inferMime(fname, mime ?? file.type ?? ''),
    file,
    addedAt: Date.now(),
    source,
    folder: normalizeFolderPath(folder),
  };
  try { file.__trayId = item.id; } catch { /* 只读对象忽略 */ }
  items.push(item);
  if (item.folder && !folders.has(item.folder)) createTrayFolder(item.folder);
  persistPut(item);
  enforceQuota();
  emit();
  return item;
}

/**
 * 批量入架文件（上传镜像入口）。接受全部类型（PDF/图片/文档等），逐个跳过无效项。
 * @param {File[]} files
 * @param {{source?:'upload'|'result', folder?:string}} meta
 * @returns {object[]} 实际入架的项
 */
export function addFilesToTray(files, meta = {}) {
  const added = [];
  for (const f of files || []) {
    if (!f || (f.size ?? 0) < 0) continue;
    added.push(addToTray(f, meta));
  }
  return added;
}

/**
 * 生成产物入架（引擎 run()/本地工具调用）：字节包装为 File，全部入架。
 * @param {Array<{name:string, mime?:string, bytes:Uint8Array|Blob}>|undefined} artifacts
 * @param {{folder?:string}} [opts] 多产物归档文件夹（由调用方传「工具名 · 来源文档」）
 * @returns {number} 新入架数量
 */
export function addResultArtifacts(artifacts, opts = {}) {
  if (!Array.isArray(artifacts)) return 0;
  let n = 0;
  for (const a of artifacts) {
    if (!a || a.bytes == null) continue;
    const mime = inferMime(a.name, a.mime);
    const blob = a.bytes instanceof Blob ? a.bytes : new Blob([a.bytes], { type: mime });
    const file = a.bytes instanceof File
      ? a.bytes
      : new File([blob], a.name, { type: mime });
    const before = items.length;
    addToTray(file, { source: 'result', name: a.name, mime, folder: opts.folder });
    if (items.length > before) n += 1;
  }
  return n;
}

/** @returns {boolean} 是否真的移除了 */
export function removeFromTray(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const [it] = items.splice(i, 1);
  persistDelete(it.id);
  emit();
  return true;
}

export function clearTray() {
  items.length = 0;
  folders.clear();
  emit();
  if (persistEnabled) openStore().then((m) => m?.clearItems()).catch(() => {});
}

/** 按拖放携带的 id 列表还原 File（丢给左侧编辑区的 addFiles） */
export function resolveTrayFiles(ids) {
  return (ids || []).map((id) => getTrayItem(id)?.file).filter(Boolean);
}

/** 启动水合：从 IndexedDB 恢复暂存项与文件夹（幂等；与水合前的内存项合并） */
export async function hydrateTray() {
  if (hydrated) return;
  hydrated = true;
  if (typeof indexedDB === 'undefined') return;
  try {
    const m = await openStore();
    if (!m) return;
    const { items: recs, folders: paths } = await m.loadAll();
    const known = new Set(items.map((i) => i.id));
    for (const rec of recs) {
      if (known.has(rec.id)) continue;
      items.push({
        id: rec.id,
        name: rec.name || rec.blob?.name || '未命名文件',
        size: rec.size ?? rec.blob?.size ?? 0,
        mime: rec.mime || rec.blob?.type || '',
        file: rec.blob,
        addedAt: rec.addedAt || Date.now(),
        source: 'restored',
        folder: rec.folder || '',
      });
    }
    for (const p of paths) {
      if (!folders.has(p)) folders.set(p, { path: p, addedAt: 0 });
    }
    log('tray', `已恢复暂存区：${recs.length} 个文件、${paths.length} 个文件夹`);
  } catch (e) {
    log('tray', '暂存区恢复失败（本次会话从空开始）', { level: 'warn', detail: String(e?.message || e) });
  } finally {
    persistEnabled = true;
    emit();
  }
}

/** 供一键重置：清空内存并删除持久层 */
export async function resetTrayStorage() {
  items.length = 0;
  folders.clear();
  hydrated = true;
  persistEnabled = true;
  emit();
  try {
    const m = await openStore();
    await m?.destroyDB();
  } catch { /* 删除失败不阻塞重置 */ }
}

/** 配额：超出设置上限时从最旧开始逐出（历史配额同款策略） */
let quotaRunning = false;
async function enforceQuota() {
  if (quotaRunning || !persistEnabled) return;
  quotaRunning = true;
  try {
    const { getSettings } = await import('./settings.js');
    const quota = (getSettings().trayQuotaMB || 1024) * 1024 * 1024;
    let total = items.reduce((s, i) => s + (i.size || 0), 0);
    if (total <= quota) return;
    for (const it of [...items].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
      if (total <= quota) break;
      const idx = items.indexOf(it);
      if (idx >= 0) {
        items.splice(idx, 1);
        persistDelete(it.id);
        total -= it.size || 0;
        log('tray', `超出暂存区配额，已自动移除最早的「${it.name}」`, { level: 'warn' });
      }
    }
    emit();
  } finally {
    quotaRunning = false;
  }
}
