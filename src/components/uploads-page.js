// 上传记录页（#/uploads）：图床/文件床上传的统一管理中心。
// 每条记录含本地永久保存的原件字节（uploads.js），支持：多格式外链复制、
// 失效检测（图片/视频走元素加载可精确判定，其它走 HEAD，跨域受限如实报未知）、
// 匿名可直传服务的一键重传（GitHub/yohuo 需凭证或中转，引导去对应工具页）。
import { button, confirmDialog, toast } from './ui.js';
import { iconNode } from './icons.js';
import { fmtBytes, fmtTime2 } from '../core/format.js';
import {
  listUploads, getUpload, updateUpload, deleteUpload, clearUploads,
  uploadsUsedBytes, probeUpload, probeAll, formatLinks, probeStrategy,
} from '../core/uploads.js';
import { uploadOne } from '../tools/more/filebed.js';

// 缩略图 objectURL 缓存（页面级复用；字节本体持久在 IndexedDB，URL 生命周期随页面）
const thumbUrls = new Map();

function thumbUrl(rec, blob) {
  if (thumbUrls.has(rec.id)) return thumbUrls.get(rec.id);
  if (!blob || probeStrategy(rec.url) !== 'image' && !(rec.type || '').startsWith('image/')) return null;
  const u = URL.createObjectURL(blob);
  thumbUrls.set(rec.id, u);
  return u;
}

function statusBadge(lastCheck) {
  const s = document.createElement('span');
  s.className = 'badge';
  if (!lastCheck) {
    s.textContent = '未检测';
    s.style.cssText = 'background:var(--secondary);color:var(--secondary-foreground)';
    return s;
  }
  if (lastCheck.status === 'ok') {
    s.textContent = '有效';
    s.style.cssText = 'background:rgba(34,197,94,.15);color:#16a34a';
  } else if (lastCheck.status === 'dead') {
    s.textContent = '已失效';
    s.style.cssText = 'background:rgba(239,68,68,.15);color:#dc2626';
  } else {
    s.textContent = '无法判定';
    s.style.cssText = 'background:var(--secondary);color:var(--secondary-foreground)';
    s.title = lastCheck.note || '';
  }
  return s;
}

