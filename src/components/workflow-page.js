// 工作流页（#/workflows）：把历史任务参数拼接成流水线，保存后一键运行。
// 运行弹窗挂在 body 上（renderApp 清空的是 #app），逐步导航工具页重放也不打断。
import { esc, fmtTime2 } from '../core/format.js';
import { toast, openModal, confirmDialog, button, field, textInput } from './ui.js';
import { iconNode } from './icons.js';
import {
  listWorkflows, saveWorkflow, deleteWorkflow, runWorkflow, stepFromRecord,
} from '../core/workflows.js';
import { listHistory } from '../core/history.js';
import { pickFiles } from '../core/files.js';

/** 参数摘要（单行、截断） */
function optionsSummary(options) {
  if (!options || typeof options !== 'object') return '';
  const s = Object.entries(options)
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? '…' : String(v)}`)
    .join(' · ');
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** 步骤链条文本：工具 A → 工具 B → … */
function chainText(steps) {
  return steps.map((s) => s.toolName).join(' → ');
}

// ---------- 运行弹窗 ----------

/** 运行一个工作流：选起始文件 → 逐步执行（状态实时刷新，Esc/关闭即请求停止） */
function openRunner(wf, rerender) {
  const files = [];
  let abort = false;
  const box = document.createElement('div');

  const stepRows = wf.steps.map((s, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)';
    row.innerHTML = `
      <span class="badge badge-muted" style="flex:none">${i + 1}</span>
      <div style="flex:1;min-width:0">
        <b style="font-size:13.5px">${esc(s.toolName)}</b>
        <div class="hint">${esc(optionsSummary(s.options) || '默认参数')}</div>
      </div>
      <span class="badge badge-muted" data-status>等待</span>`;
    return row;
  });

  const fileLine = document.createElement('div');
  fileLine.className = 'hint';
  fileLine.style.marginTop = '8px';
  fileLine.textContent = '尚未选择起始文件';

  const pickBtn = button('选择起始文件', 'btn-outline btn-sm', async () => {
    const picked = await pickFiles({ multiple: true, accept: 'application/pdf,.pdf,image/*,.pdf,.jpg,.jpeg,.png,.webp' });
    files.length = 0;
    files.push(...picked);
    fileLine.textContent = files.length
      ? `起始文件：${files.length} 个（${files.map((f) => f.name).join('、').slice(0, 80)}）`
      : '尚未选择起始文件';
  });
  pickBtn.setAttribute('aria-label', '选择工作流起始文件');

  const runBtn = button('开始执行', 'btn-primary btn-sm', null);
  const statusLine = document.createElement('div');
  statusLine.className = 'hint';
  statusLine.style.marginTop = '8px';

  runBtn.onclick = async () => {
    if (!files.length) { toast('请先选择起始文件', 'error'); return; }
    if (!wf.steps.length) { toast('工作流还没有步骤', 'error'); return; }
    abort = false;
    runBtn.disabled = true;
    pickBtn.disabled = true;
    try {
      const results = await runWorkflow(wf, files, {
        isAborted: () => abort,
        onStep: (u) => {
          const row = stepRows[u.index];
          if (!row) return;
          const badge = row.querySelector('[data-status]');
          if (u.status === 'running') {
            badge.textContent = '运行中…';
            badge.className = 'badge badge-primary';
            row.scrollIntoView({ block: 'nearest' });
          } else if (u.status === 'done') {
            badge.textContent = `完成 · 产物 ${u.outputCount}`;
            badge.className = 'badge badge-ok';
          } else if (u.status === 'no-output') {
            badge.textContent = '无产物（后续沿用原输入）';
            badge.className = 'badge badge-warn';
          } else if (u.status === 'error') {
            badge.textContent = '失败';
            badge.className = 'badge badge-no';
            badge.title = u.message || '';
          }
        },
      });
      statusLine.textContent = `工作流完成：${results.length} 个步骤执行完毕，最终产物已入暂存区（右侧面板可预览/下载）。`;
      toast('工作流执行完成');
    } catch (e) {
      if (e.code === 'ERR_CANCELLED') statusLine.textContent = '已取消（当前步骤完成后停止）。';
      else {
        statusLine.textContent = `执行失败：${e.message}`;
        toast(e.message, 'error', 5000);
      }
    } finally {
      runBtn.disabled = false;
      pickBtn.disabled = false;
      rerender?.();
    }
  };

  const top = document.createElement('div');
  top.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  top.append(pickBtn, runBtn, fileLine);
  box.append(top, ...stepRows, statusLine);

  const modal = openModal(`运行工作流 · ${wf.name}`, box);
  modal.setOnClose(() => { abort = true; });
}

// ---------- 新建 / 编辑弹窗 ----------

/** 从历史记录挑选步骤，拼接成工作流（steps 为可变数组，直接就地编辑） */
function openBuilder(existing, rerender) {
  const steps = existing ? existing.steps.map((s) => ({ ...s })) : [];
  const box = document.createElement('div');

  const nameInp = textInput(existing?.name || '', '如：扫描件清理流水线');
  nameInp.setAttribute('aria-label', '工作流名称');
  box.appendChild(field('工作流名称', nameInp));

  const stepList = document.createElement('div');
  stepList.style.marginTop = '4px';
  box.appendChild(stepList);

  function renderSteps() {
    stepList.innerHTML = '';
    if (!steps.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.style.padding = '10px 0';
      empty.textContent = '还没有步骤：从下方「添加历史任务」选择一条记录，或到「历史」页点击「存为工作流」。';
      stepList.appendChild(empty);
      return;
    }
    steps.forEach((s, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)';
      const no = document.createElement('span');
      no.className = 'badge badge-muted';
      no.style.flex = 'none';
      no.textContent = String(i + 1);
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      info.innerHTML = `
        <b style="font-size:13.5px">${esc(s.toolName)}</b>
        <div class="hint">${esc(optionsSummary(s.options) || '默认参数')}</div>`;
      const up = button('↑', 'btn-ghost btn-xs', () => {
        if (i > 0) { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; renderSteps(); }
      });
      up.setAttribute('aria-label', `上移步骤 ${i + 1}：${s.toolName}`);
      const down = button('↓', 'btn-ghost btn-xs', () => {
        if (i < steps.length - 1) { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; renderSteps(); }
      });
      down.setAttribute('aria-label', `下移步骤 ${i + 1}：${s.toolName}`);
      const rm = button('移除', 'btn-ghost btn-xs', () => { steps.splice(i, 1); renderSteps(); });
      rm.setAttribute('aria-label', `移除步骤 ${i + 1}：${s.toolName}`);
      row.append(no, info, up, down, rm);
      stepList.appendChild(row);
    });
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '8px';
    note.textContent = '执行方式：第 1 步使用运行时选择的起始文件，之后每步自动使用上一步产物；运行全程在本机完成。';
    stepList.appendChild(note);
  }
  renderSteps();

  // 添加步骤：从最近历史挑选
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap';
  const histSel = document.createElement('select');
  histSel.setAttribute('aria-label', '选择历史任务作为步骤');
  histSel.style.cssText = 'flex:1;min-width:220px;max-width:100%';
  listHistory({ limit: 50 }).then((recs) => {
    histSel.innerHTML = '<option value="">— 选择历史任务 —</option>'
      + recs.map((r) => `<option value="${esc(r.id)}">${esc(r.toolName)} · ${esc(optionsSummary(r.options) || fmtTime2(r.time))}</option>`).join('');
    histSel._recs = recs;
  });
  const addBtn = button('添加为步骤', 'btn-outline btn-sm', () => {
    const rec = histSel._recs?.find((r) => r.id === histSel.value);
    if (!rec) { toast('请先选择一条历史任务', 'error'); return; }
    const step = stepFromRecord(rec);
    if (!step) { toast('该记录的功能已下线，无法加入', 'error'); return; }
    steps.push(step);
    renderSteps();
  });
  addBtn.setAttribute('aria-label', '把选中的历史任务添加为步骤');
  addRow.append(histSel, addBtn);
  box.appendChild(addRow);

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:8px;margin-top:14px';
  const saveBtn = button(existing ? '保存修改' : '创建工作流', 'btn-primary', () => {
    const name = nameInp.value.trim();
    if (!name) { toast('请填写工作流名称', 'error'); return; }
    if (!steps.length) { toast('至少添加一个步骤', 'error'); return; }
    saveWorkflow({ id: existing?.id, name, steps });
    toast(existing ? '工作流已更新' : '工作流已创建');
    modal.close();
    rerender?.();
  });
  foot.appendChild(saveBtn);
  box.appendChild(foot);

  const modal = openModal(existing ? '编辑工作流' : '新建工作流', box);
}

// ---------- 页面 ----------

export function renderWorkflowPage(content) {
  const head = document.createElement('div');
  head.className = 'card';
  head.style.marginBottom = '16px';
  head.innerHTML = `
    <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
      <div class="hero-ico" data-hero-ico></div>
      <div style="flex:1;min-width:0">
        <b style="font-size:15px">工作流</b>
        <div class="note" style="margin-top:4px">把历史任务的完整参数任意拼接成流水线：选择起始文件后一键依序执行，每步产物自动作为下一步输入。全部在本机浏览器完成。</div>
      </div>
      <div data-new></div>
    </div>`;
  head.querySelector('[data-hero-ico]').appendChild(iconNode('workflow'));
  const rerender = () => renderAppPage();
  const newBtn = button('新建工作流', 'btn-primary btn-sm', () => openBuilder(null, rerender));
  newBtn.setAttribute('aria-label', '新建工作流');
  head.querySelector('[data-new]').appendChild(newBtn);
  content.appendChild(head);

  const wfs = listWorkflows();
  if (!wfs.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = '<div class="card-body"><div class="empty"><span class="empty-ico"></span>还没有工作流<br>点击「新建工作流」，从历史任务选择参数拼接；也可在「历史」页把单条记录一键存为工作流</div></div>';
    empty.querySelector('.empty-ico').appendChild(iconNode('workflow'));
    content.appendChild(empty);
    return;
  }
  for (const wf of wfs) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '8px';
    const body = document.createElement('div');
    body.className = 'card-body';
    body.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:220px';
    info.innerHTML = `
      <b>${esc(wf.name)}</b> <span class="badge badge-muted">${wf.steps.length} 步</span>
      <div class="note">${esc(chainText(wf.steps))}</div>
      <div class="hint">更新于 ${fmtTime2(wf.updatedAt)}</div>`;
    const runBtn = button('运行', 'btn-primary btn-sm', () => openRunner(wf, rerender));
    runBtn.setAttribute('aria-label', `运行工作流：${wf.name}`);
    const editBtn = button('编辑', 'btn-outline btn-sm', () => openBuilder(wf, rerender));
    editBtn.setAttribute('aria-label', `编辑工作流：${wf.name}`);
    const delBtn = button('删除', 'btn-ghost btn-sm', async () => {
      const ok = await confirmDialog({
        title: '删除工作流',
        message: `删除工作流「${wf.name}」？（不影响历史记录与暂存区文件）`,
        confirmText: '删除',
        destructive: true,
      });
      if (!ok) return;
      deleteWorkflow(wf.id);
      toast('已删除工作流');
      rerender();
    });
    delBtn.setAttribute('aria-label', `删除工作流：${wf.name}`);
    body.append(info, runBtn, editBtn, delBtn);
    card.appendChild(body);
    content.appendChild(card);
  }
}

/** 整页重渲染（复用 main.js 的 hashchange 路由，hash 未变也会重跑 renderApp） */
function renderAppPage() {
  window.dispatchEvent(new Event('hashchange'));
}
