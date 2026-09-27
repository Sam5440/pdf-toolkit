// PDF 叠加（代理 B）：把一份 PDF 的页面按配对模式叠加到另一份上。
// v1 预览为「底稿页 + 覆盖稿页缩略并排 + 实时布局提示」（不做真实合成预览），结果文件为真实叠加输出。
// 引擎 overlay.apply 存在几何缺陷（视觉坐标 NaN → 静默零缩放输出），绕过方式见
// components/watermark-editor.js 文件头说明；此处使用主线程 applyOverlayMain（真实输出）。
import { iconNode } from '../components/icons.js';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { readDocInfo, applyOverlayMain } from '../components/watermark-editor.js';
import { progressCard, toast, field, select, numberInput, button } from '../components/ui.js';
import { fmtBytes } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact } from '../core/download.js';

registerTool({
  id: 'overlay',
  name: 'PDF 叠加',
  group: 'content',
  desc: '将一份 PDF 叠加到另一份上，支持缩放/位置/透明度/前后层',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    // ---------- 双输入面板 ----------
    const basePanel = inputPanel({
      multiple: false, accept: 'application/pdf,.pdf',
      acceptHint: '底稿（必选 1 个）：作为输出文件的主体',
    });
    const overPanel = inputPanel({
      multiple: false, accept: 'application/pdf,.pdf',
      acceptHint: '覆盖稿（必选 1 个）：其页面内容被叠加到底稿上',
    });

    function panelBlock(title, key, panel) {
      const wrap = document.createElement('div');
      wrap.className = 'card';
      wrap.dataset.overlayPanel = key;
      const body = document.createElement('div');
      body.className = 'card-body';
      const h = document.createElement('b');
      h.style.cssText = 'display:block;margin-bottom:2px';
      h.textContent = title;
      body.append(h, panel.el);
      wrap.appendChild(body);
      return wrap;
    }

    const panelsGrid = document.createElement('div');
    panelsGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start';
    panelsGrid.append(panelBlock('① 底稿（必选 1 个）', 'base', basePanel), panelBlock('② 覆盖稿（必选 1 个）', 'overlay', overPanel));

    // ---------- 预览：两页缩略 + 布局提示 ----------
    const previewCard = document.createElement('div');
    previewCard.className = 'card';
    previewCard.style.marginTop = '14px';
    const previewBody = document.createElement('div');
    previewBody.className = 'card-body';
    const previewTitle = document.createElement('b');
    previewTitle.style.cssText = 'display:block;margin-bottom:8px';
    previewTitle.textContent = '预览（底稿页 + 覆盖稿页缩略，v1 不做真实合成）';
    const thumbsRow = document.createElement('div');
    thumbsRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start';

    function thumbBlock(key, label) {
      const wrap = document.createElement('div');
      const cap = document.createElement('div');
      cap.className = 'hint';
      cap.style.marginBottom = '4px';
      cap.textContent = label;
      const nav = document.createElement('div');
      nav.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
      const prev = button('◀', 'btn-outline btn-sm', null);
      const lab = document.createElement('span');
      lab.className = 'wm-page-label';
      lab.dataset.ov = `${key}PageLabel`;
      lab.textContent = '第 – 页';
      const next = button('▶', 'btn-outline btn-sm', null);
      nav.append(prev, lab, next);
      const canvas = document.createElement('canvas');
      canvas.dataset.ov = `${key}Canvas`;
      canvas.style.cssText = 'max-width:240px;max-height:320px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:#fff;box-shadow:0 1px 6px rgba(15,23,42,.1)';
      canvas.width = 1; canvas.height = 1;
      wrap.append(cap, nav, canvas);
      return { wrap, prev, next, lab, canvas };
    }

    const baseThumb = thumbBlock('base', '底稿页');
    const overThumb = thumbBlock('over', '覆盖稿页');
    thumbsRow.append(baseThumb.wrap, overThumb.wrap);

    const hintEl = document.createElement('div');
    hintEl.className = 'hint';
    hintEl.dataset.ov = 'hint';
    hintEl.style.marginTop = '10px';
    hintEl.textContent = '请选择底稿与覆盖稿，配对与布局提示将显示在这里。';
    previewBody.append(previewTitle, thumbsRow, hintEl);
    previewCard.appendChild(previewBody);

    // ---------- 参数 ----------
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const controlsBody = document.createElement('div');
    controlsBody.className = 'card-body';

    const modeSel = select([
      { value: 'oneToOne', label: '顺序逐页（1↔1、2↔2…，取较少页数）' },
      { value: 'repeatFirst', label: '首页叠加到每一页' },
      { value: 'custom', label: '自定义配对（每行 base:over）' },
    ], 'oneToOne');
    modeSel.dataset.ov = 'mode';

    const customTa = document.createElement('textarea');
    customTa.rows = 3;
    customTa.dataset.ov = 'customRows';
    customTa.placeholder = '每行一对，页码从 1 开始：\n1:1\n2:3';
    const customField = field('自定义配对（底稿页:覆盖稿页）', customTa, '超出页数的行会被忽略');
    customField.style.display = 'none';

    const scaleInput = numberInput(1, { min: 0.1, max: 3, step: 0.05 });
    scaleInput.dataset.ov = 'scale';
    const opacityVal = document.createElement('span');
    opacityVal.className = 'hint';
    opacityVal.textContent = '100%';
    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0'; opacityInput.max = '100'; opacityInput.step = '1';
    opacityInput.value = '100';
    opacityInput.dataset.ov = 'opacity';
    const opacityRow = document.createElement('div');
    opacityRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    opacityRow.append(opacityInput, opacityVal);
    const offX = numberInput(0, { min: -2000, max: 2000, step: 1 });
    offX.dataset.ov = 'offsetX';
    const offY = numberInput(0, { min: -2000, max: 2000, step: 1 });
    offY.dataset.ov = 'offsetY';
    const offRow = document.createElement('div');
    offRow.className = 'field-row';
    offRow.append(field('水平偏移（pt，右为正）', offX), field('垂直偏移（pt，下为正）', offY));
    const sideSel = select([
      { value: 'over', label: '覆盖在上（覆盖稿在底稿内容之上）' },
      { value: 'under', label: '垫在下（覆盖稿垫在底稿内容之下）' },
    ], 'over');
    sideSel.dataset.ov = 'side';

    const goBtn = button('开始叠加', 'btn-primary', () => doApply());
    goBtn.style.width = '100%';
    goBtn.disabled = true;

    controlsBody.append(
      field('配对模式', modeSel),
      customField,
      field('覆盖稿缩放（0.1 - 3，1 = 原始尺寸）', scaleInput),
      field('覆盖稿不透明度', opacityRow),
      offRow,
      field('层级', sideSel),
      goBtn,
    );
    controls.appendChild(controlsBody);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(panelsGrid, previewCard, controls, resultBox);

    // ---------- 状态 ----------
    const meta = new Map(); // docId → doc.open 结果
    const state = { basePage: 0, overPage: 0 };
    const seq = { base: 0, over: 0 };

    function docsMap() {
      return new Map([...basePanel.docs(), ...overPanel.docs()].map((d) => [d.id, d]));
    }

    async function ensureMeta(doc) {
      if (meta.has(doc.id)) return meta.get(doc.id);
      // 主线程读取页数与视觉尺寸（引擎 doc.open 的 pages[].visualW 受几何缺陷影响为 NaN）
      const res = await readDocInfo(doc);
      meta.set(doc.id, res);
      return res;
    }

    function updateApplyState() {
      goBtn.disabled = !(basePanel.docs().length && overPanel.docs().length);
    }

    // ---------- 缩略渲染 ----------
    async function renderThumb(side) {
      const panel = side === 'base' ? basePanel : overPanel;
      const doc = panel.docs()[0];
      const t = side === 'base' ? baseThumb : overThumb;
      const mySeq = ++seq[side];
      if (!doc) {
        t.canvas.width = 1; t.canvas.height = 1;
        t.lab.textContent = '第 – 页';
        t.prev.disabled = true; t.next.disabled = true;
        return;
      }
      const m = await ensureMeta(doc);
      if (mySeq !== seq[side]) return;
      updateHint(); // 元信息此刻才就绪，刷新配对/布局提示
      const pageCount = m.pageCount || 1;
      state[`${side}Page`] = Math.min(state[`${side}Page`], pageCount - 1);
      t.lab.textContent = `第 ${state[`${side}Page`] + 1} / ${pageCount} 页`;
      t.prev.disabled = state[`${side}Page`] <= 0;
      t.next.disabled = state[`${side}Page`] >= pageCount - 1;
      try {
        const res = await run('doc.render', { docId: doc.id, page: state[`${side}Page`], dpi: 54 }, {}, docsMap());
        if (mySeq !== seq[side]) { res.bitmap.close?.(); return; }
        t.canvas.width = res.width;
        t.canvas.height = res.height;
        t.canvas.getContext('2d').drawImage(res.bitmap, 0, 0);
        res.bitmap.close?.();
      } catch (e) {
        if (mySeq === seq[side]) toast(`缩略渲染失败：${e.message}`, 'error');
      }
    }

    function updateHint() {
      const bd = basePanel.docs()[0];
      const od = overPanel.docs()[0];
      if (!bd || !od) {
        hintEl.textContent = '请选择底稿与覆盖稿，配对与布局提示将显示在这里。';
        return;
      }
      const bm = meta.get(bd.id);
      const om = meta.get(od.id);
      if (!bm || !om) { hintEl.textContent = '正在读取页面信息…'; return; }
      const scale = Number(scaleInput.value) || 1;
      const ox = Number(offX.value) || 0;
      const oy = Number(offY.value) || 0;
      const under = sideSel.value === 'under';
      const mode = modeSel.value;
      let pairs;
      if (mode === 'oneToOne') pairs = Math.min(bm.pageCount, om.pageCount);
      else if (mode === 'repeatFirst') pairs = bm.pageCount;
      else {
        pairs = customTa.value.split('\n').filter((s) => /^\s*\d+\s*[:：,]\s*\d+\s*$/.test(s)).length;
      }
      const bp = bm.pages?.[state.basePage];
      const op = om.pages?.[state.overPage];
      const drawW = op ? Math.round(op.visualW * scale) : '?';
      const drawH = op ? Math.round(op.visualH * scale) : '?';
      hintEl.textContent = `配对：共 ${pairs} 组 · 底稿第 ${state.basePage + 1} 页（${bp ? `${Math.round(bp.visualW)}×${Math.round(bp.visualH)}` : '?'}pt）← 覆盖稿第 ${state.overPage + 1} 页（${op ? `${Math.round(op.visualW)}×${Math.round(op.visualH)}` : '?'}pt）× ${scale} → 绘制 ${drawW}×${drawH}pt，中心对齐底稿中心，偏移 (${ox}, ${oy})pt，不透明度 ${Math.round(Number(opacityInput.value))}%，绘制在${under ? '底稿内容之下' : '底稿内容之上'}。最终效果以结果文件为准。`;
    }

    function refreshAll() {
      updateApplyState();
      renderThumb('base');
      renderThumb('over');
      updateHint();
    }

    baseThumb.prev.onclick = () => { state.basePage--; renderThumb('base'); updateHint(); };
    baseThumb.next.onclick = () => { state.basePage++; renderThumb('base'); updateHint(); };
    overThumb.prev.onclick = () => { state.overPage--; renderThumb('over'); updateHint(); };
    overThumb.next.onclick = () => { state.overPage++; renderThumb('over'); updateHint(); };

    // 输入面板 DOM 变化 → 重新装配（inputPanel 不支持后绑定回调）
    const obs1 = new MutationObserver(refreshAll);
    obs1.observe(basePanel.el.querySelector('.file-list'), { childList: true });
    const obs2 = new MutationObserver(refreshAll);
    obs2.observe(overPanel.el.querySelector('.file-list'), { childList: true });

    modeSel.onchange = () => {
      customField.style.display = modeSel.value === 'custom' ? '' : 'none';
      updateHint();
    };
    customTa.addEventListener('input', updateHint);
    scaleInput.oninput = updateHint;
    offX.oninput = updateHint;
    offY.oninput = updateHint;
    sideSel.onchange = updateHint;
    opacityInput.oninput = () => { opacityVal.textContent = `${opacityInput.value}%`; updateHint(); };

    function buildMapping() {
      if (modeSel.value === 'custom') {
        const lines = customTa.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (!lines.length) throw new Error('自定义配对为空：每行填写 base:over，如 1:1');
        const custom = lines.map((line, i) => {
          const m = /^(\d+)\s*[:：,]\s*(\d+)$/.exec(line);
          if (!m) throw new Error(`自定义配对第 ${i + 1} 行「${line}」格式错误，应为 base:over（如 1:2）`);
          return { base: +m[1] - 1, over: +m[2] - 1 };
        });
        return { mode: 'custom', custom };
      }
      return { mode: modeSel.value };
    }

    async function doApply() {
      const bd = basePanel.docs()[0];
      const od = overPanel.docs()[0];
      if (!bd) { toast('请先选择底稿 PDF', 'error'); return; }
      if (!od) { toast('请先选择覆盖稿 PDF', 'error'); return; }
      let mapping;
      try { mapping = buildMapping(); } catch (e) { toast(e.message, 'error'); return; }
      const options = {
        scale: Math.min(3, Math.max(0.1, Number(scaleInput.value) || 1)),
        opacity: Math.min(100, Math.max(0, Number(opacityInput.value))) / 100,
        offsetX: Number(offX.value) || 0,
        offsetY: Number(offY.value) || 0,
        under: sideSel.value === 'under',
      };
      goBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.indeterminate('正在叠加…');
      const t0 = Date.now();
      try {
        const art = await applyOverlayMain({ baseDoc: bd, overlayDoc: od, mapping, options });
        pc.done();
        const info = document.createElement('div');
        info.className = 'card';
        const ib = document.createElement('div');
        ib.className = 'card-body';
        const kv = document.createElement('div');
        kv.className = 'kv';
        const b = document.createElement('b');
        b.appendChild(iconNode('success'));
        b.appendChild(document.createTextNode(` 叠加完成：${art.pairs} 组配对 · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round((Date.now() - t0) / 100) / 10}s`));
        kv.appendChild(b);
        const nameRow = document.createElement('div');
        nameRow.className = 'note';
        nameRow.textContent = art.name;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
        const dl = button('下载叠加 PDF', 'btn-primary', () => downloadArtifact(art));
        const save = button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'overlay', toolName: 'PDF 叠加',
            docNames: [bd.name, od.name],
            options: { mode: mapping.mode, scale: options.scale, opacity: options.opacity, offsetX: options.offsetX, offsetY: options.offsetY, under: options.under, pairs: art.pairs },
            outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
          });
          toast('已保存到历史');
        });
        actions.append(dl, save);
        ib.append(kv, nameRow, actions);
        info.appendChild(ib);
        resultBox.appendChild(info);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = !(basePanel.docs().length && overPanel.docs().length);
      }
    }
  },
});
