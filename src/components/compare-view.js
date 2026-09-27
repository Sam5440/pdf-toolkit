// PDF 比较结果视图：摘要条 / 差异页导航 / 双栏页面对比 + 差异高亮层 / 文本差异 / 报告导出
// 由 subagent C 拥有；渲染页面使用引擎 doc.render（本地 worker，不经网络）
import { iconNode } from './icons.js';
import { run } from '../core/engine.js';
import { button, toast } from './ui.js';
import { downloadArtifact, downloadZip } from '../core/download.js';
import { fmtBytes } from '../core/format.js';

/**
 * 创建比较结果视图
 * @param {object} res compare.run 的结果 {pairs, textDiffs, extraA, extraB, bitmaps}
 * @param {{docA:object, docB:object, dpi?:number, threshold?:number}} ctx 文档对象与比较参数
 * @returns {{el:HTMLElement, getReportText:Function}}
 */
export function createCompareView(res, { docA, docB, dpi = 110, threshold = 24 }) {
  const pairs = res.pairs || [];
  const bitmaps = res.bitmaps || [];
  const textDiffs = res.textDiffs || [];
  const extraA = res.extraA || [];
  const extraB = res.extraB || [];
  const docMap = new Map([[docA.id, docA], [docB.id, docB]]);
  const canvasCache = new Map(); // `${docId}:${page}` → canvas
  const state = { index: 0, mode: 'side' };

  const sameCount = pairs.filter((p) => p.same).length;
  const diffCount = pairs.length - sameCount;

  const el = document.createElement('div');
  el.className = 'cmp-wrap';
  el.style.marginTop = '14px';

  // ---- 摘要条 ----
  const summary = document.createElement('div');
  summary.className = 'card cmp-summary';
  const sb = document.createElement('div');
  sb.className = 'card-body';
  const sumLine = document.createElement('div');
  sumLine.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:13.5px';
  const mkBadge = (text, color) => {
    const b = document.createElement('span');
    b.className = 'badge';
    if (color === 'ok') b.className += ' badge-ok';
    else if (color === 'no') b.className += ' badge-no';
    else if (color === 'primary') b.className += ' badge-primary';
    b.textContent = text;
    return b;
  };
  sumLine.append(
    mkBadge(`总页对数 ${pairs.length}`, 'primary'),
    mkBadge(`相同 ${sameCount}`, 'ok'),
    mkBadge(`差异 ${diffCount}`, diffCount ? 'no' : 'ok'),
  );
  sb.appendChild(sumLine);

  const mkExtraRow = (label, list) => {
    if (!list.length) return;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:12.5px';
    const t = document.createElement('b');
    t.textContent = label;
    row.appendChild(t);
    for (const p of list) {
      const chip = document.createElement('span');
      chip.className = 'range-chip';
      chip.textContent = `第 ${p + 1} 页`;
      row.appendChild(chip);
    }
    sb.appendChild(row);
  };
  mkExtraRow(`A 多出 ${extraA.length} 页：`, extraA);
  mkExtraRow(`B 多出 ${extraB.length} 页：`, extraB);
  summary.appendChild(sb);
  el.appendChild(summary);

  // ---- 差异页导航 chips ----
  if (diffCount) {
    const nav = document.createElement('div');
    nav.className = 'card';
    const nb = document.createElement('div');
    nb.className = 'card-body';
    nb.style.padding = '10px 16px';
    const nt = document.createElement('b');
    nt.style.fontSize = '13px';
    nt.textContent = '差异页：';
    nb.appendChild(nt);
    pairs.forEach((p, i) => {
      if (p.same) return;
      const chip = button(`第 ${i + 1} 对 · ${p.pct.toFixed(2)}%`, 'btn-ghost btn-sm', () => goto(i));
      chip.className += ' range-chip';
      chip.style.fontSize = '11.5px';
      nb.appendChild(chip);
    });
    nav.appendChild(nb);
    el.appendChild(nav);
  }

  // ---- 工具栏：模式切换 + 联动翻页 ----
  const bar = document.createElement('div');
  bar.className = 'card';
  const bb = document.createElement('div');
  bb.className = 'card-body';
  bb.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 16px';

  const modeSel = document.createElement('select');
  for (const [v, label] of [['side', '并排对比'], ['diff', '仅高亮']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    modeSel.appendChild(o);
  }
  modeSel.value = 'side';
  modeSel.addEventListener('change', () => { state.mode = modeSel.value; applyMode(); });
  const modeLabel = document.createElement('span');
  modeLabel.className = 'hint';
  modeLabel.textContent = '视图模式';
  const prevBtn = button('‹ 上一对', 'btn-outline btn-sm', () => goto(state.index - 1));
  const nextBtn = button('下一对 ›', 'btn-outline btn-sm', () => goto(state.index + 1));
  const posLabel = document.createElement('span');
  posLabel.style.cssText = 'font-size:12.5px;font-weight:600';
  const renderStatus = document.createElement('span');
  renderStatus.className = 'hint';
  bb.append(modeLabel, modeSel, prevBtn, posLabel, nextBtn, renderStatus);
  bar.appendChild(bb);
  el.appendChild(bar);

  // ---- 双栏视图 + 差异高亮层 ----
  const panes = document.createElement('div');
  panes.className = 'cmp-panes';

  const mkPane = (title) => {
    const pane = document.createElement('div');
    pane.className = 'cmp-pane';
    const head = document.createElement('div');
    head.className = 'cmp-head';
    const t = document.createElement('span');
    t.textContent = title;
    const pg = document.createElement('span');
    head.append(t, pg);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'cmp-body';
    pane.append(head, bodyEl);
    panes.appendChild(pane);
    return { pane, pg, bodyEl };
  };
  const paneA = mkPane(`文件 A · ${docA.name}`);
  const paneB = mkPane(`文件 B · ${docB.name}`);

  const hlPane = document.createElement('div');
  hlPane.className = 'cmp-pane';
  hlPane.style.gridColumn = '1 / -1';
  const hlHead = document.createElement('div');
  hlHead.className = 'cmp-head';
  const hlTitle = document.createElement('span');
  hlTitle.textContent = '差异高亮（红 = 差异区域，淡色为 B 页底图）';
  hlHead.appendChild(hlTitle);
  const hlBody = document.createElement('div');
  hlBody.className = 'cmp-body';
  hlPane.append(hlHead, hlBody);
  panes.appendChild(hlPane);
  el.appendChild(panes);

  function applyMode() {
    const side = state.mode === 'side';
    paneA.pane.style.display = side ? '' : 'none';
    paneB.pane.style.display = side ? '' : 'none';
  }
  applyMode();

  // ---- 文本差异 ----
  const textCard = document.createElement('div');
  textCard.className = 'card cmp-textdiffs';
  const tb = document.createElement('div');
  tb.className = 'card-body';
  const tHead = document.createElement('b');
  tHead.style.fontSize = '13.5px';
  const tds = textDiffs.filter((t) => !t.same);
  tHead.textContent = `文本差异（${tds.length} 页）`;
  tb.appendChild(tHead);
  if (!tds.length) {
    const ok = document.createElement('div');
    ok.className = 'note';
    ok.appendChild(iconNode('success'));
    ok.appendChild(document.createTextNode(' 各页文本内容无差异'));
    tb.appendChild(ok);
  }
  for (const t of tds) {
    const item = document.createElement('div');
    item.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-top:8px';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
    const title = document.createElement('b');
    title.style.fontSize = '13px';
    title.textContent = `A 第 ${t.pageA + 1} 页 ↔ B 第 ${t.pageB + 1} 页`;
    const stat = document.createElement('span');
    stat.className = 'badge badge-warn';
    stat.textContent = `+${t.added} / −${t.removed} 行`;
    const expBtn = button('展开', 'btn-ghost btn-sm', () => {
      const open = pre.style.display !== 'none';
      pre.style.display = open ? 'none' : 'block';
      expBtn.textContent = open ? '展开' : '收起';
    });
    head.append(title, stat, expBtn);
    const pre = document.createElement('pre');
    pre.style.cssText = 'display:none;margin:8px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-all;background:var(--bg-soft);padding:8px;border-radius:6px';
    const lines = [];
    for (const d of t.diff || []) {
      const sign = d.type === 'add' ? '+' : '−';
      for (const l of d.lines || []) lines.push(`${sign} ${l}`);
    }
    pre.textContent = lines.join('\n'); // textContent 安全渲染（等效 esc）
    item.append(head, pre);
    tb.appendChild(item);
  }
  textCard.appendChild(tb);
  el.appendChild(textCard);

  // ---- 导出 ----
  const exportBar = document.createElement('div');
  exportBar.className = 'card';
  const eb = document.createElement('div');
  eb.className = 'card-body';
  eb.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  eb.append(
    button('导出差异报告 (.txt)', 'btn-primary', () => {
      const txt = getReportText();
      downloadArtifact({
        name: '比较报告.txt',
        mime: 'text/plain;charset=utf-8',
        bytes: new TextEncoder().encode(txt),
      });
      toast('报告已生成下载');
    }),
    button('打包差异页高亮图 (.zip)', 'btn-outline', exportDiffPngs),
  );
  exportBar.appendChild(eb);
  el.appendChild(exportBar);

  function getReportText() {
    const L = [];
    L.push('PDF 比较报告');
    L.push(`生成时间：${new Date().toLocaleString()}`);
    L.push(`文件 A：${docA.name}`);
    L.push(`文件 B：${docB.name}`);
    L.push(`参数：DPI ${dpi} · 差异阈值 ${threshold}`);
    L.push('');
    L.push(`总页对数：${pairs.length} · 相同 ${sameCount} · 差异 ${diffCount}`);
    if (extraA.length) L.push(`A 多出页（1 基）：${extraA.map((p) => p + 1).join(', ')}`);
    if (extraB.length) L.push(`B 多出页（1 基）：${extraB.map((p) => p + 1).join(', ')}`);
    L.push('');
    L.push('逐页比较：');
    pairs.forEach((p, i) => {
      L.push(`  第 ${i + 1} 对：A 第 ${p.a + 1} 页 vs B 第 ${p.b + 1} 页 — 差异 ${p.pct.toFixed(2)}% — ${p.same ? '相同' : '有差异'}`);
    });
    L.push('');
    if (tds.length) {
      L.push(`文本差异（${tds.length} 页）：`);
      for (const t of tds) L.push(`  A 第 ${t.pageA + 1} 页 vs B 第 ${t.pageB + 1} 页：+${t.added} / −${t.removed} 行`);
    } else {
      L.push('文本差异：无');
    }
    return L.join('\n');
  }

  async function exportDiffPngs() {
    const items = [];
    for (let i = 0; i < bitmaps.length; i++) {
      if (pairs[i]?.same) continue;
      const bm = bitmaps[i];
      if (!bm?.bitmap) continue;
      const c = new OffscreenCanvas(bm.width || bm.bitmap.width, bm.height || bm.bitmap.height);
      c.getContext('2d').drawImage(bm.bitmap, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      items.push({
        name: `差异页_${String(i + 1).padStart(2, '0')}_A${(pairs[i].a ?? 0) + 1}_B${(pairs[i].b ?? 0) + 1}.png`,
        mime: 'image/png',
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    if (!items.length) { toast('没有差异页可导出'); return; }
    await downloadZip(items, 'compare-diffs.zip');
    toast(`已打包 ${items.length} 张差异高亮图（${fmtBytes(items.reduce((s, x) => s + x.bytes.byteLength, 0))}）`);
  }

  // ---- 渲染页面对 ----
  async function getRendered(doc, page) {
    const key = `${doc.id}:${page}`;
    if (canvasCache.has(key)) return canvasCache.get(key);
    const r = await run('doc.render', { docId: doc.id, page, dpi }, {}, docMap);
    const canvas = document.createElement('canvas');
    canvas.width = r.width;
    canvas.height = r.height;
    canvas.style.cssText = 'max-width:100%;height:auto';
    canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    canvasCache.set(key, canvas);
    return canvas;
  }

  async function goto(i) {
    if (!pairs.length) return;
    const idx = Math.max(0, Math.min(pairs.length - 1, i));
    state.index = idx;
    const p = pairs[idx];
    posLabel.textContent = `第 ${idx + 1} / ${pairs.length} 对`;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === pairs.length - 1;
    renderStatus.textContent = '渲染页面中…';
    try {
      paneA.pg.textContent = `第 ${p.a + 1} 页`;
      paneB.pg.textContent = `第 ${p.b + 1} 页`;
      const [ca, cb] = await Promise.all([
        getRendered(docA, p.a).catch((e) => { renderStatus.textContent = `A 页渲染失败：${e.message}`; return null; }),
        getRendered(docB, p.b).catch((e) => { renderStatus.textContent = `B 页渲染失败：${e.message}`; return null; }),
      ]);
      for (const [pane, c] of [[paneA, ca], [paneB, cb]]) {
        pane.bodyEl.innerHTML = '';
        if (c) pane.bodyEl.appendChild(c);
      }
      // 高亮层：bitmap 按页对齐绘制
      const bm = bitmaps[idx];
      hlBody.innerHTML = '';
      if (bm?.bitmap) {
        const hc = document.createElement('canvas');
        hc.width = bm.width || bm.bitmap.width;
        hc.height = bm.height || bm.bitmap.height;
        hc.style.cssText = 'max-width:100%;height:auto';
        hc.getContext('2d').drawImage(bm.bitmap, 0, 0);
        hlBody.appendChild(hc);
      }
      if (renderStatus.textContent === '渲染页面中…') renderStatus.textContent = '';
    } finally {
      if (renderStatus.textContent === '渲染页面中…') renderStatus.textContent = '';
    }
  }

  goto(0);

  return { el, getReportText };
}