export async function renderUploadsPage(content) {
  content.innerHTML = '<div class="card"><div class="card-body"><div class="empty"><span class="spinner"></span>加载上传记录中…</div></div></div>';
  const [items, used] = await Promise.all([listUploads(), uploadsUsedBytes()]);
  content.innerHTML = '';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px';
  const stat = document.createElement('span');
  stat.className = 'muted-sm';
  const setStat = (prefix) => { stat.textContent = `${prefix}${items.length} 条 · 占用 ${fmtBytes(used)} · 本地永久保存，不随任务历史配额淘汰`; };
  setStat('');
  head.insertBefore(stat, head.firstChild);
  const title = document.createElement('b');
  title.textContent = '上传记录（图床 / 文件床）';
  head.insertBefore(title, head.firstChild);
  const headBtns = document.createElement('div');
  headBtns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

  const rows = new Map(); // id → {badgeEl, noteEl, checkBtn, reBtn}

  const checkAllBtn = button('检测全部失效', 'btn-outline btn-sm', async () => {
    if (!items.length) return;
    checkAllBtn.disabled = true;
    checkAllBtn.textContent = '检测中…';
    let ok = 0; let dead = 0; let unknown = 0;
    await probeAll(items, {
      concurrency: 4,
      onResult: async (id, r) => {
        if (r.status === 'ok') ok++; else if (r.status === 'dead') dead++; else unknown++;
        await updateUpload(id, { lastCheck: r }).catch(() => { });
        const row = rows.get(id);
        if (row) {
          const fresh = statusBadge(r);
          row.badgeEl.replaceWith(fresh);
          row.badgeEl = fresh;
        }
      },
    });
    checkAllBtn.disabled = false;
    checkAllBtn.textContent = '检测全部失效';
    toast(`检测完成：${ok} 有效 · ${dead} 失效 · ${unknown} 无法判定`, dead ? 'error' : 'ok', 5000);
  });
  checkAllBtn.setAttribute('aria-label', '检测全部上传链接');
  const clearBtn = button('清空上传记录', 'btn-danger btn-sm', async () => {
    const ok2 = await confirmDialog({
      title: '清空上传记录',
      message: '确定清空全部上传记录？本地保存的原件字节将一并删除（不影响已上传的外链）。此操作不可恢复。',
      confirmText: '清空',
      destructive: true,
    });
    if (!ok2) return;
    await clearUploads();
    toast('已清空');
    renderUploadsPage(content);
  });
  headBtns.append(checkAllBtn, clearBtn);
  head.appendChild(headBtns);
  content.appendChild(head);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = '<div class="card-body"><div class="empty"><span class="empty-ico"></span>暂无上传记录<br>在「图床」或「文件床」工具上传成功后会自动登记在这里：多格式外链、失效检测、一键重传</div></div>';
    empty.querySelector('.empty-ico').appendChild(iconNode('uploads'));
    content.appendChild(empty);
    return;
  }

  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '8px';
    const body = document.createElement('div');
    body.className = 'card-body';
    body.style.cssText = 'display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap';

    // 缩略图（本地有原件的图片）
    let thumb = null;
    if (it.hasBytes && ((it.type || '').startsWith('image/') || probeStrategy(it.url) === 'image')) {
      thumb = document.createElement('img');
      thumb.alt = '';
      thumb.style.cssText = 'width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--border);flex-shrink:0;background:var(--secondary)';
      getUpload(it.id).then((full) => {
        const u = thumbUrl(it, full?.bytes);
        if (u) thumb.src = u;
        else thumb.remove();
      }).catch(() => thumb.remove());
    }

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:220px';
    const hostLine = document.createElement('div');
    hostLine.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    const nm = document.createElement('b');
    nm.textContent = it.name;
    const badge = statusBadge(it.lastCheck);
    hostLine.append(nm, badge);
    const meta = document.createElement('div');
    meta.className = 'note';
    meta.textContent = `${it.host || it.service || '未知服务'} · ${fmtBytes(it.size)} · ${fmtTime2(it.ts)}`;
    const linkLine = document.createElement('div');
    linkLine.className = 'note';
    linkLine.style.wordBreak = 'break-all';
    linkLine.textContent = it.url;
    if (it.lastCheck?.note && it.lastCheck.status !== 'ok') {
      const noteEl = document.createElement('div');
      noteEl.className = 'hint';
      noteEl.textContent = it.lastCheck.note;
      info.appendChild(hostLine);
      info.append(meta, linkLine, noteEl);
    } else {
      info.appendChild(hostLine);
      info.append(meta, linkLine);
    }

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0';
    const L = formatLinks(it.url, it.name);
    const mkCopy = (label, text) => button(label, 'btn-outline btn-sm', async () => {
      try { await navigator.clipboard.writeText(text); toast(`已复制${label}`); }
      catch { toast('复制失败', 'error'); }
    });
    const checkBtn = button('检测', 'btn-outline btn-sm', async () => {
      checkBtn.disabled = true;
      const r = await probeUpload(it);
      await updateUpload(it.id, { lastCheck: r }).catch(() => { });
      const fresh = statusBadge(r);
      badge.replaceWith(fresh);
      rows.set(it.id, { badgeEl: fresh });
      checkBtn.disabled = false;
      toast(r.status === 'ok' ? '链接有效' : r.status === 'dead' ? '链接已失效' : (r.note || '无法判定'), r.status === 'ok' ? 'ok' : 'error', 4000);
    });
    checkBtn.setAttribute('aria-label', `检测链接：${it.name}`);
    const openBtn = button('打开', 'btn-outline btn-sm', () => window.open(it.url, '_blank', 'noopener'));
    const reBtn = button('重新上传', 'btn-outline btn-sm', async () => {
      if (!it.apiUrl || !it.hasBytes) return;
      reBtn.disabled = true;
      reBtn.textContent = '上传中…';
      try {
        const full = await getUpload(it.id);
        const { url } = await uploadOne(it.apiUrl, full.bytes);
        await updateUpload(it.id, { url, lastCheck: null });
        toast('已重新上传，链接已更新');
        renderUploadsPage(content);
      } catch (e) {
        reBtn.disabled = false;
        reBtn.textContent = '重新上传';
        toast(`重传失败：${e.message === 'CORS_OR_NETWORK' ? '该服务跨域受限，请到工具页操作' : e.message}`, 'error', 5000);
      }
    });
    reBtn.setAttribute('aria-label', `重新上传：${it.name}`);
    if (!it.apiUrl || !it.hasBytes) {
      reBtn.disabled = true;
      reBtn.title = it.apiUrl ? '本地未保留原件，无法重传' : '该服务需凭证或中转，请到对应工具页重新上传';
    }
    const delBtn = button('删除', 'btn-danger btn-sm', async () => {
      const ok2 = await confirmDialog({
        title: '删除上传记录',
        message: `确定删除「${it.name}」？本地保存的原件字节将一并删除（不影响已上传的外链）。`,
        confirmText: '删除',
        destructive: true,
      });
      if (!ok2) return;
      await deleteUpload(it.id);
      toast('已删除');
      renderUploadsPage(content);
    });
    delBtn.setAttribute('aria-label', `删除记录：${it.name}`);
    right.append(
      mkCopy('链接', L.url), mkCopy('Markdown', L.markdown), mkCopy('HTML', L.html), mkCopy('BBCode', L.bbcode),
      checkBtn, openBtn, reBtn, delBtn,
    );

    if (thumb) body.appendChild(thumb);
    body.append(info, right);
    card.appendChild(body);
    content.appendChild(card);
    rows.set(it.id, { badgeEl: badge });
  }
}
