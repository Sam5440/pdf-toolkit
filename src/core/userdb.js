// 网页端用户数据库：聚合本机全部应用数据 —— localStorage（设置/收藏/最近/工作流）
// + IndexedDB（历史含输入输出文件、暂存区含文件夹、外挂字体），打包为 ZIP 导出，
// 再从 ZIP 原样导入恢复。全部字节在本机进出，不经网络。引擎 WASM 缓存可重新
// 下载，不纳入备份。
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { APP_VERSION } from './version.js';
import { loadAll as trayLoadAll } from './tray-store.js';
import { listHistory, historyUsedBytes } from './history.js';
import { trayItems, trayBytes } from './tray.js';
import { listUserFonts } from './userfonts.js';
import { listWorkflows } from './workflows.js';
import { listUploads, uploadsUsedBytes, ensureUploadStore } from './uploads.js';

const SCHEMA = 1;

// ---------- 小工具 ----------

function idbOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库被其他标签页占用'));
  });
}

async function idbGetAll(dbName, storeName) {
  if (typeof indexedDB === 'undefined') return [];
  const db = await idbOpen(dbName);
  try {
    return (await new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  } finally {
    db.close();
  }
}

async function idbRewrite(dbName, storeName, records) {
  const db = await idbOpen(dbName);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const os = tx.objectStore(storeName);
      os.clear();
      for (const r of records) os.put(r);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('写入被中止'));
    });
  } finally {
    db.close();
  }
}

/** ZIP 内路径段清洗：去路径分隔符与超长（保留中文） */
function seg(s) {
  return String(s || 'file').replace(/[/\\]+/g, '_').slice(0, 80) || 'file';
}

async function blobU8(blob) {
  if (!blob) return new Uint8Array();
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  return new Uint8Array(await blob.arrayBuffer());
}

function readLocalStorage() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('pdftoolkit')) continue;
      out[k] = localStorage.getItem(k);
    }
  } catch { /* 隐私模式 */ }
  return out;
}

// ---------- 导出 ----------

/**
 * 收集全部本机数据（不含引擎缓存）。
 * @returns {Promise<{manifest, localStorage, history, tray, fonts, files:Map<string,Uint8Array>}>}
 */
export async function collectAll() {
  const files = new Map();
  // 历史：blob 拆出为文件
  const historyRaw = await idbGetAll('pdftoolkit', 'history');
  const history = historyRaw.map((r) => {
    const strip = (list, kind, rid) => (list || []).map((o, i) => {
      const p = `history/${seg(rid)}/${kind}-${String(i).padStart(2, '0')}__${seg(o.name)}`;
      files.set(p, o.blob);
      return { name: o.name, mime: o.mime, size: o.size, __file: p };
    });
    return {
      id: r.id, time: r.time, tool: r.tool, toolName: r.toolName,
      docNames: r.docNames || [], options: r.options ?? null,
      warnings: r.warnings || [], form: r.form || [], auto: !!r.auto,
      inputs: strip(r.inputs, 'in', r.id),
      outputs: strip(r.outputs, 'out', r.id),
    };
  });
  // 暂存区
  const trayStore = await trayLoadAll().catch(() => ({ items: [], folders: [] }));
  const trayItemsMeta = trayStore.items.map((it) => {
    const p = `tray/${seg(it.id)}__${seg(it.name)}`;
    files.set(p, it.blob);
    return { id: it.id, name: it.name, mime: it.mime, size: it.size, addedAt: it.addedAt, source: it.source, folder: it.folder || '', __file: p };
  });
  // 外挂字体
  const fontsRaw = await idbGetAll('pdftoolkit-fonts', 'fonts').catch(() => []);
  const fonts = fontsRaw.map((f) => {
    const p = `fonts/${seg(f.id)}__${seg(f.name)}`;
    files.set(p, f.bytes);
    return { id: f.id, name: f.name, family: f.family || '', size: f.size, source: f.source, addedAt: f.addedAt, __file: p };
  });
  // 上传登记册（图床/文件床；bytes 拆出为文件）
  const uploadsRaw = await idbGetAll('pdftoolkit-uploads', 'files').catch(() => []);
  const uploads = uploadsRaw.map((r) => {
    let __file = null;
    if (r.bytes) {
      __file = `uploads/${seg(r.id)}__${seg(r.name)}`;
      files.set(__file, r.bytes);
    }
    return {
      id: r.id, ts: r.ts, name: r.name, size: r.size, type: r.type,
      service: r.service, host: r.host, url: r.url, apiUrl: r.apiUrl || '',
      lastCheck: r.lastCheck || null, __file,
    };
  });
  return {
    manifest: {
      app: 'pdf-toolkit',
      schema: SCHEMA,
      version: APP_VERSION,
      exportedAt: Date.now(),
      counts: {
        history: history.length,
        trayItems: trayItemsMeta.length,
        fonts: fonts.length,
        uploads: uploads.length,
        settingsKeys: Object.keys(readLocalStorage()).length,
      },
    },
    localStorage: readLocalStorage(),
    history,
    tray: { items: trayItemsMeta, folders: trayStore.folders },
    fonts,
    uploads,
    files,
  };
}

/** 导出全部数据为 ZIP Blob */
export function exportAll() {
  return collectAll().then(async (all) => {
    const data = {
      'manifest.json': strToU8(JSON.stringify(all.manifest)),
      'localstorage.json': strToU8(JSON.stringify(all.localStorage)),
      'history.json': strToU8(JSON.stringify(all.history)),
      'tray.json': strToU8(JSON.stringify(all.tray)),
      'fonts.json': strToU8(JSON.stringify(all.fonts)),
      'uploads.json': strToU8(JSON.stringify(all.uploads)),
    };
    for (const [p, blob] of all.files) data[p] = await blobU8(blob);
    // 已是压缩字节（PDF/字体），level 0 仅打包不再压缩；同步打包与 downloadZip 同路径
    const u8 = zipSync(data, { level: 0 });
    return new Blob([u8], { type: 'application/zip' });
  });
}

