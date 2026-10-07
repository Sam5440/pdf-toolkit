// 页面整理（subagent A）：pageWorkbench 缩略图工作台 + 撤销/重做 + 整理导出
import { iconNode } from '../components/icons.js';
import { registerTool } from './core.js';
import { run, ensureDoc } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { pageWorkbench } from '../components/pagethumbs.js';
import { progressCard, warningsBox, toast, field, textInput, button } from '../components/ui.js';
import { parsePageRange } from '../core/pagerange.js';
import { fmtBytes } from '../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { downloadArtifact } from '../core/download.js';

registerTool({
  id: 'organize',
  name: '页面整理',
  group: 'pages',
  desc: '缩略图工作台：拖拽重排、旋转、删除、复制、插入页面',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0, running: false };

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
          state.doc.info = info; // buildPlan 读取 info.pages[].rot 作为基础旋转
          state.pageCount = info.pageCount;
          loadPages('all');
        } catch (e) {
          toast(e.message, 'error');
        }
        updateGoState();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        wb.setPages([]);
        updateGoState();
      },
    });

    // ---- 页范围子集 ----
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';
    const rangeInp = textInput('', '如 1-5,8（留空 = 全部页）');
    const loadBtn = button('载入页面', 'btn-outline btn-sm', () => loadPages(rangeInp.value.trim() || 'all'));
    rangeInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPages(rangeInp.value.trim() || 'all'); });
    body.append(
      field('页范围（重新载入子集，可选）', rangeInp, '选择文件后默认载入全部页；修改后点击「载入页面」'),
      loadBtn,
    );
    controls.appendChild(body);

    // ---- 工作台（工具条在上） ----
    const wb = pageWorkbench({
      docs: () => panel.docs(),
      onChange: () => updateGoState(),
    });
    wb.toolbarEl.setAttribute('data-organize-toolbar', '');
    const wsCard = document.createElement('div');
    wsCard.className = 'card';
    wsCard.style.marginTop = '14px';
    const wsBody = document.createElement('div');
    wsBody.className = 'card-body';
    const wsTitle = document.createElement('b');
    wsTitle.style.cssText = 'font-size:13.5px;display:block;margin-bottom:10px';
    wsTitle.textContent = '页面工作台（点击选择，Ctrl 多选，Shift 连选，拖拽排序）';
    wsBody.append(wsTitle, wb.toolbarEl, wb.el);
    wsCard.appendChild(wsBody);

    // ---- 快捷操作（与工具条等价 + 恢复原序） ----
    const opsCard = document.createElement('div');
    opsCard.className = 'card';
    opsCard.style.marginTop = '14px';
    const opsBody = document.createElement('div');
    opsBody.className = 'card-body';
    opsBody.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    opsBody.append(
      button('⟲ 旋转所选 90°', 'btn-outline btn-sm', () => wb.rotateSelected(90)),
      (() => { const b = button(' 删除所选', 'btn-outline btn-sm', () => wb.deleteSelected()); b.prepend(iconNode('trash')); return b; })(),
      button('⧉ 复制所选', 'btn-outline btn-sm', () => wb.duplicateSelected()),
      button('＋ 插入空白页', 'btn-outline btn-sm', () => wb.insertBlankAfterSelected()),
      button('⟲ 恢复原序', 'btn-outline btn-sm', () => {
        if (!state.doc) { toast('请先选择 PDF 文件', 'error'); return; }
        loadPages('all');
        toast('已恢复原序（撤销记录已重置）');
      }),
    );
    opsCard.appendChild(opsBody);

    const goBtn = button('开始整理', 'btn-primary', () => doOrganize());
    goBtn.setAttribute('data-organize', 'go');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(panel.el, controls, wsCard, opsCard, goBtn, resultBox);

    /** 载入页面（页范围可选子集）到工作台 */
    function loadPages(rangeInput) {
      if (!state.doc || !state.pageCount) { toast('请先选择 PDF 文件', 'error'); return; }
      const r = parsePageRange(rangeInput || 'all', state.pageCount);
      if (!r.ok) { toast(r.error, 'error'); return; }
      wb.setPages(r.pages.map((p) => ({
        key: `p${p}`,
        docId: state.doc.id,
        docName: state.doc.name,
        srcPage: p,
        rotationDelta: 0,
      })));
      updateGoState();
    }

    function updateGoState() {
      goBtn.disabled = state.running || !state.doc || !wb.pages.length;
    }

    async function doOrganize() {
      const doc = state.doc;
      if (!doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const plan = await wb.buildPlan();
      if (!plan.length) { toast('页面计划为空：请至少保留一页', 'error'); return; }
      const docsMap = new Map([[doc.id, doc]]);
      state.running = true;
      goBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(5, '开始整理…');
      const t0 = Date.now();
      try {
        const res = await run('pages.organize', { docId: doc.id, plan }, {
          onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 0, p.stage || '整理中…'),
        }, docsMap);
        pc.done();
        renderResult(res, doc, plan, Date.now() - t0);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        state.running = false;
        updateGoState();
      }
    }

    function renderResult(res, doc, plan, ms) {
      const [art] = res.artifacts;
      const card = document.createElement('div');
      card.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      const b = document.createElement('b');
      b.appendChild(iconNode('success'));
      b.appendChild(document.createTextNode(` 整理完成：输出 ${res.summary?.pages ?? plan.length} 页 · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round(ms / 100) / 10}s`));
      kv.appendChild(b);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      actions.appendChild(button('下载整理结果', 'btn-primary', () => downloadArtifact(art)));
      ib.append(kv, actions);
      recordTaskOrButton({
        tool: 'organize', toolName: '页面整理',
        docNames: [doc.name],
        options: { pages: plan.length, blanks: plan.filter((p) => p.blank).length },
        docs: [doc],
        outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
        form: capturePageForm(),
      }).then((recBtn) => {
        if (recBtn) actions.appendChild(recBtn);
        else ib.appendChild(recordNote());
      });
      const w = warningsBox(res.warnings);
      if (w) ib.appendChild(w);
      card.appendChild(ib);
      resultBox.appendChild(card);
    }
  },
});
