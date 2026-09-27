// 文件选择/拖拽与文档注册表：文档只在浏览器内存中，绝不发送到网络。
import { uid, fmtBytes } from './format.js';
import { getSettings } from './settings.js';

/** 输入文档对象：{id, name, size, type, file, info?} */
const documents = new Map();

export function addDocument(file, meta = {}) {
  const doc = {
    id: uid('doc'),
    name: file.name,
    size: file.size,
    type: file.type || meta.mime || '',
    file,
    info: meta.info || null,   // 引擎 doc.open 的结果缓存
    addedAt: Date.now(),
  };
  documents.set(doc.id, doc);
  return doc;
}

export function getDocument(id) { return documents.get(id) || null; }
export function removeDocument(id) { documents.delete(id); }
export function listDocuments() { return [...documents.values()]; }

export function requireDocument(id) {
  const d = documents.get(id);
  if (!d) throw new Error('文档不存在或已被移除，请重新选择文件');
  return d;
}

/** 校验：大小上限（返回 null 表示通过，否则错误消息） */
export function validateFile(f) {
  const s = getSettings();
  const max = s.maxUploadMB * 1024 * 1024;
  if (f.size > max) return `文件 ${f.name}（${fmtBytes(f.size)}）超过上限 ${s.maxUploadMB} MB`;
  return null;
}

export function warnFile(f) {
  const s = getSettings();
  return f.size > s.warnUploadMB * 1024 * 1024;
}

/**
 * 创建 <input type=file> 并触发选择
 * @param {{multiple?:boolean, accept?:string}} opts
 * @returns {Promise<File[]>}
 */
export function pickFiles({ multiple = false, accept = 'application/pdf,.pdf' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(files);
    });
    // 用户取消：focus 恢复后仍无文件则返回空
    window.addEventListener('focus', () => setTimeout(() => {
      if (!input.files?.length && document.body.contains(input)) {
        // 稍等 change 事件
        setTimeout(() => { if (document.body.contains(input)) { input.remove(); resolve([]); } }, 300);
      }
    }, 100), { once: true });
    input.click();
  });
}

/** 为容器绑定拖拽，返回清理函数 */
export function bindDropzone(el, onFiles, { multiple = true, accept = null } = {}) {
  const handler = (files) => {
    let list = [...files];
    if (accept) {
      const ok = list.filter((f) => accept.test(f.name) || accept.test(f.type));
      if (ok.length) list = ok;
    }
    if (!multiple) list = list.slice(0, 1);
    if (list.length) onFiles(list);
  };
  const onDragOver = (e) => { e.preventDefault(); el.classList.add('over'); };
  const onDragLeave = () => el.classList.remove('over');
  const onDrop = (e) => {
    e.preventDefault(); el.classList.remove('over');
    if (e.dataTransfer?.files?.length) handler(e.dataTransfer.files);
  };
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);
  return () => {
    el.removeEventListener('dragover', onDragOver);
    el.removeEventListener('dragleave', onDragLeave);
    el.removeEventListener('drop', onDrop);
  };
}