/** 生成导出文件名 */
export function backupName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `pdftoolkit-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

// ---------- 导入 ----------

/**
 * 从导出的 ZIP 恢复全部数据（覆盖本机现有数据）。
 * @param {File|Blob|Uint8Array} file
 * @returns {Promise<{manifest:object, restored:{settings:number,history:number,tray:number,fonts:number}}>}
 */
export async function importAll(file) {
  const u8 = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  let entries;
  try {
    entries = unzipSync(u8);
  } catch {
    throw new Error('不是有效的备份包');
  }
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  if (manifest.app !== 'pdf-toolkit' || manifest.schema > SCHEMA) {
    throw new Error('备份包版本不兼容');
  }
  const lsData = entries['localstorage.json'] ? JSON.parse(strFromU8(entries['localstorage.json'])) : {};
  const history = entries['history.json'] ? JSON.parse(strFromU8(entries['history.json'])) : [];
  const tray = entries['tray.json'] ? JSON.parse(strFromU8(entries['tray.json'])) : { items: [], folders: [] };
  const fonts = entries['fonts.json'] ? JSON.parse(strFromU8(entries['fonts.json'])) : [];
  const uploads = entries['uploads.json'] ? JSON.parse(strFromU8(entries['uploads.json'])) : [];
  const fileRec = (meta) => {
    if (!meta?.__file) return null;
    const u = entries[meta.__file];
    return u ? new Blob([u], { type: meta.mime || 'application/octet-stream' }) : null;
  };

  // 1) localStorage（只覆盖应用键）
  try {
    const rm = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('pdftoolkit')) rm.push(k);
    }
    rm.forEach((k) => localStorage.removeItem(k));
    for (const [k, v] of Object.entries(lsData)) localStorage.setItem(k, v);
  } catch { /* 隐私模式 */ }

  // 2) 历史
  const historyRecs = history.map((r) => ({
    id: r.id, time: r.time, tool: r.tool, toolName: r.toolName,
    docNames: r.docNames || [], options: r.options ?? null,
    warnings: r.warnings || [], form: r.form || [], auto: !!r.auto,
    inputs: (r.inputs || []).map((o) => ({ ...o, blob: fileRec(o) })).filter((o) => o.blob),
    outputs: (r.outputs || []).map((o) => ({ ...o, blob: fileRec(o) })).filter((o) => o.blob),
  }));
  await idbRewrite('pdftoolkit', 'history', historyRecs);

  // 3) 暂存区（File 包装便于下载/复用）
  const trayRecs = (tray.items || []).map((it) => ({
    id: it.id, name: it.name, mime: it.mime, size: it.size,
    blob: fileRec(it) || new Blob(), addedAt: it.addedAt || 0,
    source: it.source || 'restored', folder: it.folder || '',
  }));
  const trayFolders = (tray.folders || []).map((path) => ({ path, addedAt: 0 }));
  await idbRewrite('pdftoolkit-tray', 'items', trayRecs);
  await idbRewrite('pdftoolkit-tray', 'folders', trayFolders);

  // 4) 字体
  const fontRecs = fonts.map((f) => ({ ...f, bytes: entries[f.__file] })).filter((f) => f.bytes);
  if (fontRecs.length) await idbRewrite('pdftoolkit-fonts', 'fonts', fontRecs);

  // 5) 上传登记册（无备份文件时清空，保持与其它区一致的覆盖语义）
  await ensureUploadStore(); // 库不存在时先建 store，idbRewrite 无 upgrade 回调
  const uploadRecs = uploads.map((r) => ({
    id: r.id, ts: r.ts || 0, name: r.name, size: r.size || 0, type: r.type || '',
    service: r.service || '', host: r.host || '', url: r.url || '', apiUrl: r.apiUrl || '',
    lastCheck: r.lastCheck || null,
    bytes: r.__file && entries[r.__file] ? new Blob([entries[r.__file]], { type: r.type || 'application/octet-stream' }) : null,
  }));
  await idbRewrite('pdftoolkit-uploads', 'files', uploadRecs);

  return {
    manifest,
    restored: {
      settings: Object.keys(lsData).length,
      history: historyRecs.length,
      tray: trayRecs.length,
      fonts: fontRecs.length,
      uploads: uploadRecs.length,
    },
  };
}

// ---------- 概览 ----------

/** 各存储区概览（数据页展示用） */
export async function storageSummary() {
  const [history, histBytes, fonts, upItems, upBytes] = await Promise.all([
    listHistory({ limit: 100000 }),
    historyUsedBytes(),
    listUserFonts(),
    listUploads().catch(() => []),
    uploadsUsedBytes().catch(() => 0),
  ]);
  let lsKeys = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith('pdftoolkit')) lsKeys++;
    }
  } catch { /* 忽略 */ }
  return {
    history: { count: history.length, bytes: histBytes },
    tray: { count: trayItems().length, bytes: trayBytes() },
    fonts: { count: fonts.length, bytes: fonts.reduce((s, f) => s + (f.size || 0), 0) },
    uploads: { count: upItems.length, bytes: upBytes },
    workflows: { count: listWorkflows().length },
    localStorageKeys: lsKeys,
  };
}
