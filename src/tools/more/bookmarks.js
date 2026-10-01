// 添加书签（更多 · 对齐 PDF24 bookmarks）：写入 PDF 大纲（标题/页码/层级）
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, numberInput, textInput, button, select } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'bookmarks',
  name: '添加书签',
  group: 'more',
  desc: '写入 PDF 大纲书签（标题/页码/层级）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch { /* 上层已 toast */ }
        validate();
      },
      onRemove() { state.doc = null; state.pageCount = 0; validate(); },
    });

    const { card, body } = paramsCard();

    const rowsBox = document.createElement('div');
    rowsBox.setAttribute('data-bm-rows', '');
    body.appendChild(rowsBox);

    const addBtn = button('添加一行', 'btn-outline', () => { addRow(); validate(); });
    addBtn.setAttribute('data-bm-add', '');
    addBtn.style.marginTop = '4px';
    body.appendChild(addBtn);

    const errBox = document.createElement('div');
    errBox.className = 'alert alert-error';
    errBox.setAttribute('data-bm-err', '');
    errBox.style.cssText = 'margin-top:10px;display:none';
    body.appendChild(errBox);

    const pagesHint = document.createElement('div');
    pagesHint.className = 'hint';
    pagesHint.style.marginTop = '6px';
    body.appendChild(pagesHint);

    const goBtn = button('开始添加', 'btn-primary', () => exec());
    goBtn.setAttribute('data-bm-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    /** 追加一行书签输入（标题 / 页码 1 基 / 层级） */
    function addRow(title = '', page = 1, level = '0') {
      const rowEl = document.createElement('div');
      rowEl.className = 'field-row';
      rowEl.style.cssText = 'align-items:center;margin-bottom:8px';
      rowEl.setAttribute('data-bm-row', '');

      const tInp = textInput(title, '书签名称');
      tInp.setAttribute('data-bm-title', '');
      tInp.addEventListener('input', validate);

      const pInp = numberInput(page, { min: 1, step: 1 });
      pInp.setAttribute('data-bm-page', '');
      pInp.style.maxWidth = '90px';
      pInp.addEventListener('input', validate);

      const lSel = select([
        { value: '0', label: '顶级' },
        { value: '1', label: '子级' },
      ], level);
      lSel.setAttribute('data-bm-level', '');
      lSel.style.maxWidth = '96px';

      const del = button('删除', 'btn-ghost btn-sm', () => { rowEl.remove(); validate(); });
      del.setAttribute('data-bm-del', '');
      del.style.maxWidth = '64px';

      rowEl.append(tInp, pInp, lSel, del);
      rowsBox.appendChild(rowEl);
    }

    function showErr(msg) {
      errBox.textContent = msg;
      errBox.style.display = 'block';
      goBtn.disabled = true;
    }

    function validate() {
      errBox.style.display = 'none';
      errBox.textContent = '';
      pagesHint.textContent = state.pageCount ? `页码范围：1-${state.pageCount}` : '';
      if (!state.doc) { goBtn.disabled = true; return; }
      const rows = [...rowsBox.querySelectorAll('[data-bm-row]')];
      if (!rows.length) { showErr('请至少添加一行书签'); return; }
      for (let i = 0; i < rows.length; i++) {
        const title = rows[i].querySelector('[data-bm-title]').value.trim();
        const page = Number(rows[i].querySelector('[data-bm-page]').value);
        if (!title) { showErr(`第 ${i + 1} 行：请填写书签名称`); return; }
        if (!Number.isFinite(page) || page < 1 || (state.pageCount && page > state.pageCount)) {
          showErr(`第 ${i + 1} 行：页码需为 1-${state.pageCount || '∞'} 的数字`); return;
        }
      }
      goBtn.disabled = false;
    }

    const exec = runWithProgress(resultBox, async (setP) => {
      const items = [...rowsBox.querySelectorAll('[data-bm-row]')].map((rowEl) => ({
        title: rowEl.querySelector('[data-bm-title]').value.trim(),
        page: Math.max(1, Math.round(Number(rowEl.querySelector('[data-bm-page]').value) || 1)) - 1, // UI 1 基 → 引擎 0 基
        level: Number(rowEl.querySelector('[data-bm-level]').value) || 0,
      }));
      const res = await run('outlines.add', {
        docId: state.doc.id,
        items,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 书签数: res.summary.bookmarks },
        toolId: 'bookmarks', toolName: '添加书签',
        docNames: [state.doc.name],
        options: { items: items.map((it) => ({ ...it, page: it.page + 1 })) },
      }));
      return res;
    });

    // 默认给一行，降低上手成本
    addRow();
    validate();
  },
});
