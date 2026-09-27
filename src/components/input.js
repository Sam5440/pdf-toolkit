// 输入文档面板：文件选择/拖拽/列表管理（安全渲染文件名）
import { esc, fmtBytes, baseName } from '../core/format.js';
import { addDocument, getDocument, removeDocument, pickFiles, bindDropzone, validateFile, warnFile } from '../core/files.js';
import { toast } from './ui.js';
import { iconNode } from './icons.js';

/**
 * 创建输入文档面板
 * @param {{multiple?:boolean, accept?:string, acceptTest?:RegExp, acceptHint?:string, onAdd?:Function, onRemove?:Function, title?:string}} opts
 * @returns {{el, docs():object[], clear(), addFiles(files):Promise<object[]>}}
 */
export function inputPanel(opts = {}) {
  const multiple = opts.multiple ?? true;
  const accept = opts.accept ?? 'application/pdf,.pdf';
  const acceptTest = opts.acceptTest ?? /\.(pdf)$/i;
  const state = { docs: [] };

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="dropzone" tabindex="0" role="button" aria-label="选择文件">
      <div class="dz-ico"></div>
      <div class="dz-main">点击选择或拖入文件</div>
      <div class="dz-sub">${esc(opts.acceptHint || '支持 PDF，全部处理在本地浏览器完成')}</div>
    </div>
    <div class="file-list" style="margin-top:10px"></div>`;
  const dz = el.querySelector('.dropzone');
  dz.querySelector('.dz-ico').appendChild(iconNode('upload'));
  const list = el.querySelector('.file-list');

  dz.onclick = () => dz._pick();
  dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dz._pick(); } };
  dz._pick = async () => {
    const files = await pickFiles({ multiple, accept });
    await panel.addFiles(files);
  };
  bindDropzone(dz, (files) => panel.addFiles(files), { multiple });

  function renderList() {
    list.innerHTML = '';
    if (!state.docs.length) return;
    for (const d of state.docs) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.innerHTML = `<span class="t-name" title="${esc(d.name)}">${esc(d.name)}</span>
        <span class="muted-sm">${fmtBytes(d.size)}</span>
        ${warnFile(d.file) ? '<span class="badge badge-warn">大文件</span>' : ''}
        <span class="t-x" role="button" aria-label="移除 ${esc(d.name)}">✕</span>`;
      tag.querySelector('.t-x').onclick = () => {
        removeDocument(d.id);
        state.docs = state.docs.filter((x) => x.id !== d.id);
        renderList();
        opts.onRemove?.(d);
      };
      list.appendChild(tag);
    }
  }

  const panel = {
    el,
    docs: () => [...state.docs],
    clear() {
      for (const d of state.docs) removeDocument(d.id);
      state.docs = [];
      renderList();
    },
    async addFiles(files) {
      const added = [];
      for (const f of files) {
        if (!acceptTest.test(f.name) && !acceptTest.test(f.type)) {
          toast(`跳过 ${f.name}：不支持的文件类型`, 'error');
          continue;
        }
        const err = validateFile(f);
        if (err) { toast(err, 'error'); continue; }
        const doc = addDocument(f);
        state.docs.push(doc);
        added.push(doc);
      }
      renderList();
      opts.onAdd?.(added);
      return added;
    },
  };
  return panel;
}
