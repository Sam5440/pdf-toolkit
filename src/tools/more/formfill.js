// 填写 PDF 表单（更多 · 对齐 PDF24 fill-and-sign）：识别 AcroForm 字段并填写
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  field, textInput, select, checkbox, button, toast,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'formfill',
  name: '填写 PDF 表单',
  group: 'm-edit',
  desc: '识别并填写 AcroForm 表单字段',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, fields: [] };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个含表单（AcroForm）的 PDF 文件',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.fields = [];
        fieldsBody.textContent = '';
        hideEmpty();
        try {
          await ensureDoc(state.doc);
          const res = await run('form.list', { docId: state.doc.id }, {},
            new Map([[state.doc.id, state.doc]]));
          state.fields = res.fields || [];
        } catch (e) {
          // 引擎对无 AcroForm 文件抛 ERR_BAD_ARGS——同样按空态处理
          state.fields = [];
          if (e.code !== 'ERR_BAD_ARGS') toast(e.message, 'error');
        }
        renderFields();
      },
      onRemove() {
        state.doc = null;
        state.fields = [];
        fieldsBody.textContent = '';
        hideEmpty();
        goBtn.disabled = true;
      },
    });

    const { card, body } = paramsCard();

    const flattenCb = checkbox('填写后扁平化（字段转为静态内容，不可再改）', false);
    flattenCb._input.setAttribute('data-ff-flatten', '');
    body.appendChild(field('选项', flattenCb));

    // 字段区
    const fieldsCard = paramsCard();
    const fieldsTitle = document.createElement('b');
    fieldsTitle.style.fontSize = '13.5px';
    fieldsTitle.textContent = '表单字段';
    const fieldsBody = document.createElement('div');
    fieldsBody.setAttribute('data-ff-fields', '');
    fieldsBody.style.marginTop = '8px';
    fieldsCard.body.append(fieldsTitle, fieldsBody);

    // 空态
    const emptyBox = document.createElement('div');
    emptyBox.className = 'card';
    emptyBox.style.marginTop = '14px';
    emptyBox.setAttribute('data-ff-empty', '');
    emptyBox.style.display = 'none';
    const emptyBody = document.createElement('div');
    emptyBody.className = 'card-body';
    emptyBody.innerHTML = '<div class="note">该文件没有可填写的表单字段（未找到 AcroForm 或字段为空）。<br>如需先创建字段，可使用「创建可填写表单」工具。</div>';
    emptyBox.appendChild(emptyBody);

    function hideEmpty() { emptyBox.style.display = 'none'; }
    function showEmpty() {
      emptyBox.style.display = '';
      fieldsCard.card.style.display = 'none';
      goBtn.disabled = true;
    }

    function renderFields() {
      if (!state.fields.length) { showEmpty(); return; }
      fieldsCard.card.style.display = '';
      fieldsBody.textContent = '';
      fieldsTitle.textContent = `表单字段（${state.fields.length}）`;
      for (const f of state.fields) {
        if (f.type === 'button' || f.type === 'signature') continue; // 不可填字段跳过
        let ctrl;
        if (f.type === 'checkbox') {
          const cb = checkbox('勾选', !!f.value);
          cb._input.setAttribute('data-ff-name', f.name);
          ctrl = cb;
        } else if ((f.type === 'radio' || f.type === 'dropdown' || f.type === 'optionlist') && Array.isArray(f.options) && f.options.length) {
          ctrl = select(f.options.map((o) => ({ value: o, label: o })), f.value || f.options[0]);
          ctrl.setAttribute('data-ff-name', f.name);
        } else {
          ctrl = textInput(String(f.value ?? ''), f.name);
          ctrl.setAttribute('data-ff-name', f.name);
        }
        const rowEl = document.createElement('div');
        rowEl.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
        const label = document.createElement('span');
        label.style.cssText = 'min-width:180px;font-size:13px;font-weight:600;word-break:break-all';
        label.textContent = `${f.name}（${f.type}）`;
        rowEl.append(label, ctrl);
        fieldsBody.appendChild(rowEl);
      }
      goBtn.disabled = false;
    }

    const goBtn = button('开始填写', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, emptyBox, fieldsCard.card, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const values = {};
      for (const ctrl of fieldsBody.querySelectorAll('[data-ff-name]')) {
        const name = ctrl.getAttribute('data-ff-name');
        if (ctrl.type === 'checkbox') values[name] = ctrl.checked;
        else if (ctrl.tagName === 'SELECT') values[name] = ctrl.value;
        else if (String(ctrl.value).trim() !== '') values[name] = ctrl.value;
      }
      const flatten = flattenCb._input.checked;
      const res = await run('form.fill', {
        docId: state.doc.id,
        values,
        flatten,
      }, { onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 60, p.stage) },
      new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: { 已填写: res.summary.applied, 扁平化: flatten ? '是' : '否' },
        toolId: 'formfill', toolName: '填写 PDF 表单',
        docNames: [state.doc.name],
        options: { flatten, fields: Object.keys(values).length },
        warnings: res.summary.errors?.length ? res.summary.errors : undefined,
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
