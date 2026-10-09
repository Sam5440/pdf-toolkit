// 文件剪贴板（更多 · 实用工具）：任意文件 ⇄ 系统剪贴板，全程本地不经网络。
// 能力边界（2026-10，MDN/web.dev/Chromium 文档与实测结论）：
//   · 图片 → 写 image/png（非 PNG 自动 canvas 转码），几乎所有应用可直接粘贴；
//   · 任意其它文件 → Async Clipboard API「Web 自定义格式」（Chromium 104+，格式名
//     'web <mime>'，ClipboardItem.supports 可探测）：同系统 Chrome/Edge 窗口间可互贴，
//     支持该格式的应用可粘贴，本页「读取剪贴板」亦可取回；附带 text/plain 文件名兜底；
//   · 浏览器安全模型限制：网页无法把任意文件以「真实文件」形态贴进访达/资源管理器
//     （无此 API），需要落盘请在「读取剪贴板」后下载；
//   · paste 事件通道（components/input.js 全局管线）接收系统复制的文件/图片：
//     Windows Chrome/Edge、macOS Safari/Chrome 对访达/资源管理器复制的文件支持良好。
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { button, toast } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { fmtBytes } from '../../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';

// ---------- 纯函数（导出供单测） ----------

/** 规范化 MIME → 'web <mime>'（空/非法类型回退 application/octet-stream） */
export function customFormatName(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return /^[-\w.]+\/[-\w.+]+$/.test(m) ? `web ${m}` : 'web application/octet-stream';
}

const MIME_EXT = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tif',
  'text/plain': 'txt', 'text/html': 'html', 'text/css': 'css', 'text/csv': 'csv',
  'text/markdown': 'md', 'application/json': 'json', 'application/zip': 'zip',
  'application/x-7z-compressed': '7z', 'application/gzip': 'gz', 'application/rtf': 'rtf',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** MIME → 扩展名（未知子类型直接用作扩展名，再不行回退 bin） */
export function extFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const sub = m.includes('/') ? m.split('/')[1] : '';
  return /^[-\w.]{1,12}$/.test(sub) ? sub.replace(/^x-/, '') || 'bin' : 'bin';
}

/**
 * 复制计划：每个文件以何种格式进剪贴板（导出供单测）。
 * 图片全平台只保留一张（OS 剪贴板只有一个图像 flavor）；非图片走自定义格式。
 * @param {Array<{name:string,type:string,size:number}>} files
 * @param {{supportsCustom:boolean}} opts
 * @returns {Array<{name:string, kind:'image'|'custom'|'error', fmt?:string, note?:string, error?:string}>}
 */
export function planCopyFormats(files, { supportsCustom }) {
  let imageTaken = 0;
  return (files || []).map((f) => {
    const type = String(f.type || '').split(';')[0].trim().toLowerCase();
    if (type.startsWith('image/')) {
      imageTaken += 1;
      if (imageTaken > 1) {
        return { name: f.name, kind: 'error', error: '系统剪贴板一次只能保留一张图片，多余图片请分次复制' };
      }
      return {
        name: f.name, kind: 'image', fmt: 'image/png',
        note: type === 'image/png' ? 'PNG 原样写入，任何应用可粘贴' : `${type} 已自动转为 PNG`,
      };
    }
    if (supportsCustom) {
      const fmt = customFormatName(type);
      return {
        name: f.name, kind: 'custom', fmt,
        note: fmt === 'web application/octet-stream'
          ? '未知类型按通用二进制自定义格式写入'
          : '自定义格式写入，Chrome/Edge 与本页「读取剪贴板」可取回',
      };
    }
    return { name: f.name, kind: 'error', error: '当前浏览器不支持复制非图片文件（需 Chrome / Edge 104+）' };
  });
}

/**
 * 从 navigator.clipboard.read() 的返回中提取文件（导出供单测）。
 * 每个条目按 自定义格式 > 图片 > 纯文本 取第一个可用类型；全部条目都无文件级内容时，
 * 回退取第一条 text/plain 存成 .txt。
 * @param {Array<{types:string[], getType:(t:string)=>Promise<Blob>}>} items
 * @param {{stamp?:string}} [opts] 固定时间戳（命名用；缺省取当前 HHmmss）
 * @returns {Promise<File[]>}
 */
export async function clipboardFilesFromItems(items, opts = {}) {
  const stamp = opts.stamp != null ? String(opts.stamp) : new Date().toTimeString().slice(0, 8).replaceAll(':', '');
  const out = [];
  let textFallback = null;
  for (const item of items || []) {
    const types = item?.types || [];
    const custom = types.find((t) => t.startsWith('web '));
    const image = types.find((t) => t.startsWith('image/'));
    const text = types.find((t) => t === 'text/plain');
    const chosen = custom || image;
    if (chosen) {
      const blob = await item.getType(chosen);
      const realMime = chosen.startsWith('web ') ? chosen.slice(4) : chosen;
      out.push(new File([blob], `剪贴板-${stamp}.${extFromMime(realMime)}`, { type: realMime }));
    } else if (text && !textFallback) {
      textFallback = { item, type: text };
    }
  }
  if (!out.length && textFallback) {
    const blob = await textFallback.item.getType('text/plain');
    out.push(new File([blob], `剪贴板文本-${stamp}.txt`, { type: 'text/plain' }));
  }
  return out;
}

