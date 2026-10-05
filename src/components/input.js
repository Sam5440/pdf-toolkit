// 输入文档面板：文件选择/拖拽/列表管理（安全渲染文件名）
import { esc, fmtBytes, baseName } from '../core/format.js';
import { addDocument, getDocument, removeDocument, pickFiles, bindDropzone, validateFile, warnFile } from '../core/files.js';
import { addPdfsToTray } from '../core/tray.js';
import { toast, openModal, button } from './ui.js';
import { iconNode } from './icons.js';

// ---- 内嵌浏览器无文件选择器的引导（全局单例：一次弹窗、防抖动） ----
let pickerHelpLastAt = 0;

function showPickerHelp() {
  const now = Date.now();
  if (now - pickerHelpLastAt < 5000) return;
  pickerHelpLastAt = now;
  const box = document.createElement('div');
  const note = document.createElement('div');
  note.className = 'note';
  note.style.marginBottom = '10px';
  note.textContent = '当前页面似乎运行在内嵌浏览器中，系统文件选择框无法弹出。可以用以下任一方式添加文件：';
  box.appendChild(note);
  const ways = document.createElement('ol');
  ways.style.cssText = 'margin:0 0 14px 18px;font-size:13px;line-height:1.9';
  ways.innerHTML = '<li>把文件从访达（Finder）直接<b>拖放</b>到上传区；</li><li><b>复制本页地址</b>，在 Safari / Chrome 等系统浏览器中打开后使用完整功能。</li>';
  box.appendChild(ways);
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  actions.appendChild(button('复制本页地址', 'btn-primary btn-sm', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('地址已复制，请粘贴到 Safari / Chrome 打开');
    } catch {
      toast(`请手动复制本页地址：${location.href}`, 'ok', 6000);
    }
  }));
  actions.appendChild(button('重试选择文件', 'btn-outline btn-sm', () => {
    box.closest('.modal-mask')?.querySelector('.modal-head button')?.click();
    const dz = document.querySelector('.dropzone') || document.querySelector('[data-tray-upload]');
    if (dz) dz.click();
  }));
  box.appendChild(actions);
  openModal('无法打开文件选择器', box);
}

// ---- 全局粘贴文件通道：最近创建的面板接收 paste 的文件 ----
let activePasteTarget = null;
let pasteBound = false;

function bindPasteOnce() {
  if (pasteBound) return;
  pasteBound = true;
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !activePasteTarget) return;
    e.preventDefault();
    activePasteTarget.addFiles(files);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pdftoolkit:picker-blocked', () => {
    // 工具页上传区或暂存区上传按钮触发的选择器被内嵌浏览器拦截时都给引导
    if (document.querySelector('.dropzone') || document.querySelector('[data-tray-upload]')) showPickerHelp();
  });
}

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
  bindPasteOnce();

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
      // 上传镜像：PDF 默认在右侧暂存区创建一份副本（同一 File 引用，不复制字节）
      if (added.length) addPdfsToTray(added.map((d) => d.file), { source: 'upload' });
      opts.onAdd?.(added);
      return added;
    },
  };
  activePasteTarget = panel;
  return panel;
}

/** 把文件送进当前活跃的输入面板（暂存区「加入」按钮用）；无面板或面板已随旧页面卸载时返回 false */
export function sendToActivePanel(files) {
  const p = activePasteTarget;
  if (!p || !files?.length || !p.el.isConnected) return false;
  p.addFiles(files);
  return true;
}
