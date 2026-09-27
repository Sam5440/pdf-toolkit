// 图片转 PDF — 多图缩略图排序（HTML5 拖拽 + 上移/下移双保险）、纸张/方向/边距/适应方式
import { iconNode } from '../components/icons.js';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import {
  progressCard, warningsBox, toast, field, select, numberInput, textInput, row, button,
} from '../components/ui.js';
import { fmtBytes } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact } from '../core/download.js';
import { removeDocument } from '../core/files.js';

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
};

registerTool({
  id: 'images2pdf',
  name: '图片转 PDF',
  group: 'convert',
  desc: '多图排序、纸张/边距/适应方式，EXIF 方向识别',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { items: [] }; // {doc, url}

    const panel = inputPanel({
      multiple: true,
      accept: 'image/*',
      acceptTest: /\.(jpe?g|png|webp|gif|bmp|avif)$/i,
      acceptHint: '支持 JPG/PNG/WebP/GIF/BMP（TIFF 浏览器无法解码）',
      onAdd(added) {
        for (const d of added) state.items.push({ doc: d, url: URL.createObjectURL(d.file) });
        renderItems();
      },
    });
    // 面板自带 tag 列表隐藏，用下方缩略图列表代替（排序/移除都在这里）
    panel.el.querySelector('.file-list').style.display = 'none';

    // ---- 图片列表（缩略图 + 拖拽排序 + 上移/下移 + 移除） ----
    const listBox = document.createElement('div');
    listBox.className = 'card';
    listBox.style.marginTop = '14px';
    const listHead = document.createElement('div');
    listHead.className = 'card-body';
    listHead.style.paddingBottom = '8px';
    const listTitle = document.createElement('b');
    listTitle.style.fontSize = '13.5px';
    listTitle.textContent = '图片顺序（拖拽或箭头调整，转 PDF 后按此排序）';
    listHead.appendChild(listTitle);
    const listEl = document.createElement('div');
    listEl.style.marginTop = '4px';
    listBox.append(listHead, listEl);

    let dragIdx = -1;

    function move(from, to) {
      if (from === to || from < 0 || from >= state.items.length) return;
      const [it] = state.items.splice(from, 1);
      state.items.splice(Math.max(0, Math.min(state.items.length, to)), 0, it);
      renderItems();
    }

    function removeItem(i) {
      const [it] = state.items.splice(i, 1);
      if (it) {
        removeDocument(it.doc.id);
        URL.revokeObjectURL(it.url);
      }
      renderItems();
    }

    function renderItems() {
      listEl.innerHTML = '';
      dragIdx = -1;
      if (!state.items.length) {
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = '尚未添加图片';
        listEl.appendChild(empty);
      }
      state.items.forEach((it, i) => {
        const item = document.createElement('div');
        item.className = 'img-item';
        item.draggable = true;
        item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;background:var(--card);cursor:grab';
        item.setAttribute('data-img-name', it.doc.name);

        const idx = document.createElement('span');
        idx.style.cssText = 'min-width:20px;text-align:center;font-weight:700;color:var(--primary)';
        idx.textContent = String(i + 1);

        const thumb = document.createElement('img');
        thumb.src = it.url;
        thumb.alt = '';
        thumb.style.cssText = 'width:44px;height:44px;object-fit:contain;border-radius:5px;background:var(--bg-soft);flex-shrink:0';

        const meta = document.createElement('div');
        meta.style.cssText = 'flex:1;min-width:0';
        const nm = document.createElement('div');
        nm.style.cssText = 'font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        nm.textContent = it.doc.name;
        const sz = document.createElement('div');
        sz.className = 'muted-sm';
        sz.textContent = fmtBytes(it.doc.size);
        meta.append(nm, sz);

        const ops = document.createElement('div');
        ops.style.cssText = 'display:flex;gap:4px;flex-shrink:0';
        const up = button('上移', 'btn-ghost btn-sm', () => move(i, i - 1));
        const down = button('下移', 'btn-ghost btn-sm', () => move(i, i + 1));
        const del = button('移除', 'btn-ghost btn-sm', () => removeItem(i));
        up.disabled = i === 0;
        down.disabled = i === state.items.length - 1;
        del.style.color = 'var(--no)';
        ops.append(up, down, del);

        item.append(idx, thumb, meta, ops);

        item.addEventListener('dragstart', (e) => {
          dragIdx = i;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          item.style.opacity = '0.45';
        });
        item.addEventListener('dragend', () => { item.style.opacity = ''; });
        item.addEventListener('dragover', (e) => { e.preventDefault(); item.style.borderColor = 'var(--primary)'; });
        item.addEventListener('dragleave', () => { item.style.borderColor = 'var(--border)'; });
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          item.style.borderColor = 'var(--border)';
          const from = dragIdx >= 0 ? dragIdx : parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (!Number.isNaN(from)) move(from, i);
        });

        listEl.appendChild(item);
      });
      goBtn.disabled = state.items.length === 0;
    }

    // ---- 参数 ----
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const paperSel = select([
      { value: 'auto', label: '自动（按图片尺寸）' },
      { value: 'a4', label: 'A4' },
      { value: 'letter', label: 'Letter' },
      { value: 'a5', label: 'A5' },
      { value: 'a3', label: 'A3' },
    ], 'a4');
    const oriSel = select([
      { value: 'auto', label: '自动' },
      { value: 'portrait', label: '纵向' },
      { value: 'landscape', label: '横向' },
    ], 'auto');
    const marginInp = numberInput(24, { min: 0, max: 300, step: 1 });
    const fitSel = select([
      { value: 'contain', label: '适应页面（contain 留白）' },
      { value: 'cover', label: '填充裁切（cover）' },
    ], 'contain');
    const bgInp = textInput('', '如 #ffffff（留空 = 不加背景）');

    body.append(
      row(field('纸张', paperSel), field('方向', oriSel)),
      field('页边距（pt，仅固定纸张生效）', marginInp, '图片与页面边缘的留白，0-300'),
      field('适应方式', fitSel),
      field('背景色（透明图片的底色）', bgInp, '留空则不加背景矩形；示例 #ffffff / #f5f5f5'),
    );
    controls.appendChild(body);

    // ---- 执行 ----
    const goBtn = button('开始转换', 'btn-primary', () => doConvert());
    goBtn.style.cssText = 'width:100%;margin-top:14px';

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(panel.el, listBox, controls, goBtn, resultBox);
    renderItems();

    async function doConvert() {
      const items = [...state.items];
      resultBox.innerHTML = '';
      if (!items.length) { toast('请先添加图片', 'error'); return; }
      const bgRaw = bgInp.value.trim();
      if (bgRaw && !/^#?[0-9a-fA-F]{6}$/.test(bgRaw)) {
        toast('背景色格式应为 #RRGGBB，例如 #ffffff', 'error');
        return;
      }
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      const t0 = Date.now();
      try {
        const images = [];
        for (const it of items) {
          const bytes = new Uint8Array(await it.doc.file.arrayBuffer());
          const m = /\.([a-z0-9]+)$/i.exec(it.doc.name);
          images.push({ name: it.doc.name, bytes, mime: it.doc.type || (m ? EXT_MIME[m[1].toLowerCase()] : '') || '' });
        }
        pc.set(5, '读取图片…');
        const res = await run('images.toPdf', {
          images,
          paper: paperSel.value,
          orientation: oriSel.value,
          margin: Math.max(0, Math.round(Number(marginInp.value) || 0)),
          fit: fitSel.value,
          bg: bgRaw ? (bgRaw.startsWith('#') ? bgRaw : `#${bgRaw}`) : null,
        }, {
          onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 0, p.stage || '转换中…'),
        }, new Map());
        pc.done();
        renderResult(res, items, Date.now() - t0);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = state.items.length === 0;
      }
    }

    function renderResult(res, items, ms) {
      const [art] = res.artifacts;
      const card = document.createElement('div');
      card.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.appendChild(iconNode('success'));
      kv.appendChild(document.createTextNode(` 转换完成：${items.length} 张图片 → ${res.summary?.pages ?? items.length} 页 · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round(ms / 100) / 10}s`));
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      actions.append(
        button('下载 PDF', 'btn-primary', () => downloadArtifact(art)),
        button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'images2pdf', toolName: '图片转 PDF',
            docNames: items.map((i) => i.doc.name),
            options: { paper: paperSel.value, orientation: oriSel.value, fit: fitSel.value },
            outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
          });
          toast('已保存到历史');
        }),
      );
      const w = warningsBox(res.warnings);
      if (w) ib.appendChild(w);
      ib.append(kv, actions);
      card.appendChild(ib);
      resultBox.appendChild(card);
    }
  },
});
