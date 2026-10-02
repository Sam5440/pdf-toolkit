// 创建可填写表单（更多 · 对齐 PDF24 create-form）：在指定页添加文本框/复选框字段
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  field, numberInput, textInput, select, button, toast,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'formcreate',
  name: '创建可填写表单',
  group: 'm-edit',
  desc: '在 PDF 上添加文本框、复选框表单字段',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch { /* 上层已 toast */ }
        updateEnable();
      },
      onRemove() { state.doc = null; state.pageCount = 0; updateEnable(); },
    });

    const { card, body } = paramsCard();

    const pageInp = numberInput(1, { min: 1, step: 1 });
    body.appendChild(field('字段所在页码', pageInp, state.pageCount ? `共 ${state.pageCount} 页` : '页码从 1 开始'));

    // ---- 动态字段行 ----
    const fieldsCard = paramsCard();
    const fieldsTitle = document.createElement('b');
    fieldsTitle.style.fontSize = '13.5px';
    fieldsTitle.textContent = '字段列表（0）';
    const rowsBox = document.createElement('div');
    rowsBox.setAttribute('data-fc-rows', '');
    rowsBox.style.marginTop = '8px';
    const addRowBtn = button('添加字段行', 'btn-outline btn-sm', () => addRow());
    addRowBtn.setAttribute('data-fc-addrow', '');
    addRowBtn.style.marginTop = '8px';
    fieldsCard.body.append(fieldsTitle, rowsBox, addRowBtn);

    function addRow(def = {}) {
      const rowEl = document.createElement('div');
      rowEl.setAttribute('data-fc-row', '');
      rowEl.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:8px 0;border-bottom:1px dashed var(--border,#e5e7eb)';
      const mkNum = (label, defv, attr, min = 0) => {
        const i = numberInput(defv, { min, step: 1 });
        i.setAttribute(`data-fc-${attr}`, '');
        i.style.width = '76px';
        const f = field(label, i);
        f.style.marginBottom = '0';
        return f;
      };
      const typeSel = select([
        { value: 'text', label: '文本框' },
        { value: 'checkbox', label: '复选框' },
      ], def.type || 'text');
      typeSel.setAttribute('data-fc-type', '');
      typeSel.style.width = '96px';
      const typeF = field('类型', typeSel);
      typeF.style.marginBottom = '0';
      const nameInp = textInput(def.name || '', '字段名（英文更稳）');
      nameInp.setAttribute('data-fc-name', '');
      nameInp.style.width = '140px';
      const nameF = field('名称', nameInp);
      nameF.style.marginBottom = '0';
      const xF = mkNum('X', def.x ?? 60, 'x');
      const yF = mkNum('Y', def.y ?? 120, 'y');
      const wF = mkNum('宽', def.w ?? (def.type === 'checkbox' ? 16 : 180), 'w', 2);
      const hF = mkNum('高', def.h ?? (def.type === 'checkbox' ? 16 : 24), 'h', 2);
      const del = button('删除', 'btn-outline btn-sm', () => {
        rowEl.remove();
        syncCount();
      });
      del.setAttribute('data-fc-delrow', '');
      del.style.marginBottom = '0';
      rowEl.append(typeF, nameF, xF, yF, wF, hF, del);
      rowsBox.appendChild(rowEl);
      syncCount();
    }

    function syncCount() {
      fieldsTitle.textContent = `字段列表（${rowsBox.querySelectorAll('[data-fc-row]').length}）`;
    }

    // 默认给一行，便于上手
    addRow();

    const goBtn = button('创建表单字段', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, fieldsCard.card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const pageNo = Math.max(1, Number(pageInp.value) || 1) - 1;
      const fields = [];
      for (const rowEl of rowsBox.querySelectorAll('[data-fc-row]')) {
        const name = rowEl.querySelector('[data-fc-name]').value.trim();
        if (!name) continue;
        const num = (attr, defv) => {
          const v = Number(rowEl.querySelector(`[data-fc-${attr}]`).value);
          return Number.isFinite(v) ? v : defv;
        };
        fields.push({
          type: rowEl.querySelector('[data-fc-type]').value || 'text',
          name,
          page: pageNo,
          x: Math.max(0, num('x', 60)),
          y: Math.max(0, num('y', 120)),
          w: Math.max(2, num('w', 180)),
          h: Math.max(2, num('h', 24)),
        });
      }
      if (!fields.length) { toast('请至少添加一个命名字段', 'error'); throw new Error('请至少添加一个命名字段'); }
      const res = await run('form.create', {
        docId: state.doc.id,
        fields,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 50, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 字段: res.summary.fields, 页码: pageNo + 1 },
        toolId: 'formcreate', toolName: '创建可填写表单',
        docNames: [state.doc.name],
        options: { fields: fields.map((f) => f.name) },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
