// PDF 比较 — 双文件逐页像素差异（高亮掩膜）+ 文本差异，结果用 compare-view 展示
import { registerTool } from './core.js';
import { run, ensureDoc, abort } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import {
  progressCard, warningsBox, toast, field, numberInput, textInput, checkbox, row, button,
} from '../components/ui.js';
import { createCompareView } from '../components/compare-view.js';
import { recordTask, recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { buildOutputName, paramsToken } from '../core/naming.js';

registerTool({
  id: 'compare',
  name: 'PDF 比较',
  group: 'check',
  desc: '像素差异+文本差异双视图，并排/高亮/联动缩放',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { docA: null, docB: null, opId: null, running: false };

    const slotsRow = document.createElement('div');
    slotsRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px';
    const mkSlot = (slot) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('data-cmp-slot', slot);
      const b = document.createElement('div');
      b.className = 'card-body';
      const title = document.createElement('b');
      title.style.cssText = 'display:block;margin-bottom:8px;font-size:13.5px';
      title.textContent = slot === 'A' ? '文件 A（基准）' : '文件 B（对比）';
      card.appendChild(title);
      card.appendChild(b);
      slotsRow.appendChild(card);
      return b;
    };
    const slotABody = mkSlot('A');
    const slotBBody = mkSlot('B');

    const panelA = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '文件 A',
      onAdd(added) {
        if (added.length) {
          state.docA = added[added.length - 1];
          loadPageCount(state.docA, countAEl);
        }
      },
    });
    const panelB = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '文件 B',
      onAdd(added) {
        if (added.length) {
          state.docB = added[added.length - 1];
          loadPageCount(state.docB, countBEl);
        }
      },
    });
    // 面板自带 tag 列表保留（提供移除按钮），只在空态时显示提示文字
    slotABody.appendChild(panelA.el);
    slotBBody.appendChild(panelB.el);
    const countAEl = document.createElement('div');
    countAEl.className = 'hint';
    const countBEl = document.createElement('div');
    countBEl.className = 'hint';
    slotABody.appendChild(countAEl);
    slotBBody.appendChild(countBEl);

    async function loadPageCount(doc, el) {
      el.textContent = '';
      try {
        const info = await ensureDoc(doc);
        el.textContent = `已就绪 · 共 ${info.pageCount} 页${info.encrypted ? ' · 已加密' : ''}`;
      } catch (e) {
        el.textContent = `读取失败：${e.message}`;
      }
    }

    // ---- 参数 ----
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const pagesAInp = textInput('', '留空=全部页');
    const pagesBInp = textInput('', '留空=全部页');
    const dpiInp = numberInput(110, { min: 72, max: 200, step: 1 });
    const thInp = numberInput(24, { min: 0, max: 100, step: 1 });
    const textChk = checkbox('包含文本差异（行级对比）', true);

    body.append(
      row(field('页范围 A', pagesAInp), field('页范围 B', pagesBInp)),
      row(field('DPI（72-200）', dpiInp), field('差异阈值（0-100）', thInp)),
      textChk,
    );
    controls.appendChild(body);

    // ---- 执行 ----
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;gap:8px;margin-top:14px';
    const goBtn = button('开始比较', 'btn-primary', () => doCompare());
    goBtn.style.flex = '1';
    const cancelBtn = button('取消', 'btn-outline', () => abort(state.opId));
    cancelBtn.style.display = 'none';
    actionsRow.append(goBtn, cancelBtn);

    const resultBox = document.createElement('div');

    container.append(slotsRow, controls, actionsRow, resultBox);

    async function doCompare() {
      resultBox.innerHTML = '';
      const { docA, docB } = state;
      if (!docA) { toast('请先选择文件 A', 'error'); return; }
      if (!docB) { toast('请先选择文件 B', 'error'); return; }
      const dpi = Math.round(Number(dpiInp.value) || 0);
      if (dpi < 72 || dpi > 200) { toast('DPI 需在 72-200 之间', 'error'); return; }
      const threshold = Math.round(Number(thInp.value) || 0);
      if (threshold < 0 || threshold > 100) { toast('阈值需在 0-100 之间', 'error'); return; }
      const withText = textChk._input.checked;
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      state.running = true;
      cancelBtn.style.display = '';
      const t0 = Date.now();
      try {
        // aDocId/bDocId 不在 run() 自动装载名单内，这里手动确保两个文档已在引擎打开
        await Promise.all([ensureDoc(docA), ensureDoc(docB)]);
        const docsMap = new Map([[docA.id, docA], [docB.id, docB]]);
        const res = await run('compare.run', {
          aDocId: docA.id,
          bDocId: docB.id,
          pagesA: pagesAInp.value.trim() || 'all',
          pagesB: pagesBInp.value.trim() || 'all',
          dpi,
          threshold,
          withText,
        }, {
          onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 0, p.stage || '比较中…'),
          onSpawn: (id) => { state.opId = id; },
        }, docsMap);
        pc.done();
        renderResult(res, docA, docB, dpi, threshold, Date.now() - t0);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
        state.running = false;
        cancelBtn.style.display = 'none';
      }
    }

    function renderResult(res, docA, docB, dpi, threshold, ms) {
      const view = createCompareView(res, { docA, docB, dpi, threshold });
      resultBox.appendChild(view.el);
      const kv = document.createElement('div');
      kv.className = 'hint';
      kv.style.marginTop = '8px';
      kv.textContent = `比较完成 · 用时 ${Math.round(ms / 100) / 10}s`;
      resultBox.appendChild(kv);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      actions.appendChild(button('保存到历史（差异报告）', 'btn-outline', async () => {
        const txt = view.getReportText();
        const bytes = new TextEncoder().encode(txt);
        await recordTask({
          tool: 'compare', toolName: 'PDF 比较',
          docNames: [docA.name, docB.name],
          options: { dpi, threshold, pagesA: pagesAInp.value.trim() || 'all', pagesB: pagesBInp.value.trim() || 'all' },
          docs: [docA, docB],
          outputs: [{ name: `${buildOutputName({ name: docA.name, op: '对比', params: paramsToken({ dpi, threshold }) })}.txt`, mime: 'text/plain;charset=utf-8', size: bytes.byteLength, blob: new Blob([bytes], { type: 'text/plain;charset=utf-8' }) }],
          form: capturePageForm(),
          auto: false,
        });
        toast('已保存到历史');
      }));
      resultBox.appendChild(actions);
      const w = warningsBox(res.warnings);
      if (w) resultBox.appendChild(w);
      // 自动记录比较任务本身（差异报告可再手动存档）
      recordTask({
        tool: 'compare', toolName: 'PDF 比较',
        docNames: [docA.name, docB.name],
        options: { dpi, threshold, pagesA: pagesAInp.value.trim() || 'all', pagesB: pagesBInp.value.trim() || 'all' },
        docs: [docA, docB],
        form: capturePageForm(),
      });
    }
  },
});
