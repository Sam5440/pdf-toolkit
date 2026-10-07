// 暂存区持久化层（IndexedDB，独立 DB 避免与历史记录的版本升级互相牵制）。
// 记录：{id, name, mime, size, blob, addedAt, source, folder}，File/Blob 可直接
// 结构化克隆入库存放；文件夹清单单独一个 store（空文件夹也要持久化）。
// 仅存于本机浏览器，不出网络。

const DB_NAME = 'pdftoolkit-tray';
const DB_VERSION = 1;
const ITEMS = 'items';
const FOLDERS = 'folders';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('tray 数据库被其他标签页占用'));
  });
  return dbPromise;
}

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

/** 全量读回（启动水合） */
export async function loadAll() {
  const db = await openDB();
  const [items, folders] = await Promise.all([
    req2p(store(db, ITEMS, 'readonly').getAll()),
    req2p(store(db, FOLDERS, 'readonly').getAll()),
  ]);
  return {
    items: (items || []).filter((it) => it && it.id && it.blob),
    folders: (folders || []).map((f) => f.path).filter(Boolean),
  };
}

export async function putItem(rec) {
  const db = await openDB();
  await req2p(store(db, ITEMS, 'readwrite').put({
    id: rec.id, name: rec.name, mime: rec.mime, size: rec.size,
    blob: rec.blob, addedAt: rec.addedAt, source: rec.source, folder: rec.folder || '',
  }));
}

export async function deleteItem(id) {
  const db = await openDB();
  await req2p(store(db, ITEMS, 'readwrite').delete(id));
}

/** 批量更新 folder 字段（文件夹重命名/移动用） */
export async function updateFolders(records) {
  const db = await openDB();
  const os = store(db, ITEMS, 'readwrite');
  await Promise.all(records.map((rec) => req2p(os.put(rec))));
}

export async function clearItems() {
  const db = await openDB();
  await Promise.all([
    req2p(store(db, ITEMS, 'readwrite').clear()),
    req2p(store(db, FOLDERS, 'readwrite').clear()),
  ]);
}

export async function putFolder(path) {
  const db = await openDB();
  await req2p(store(db, FOLDERS, 'readwrite').put({ path, addedAt: Date.now() }));
}

export async function deleteFolder(path) {
  const db = await openDB();
  await req2p(store(db, FOLDERS, 'readwrite').delete(path));
}

/** 供一键重置：删整个数据库 */
export async function destroyDB() {
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