// ---------- 运行时能力探测 ----------

function chromiumLike() {
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands)) return brands.some((b) => /Chromium/i.test(b.brand || ''));
  return /Chromium|Edg\//.test(navigator.userAgent || '');
}

/** 当前浏览器剪贴板能力（渲染时探测一次，导出供单测断言形状） */
export function detectClipboardCaps() {
  const hasWrite = !!navigator.clipboard?.write;
  const hasRead = !!navigator.clipboard?.read;
  const hasItem = typeof ClipboardItem !== 'undefined';
  const custom = hasWrite && hasItem && (typeof ClipboardItem.supports === 'function'
    ? ClipboardItem.supports('web application/octet-stream')
    : chromiumLike());
  return { hasWrite, hasRead, custom };
}

// ---------- 图片 → PNG（页面上下文，e2e 覆盖） ----------

async function toPngBlob(file) {
  if (file.type === 'image/png') return file;
  let bmp = null;
  try { bmp = await createImageBitmap(file); } catch { /* SVG 等类型走 <img> 解码 */ }
  if (bmp) {
    const cv = new OffscreenCanvas(Math.max(bmp.width, 1), Math.max(bmp.height, 1));
    cv.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    return cv.convertToBlob({ type: 'image/png' });
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('无法解码该图片')); img.src = url; });
    const cv = document.createElement('canvas');
    cv.width = Math.max(img.naturalWidth, 1);
    cv.height = Math.max(img.naturalHeight, 1);
    cv.getContext('2d').drawImage(img, 0, 0);
    return await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('PNG 转码失败'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

registerTool({
  id: 'clipboard-files',
  name: '文件剪贴板',
  group: 'm-util',
  desc: '把任意文件一键复制到系统剪贴板（图片全平台通用，其它文件走 Chromium 自定义格式可在浏览器间互贴），也可从剪贴板粘贴/读取文件，全程本地',
  accepts: 'any',
  multiple: true,
  render(container) {
    const caps = detectClipboardCaps();

    // ---- 能力说明（诚实呈现边界） ----
    const notice = document.createElement('div');
    notice.className = 'alert alert-warn';
    notice.style.marginTop = '14px';
    const lines = [
      `图片复制后可在几乎所有应用中直接粘贴（自动转 PNG）；${caps.custom ? '其它任意文件以浏览器「Web 自定义格式」写入系统剪贴板，可在 Chrome/Edge 各窗口间互贴，或点「读取剪贴板」取回。' : ''}`,
      '受浏览器安全模型限制，网页无法把任意文件贴成访达/资源管理器里的真实文件；需要落盘请读取后下载。',
      '在本页按 ⌘V / Ctrl+V，系统剪贴板里的文件/图片会自动进入下方文件列表（Windows Chrome/Edge、macOS Safari/Chrome 支持良好）。',
    ].filter(Boolean);
    for (const t of lines) {
      const p = document.createElement('div');
      p.textContent = t;
      notice.appendChild(p);
    }
    if (!caps.custom) {
      const p = document.createElement('div');
      p.textContent = '当前浏览器不支持非图片文件复制（需 Chrome / Edge 104+），图片复制不受影响。';
      notice.appendChild(p);
    }

    // ---- 卡片一：文件列表 + 复制 ----
    const { card: copyCard, body: copyBody } = paramsCard();
    const head1 = document.createElement('b');
    head1.textContent = '复制文件到剪贴板';
    head1.style.display = 'block';
    head1.style.marginBottom = '8px';
    copyBody.appendChild(head1);

    const panel = inputPanel({
      multiple: true,
      accept: '',
      acceptTest: /.*/,
      acceptHint: '支持任意类型文件；全部处理在本机浏览器内完成',
    });
    copyBody.appendChild(panel.el);

    const resultBox = document.createElement('div');

    const copyBtn = button('复制到剪贴板', 'btn-primary', () => execCopy());
    copyBtn.style.cssText = 'width:100%;margin-top:14px';
    copyBtn.disabled = true;
    const syncBtn = () => { copyBtn.disabled = !panel.docs().length; };
    panel.el.addEventListener('input', syncBtn);
    const origAdd = panel.addFiles.bind(panel);
    panel.addFiles = async (files) => { const r = await origAdd(files); syncBtn(); return r; };
    // 移除文件走 .t-x onclick，监听列表变化兜底刷新按钮态
    new MutationObserver(syncBtn).observe(panel.el.querySelector('.file-list'), { childList: true });

    // ---- 卡片二：从剪贴板粘贴 ----
    const { card: pasteCard, body: pasteBody } = paramsCard();
    const head2 = document.createElement('b');
    head2.textContent = '从剪贴板粘贴文件';
    head2.style.display = 'block';
    head2.style.marginBottom = '8px';
    pasteBody.appendChild(head2);
    const tip = document.createElement('div');
    tip.className = 'hint';
    tip.textContent = caps.hasRead
      ? '方式一：直接在本页按 ⌘V / Ctrl+V（访达/资源管理器里复制的文件会经 paste 事件进入上方列表）；方式二：点下方按钮主动读取剪贴板中的图片或自定义格式文件。'
      : '直接在本页按 ⌘V / Ctrl+V，粘贴复制的文件/图片；当前浏览器不支持主动读取剪贴板。';
    pasteBody.appendChild(tip);
    const readBtn = button('读取剪贴板', 'btn-outline', () => execRead());
    readBtn.style.cssText = 'width:100%;margin-top:12px';
    if (!caps.hasRead) readBtn.disabled = true;
    pasteBody.appendChild(readBtn);

    container.append(notice, copyCard, copyBtn, resultBox, pasteCard);

    // ---- 复制执行 ----
    function rowLine(name, note, ok) {
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.textContent = name;
      info.appendChild(nm);
      if (note) {
        const st = document.createElement('div');
        st.className = ok ? 'hint' : 'alert alert-error';
        if (!ok) st.style.marginTop = '4px';
        st.textContent = note;
        info.appendChild(st);
      }
      line.appendChild(info);
      return line;
    }

    async function execCopy() {
      resultBox.replaceChildren();
      const docs = panel.docs();
      if (!docs.length) { toast('请先添加要复制的文件', 'error'); return; }
      if (!caps.hasWrite) { toast('当前浏览器不支持写入剪贴板', 'error'); return; }

      const plan = planCopyFormats(docs.map((d) => d.file), { supportsCustom: caps.custom });
      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      const bodyEl = document.createElement('div');
      bodyEl.className = 'card-body';
      const list = document.createElement('div');
      list.style.marginTop = '10px';
      cardEl.appendChild(bodyEl);
      bodyEl.appendChild(list);
      resultBox.appendChild(cardEl);

      const items = [];
      let fail = 0;
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        if (p.kind === 'error') {
          fail += 1;
          list.appendChild(rowLine(p.name, p.error, false));
          continue;
        }
        try {
          const file = docs[i].file;
          if (p.kind === 'image') {
            items.push(new ClipboardItem({ 'image/png': await toPngBlob(file) }));
          } else {
            items.push(new ClipboardItem({
              [p.fmt]: file,
              'text/plain': new Blob([`${file.name}（${fmtBytes(file.size)}）`], { type: 'text/plain' }),
            }));
          }
          list.appendChild(rowLine(p.name, p.note, true));
        } catch (e) {
          fail += 1;
          list.appendChild(rowLine(p.name, `写入失败：${e.message}`, false));
        }
      }
      if (!items.length) return;
      try {
        await navigator.clipboard.write(items);
      } catch (e) {
        list.appendChild(rowLine('复制失败', `${e.message}（若提示权限被拒，请在浏览器站点设置中允许「剪贴板」；点击页面后立即操作可避免「文档未聚焦」错误）`, false));
        toast('复制到剪贴板失败', 'error');
        return;
      }
      const okCount = items.length;
      const kv = document.createElement('div');
      kv.className = 'kv';
      const b = document.createElement('b');
      b.textContent = `复制成功：${okCount} 个文件已进入系统剪贴板${fail ? `（${fail} 个失败）` : ''}`;
      kv.appendChild(b);
      bodyEl.insertBefore(kv, list);

      recordTaskOrButton({
        tool: 'clipboard-files', toolName: '文件剪贴板',
        docNames: docs.map((d) => d.name),
        options: { 成功: okCount, ...(fail ? { 失败: fail } : {}) },
        docs,
        outputs: [],
        form: capturePageForm(),
      }).then((btn) => {
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
        if (btn) actions.appendChild(btn);
        else actions.appendChild(recordNote());
        bodyEl.appendChild(actions);
      }).catch(() => { /* 记录失败不阻塞结果展示 */ });
    }

    // ---- 读取剪贴板 ----
    async function execRead() {
      let items;
      try {
        items = await navigator.clipboard.read();
      } catch (e) {
        toast(`读取剪贴板失败：${e.message}（需在站点权限中允许读取剪贴板）`, 'error');
        return;
      }
      let files;
      try {
        files = await clipboardFilesFromItems(items);
      } catch (e) {
        toast(`读取剪贴板内容失败：${e.message}`, 'error');
        return;
      }
      if (!files.length) {
        toast('剪贴板里没有可取的文件内容（纯文本请用「文本加解密」等工具处理）', 'error');
        return;
      }
      await panel.addFiles(files);
      toast(`已从剪贴板取到 ${files.length} 个文件，已加入列表`);
    }
  },
});
