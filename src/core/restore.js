// 一键复原：把一条历史任务「输入文件 + 表单参数」重新灌回工具页。
// 文件走暂存区同款入口（sendToActivePanel），参数按表单快照同名标签逐一回填
// （捕获与回填两侧 DOM 顺序一致，见 tasklog.captureFormSnapshot）。
import { getHistory } from './history.js';
import { getTool } from '../tools/registry.js';
import { sendToActivePanel } from '../components/input.js';
import { toast } from '../components/ui.js';

function waitHashChange(ms = 400) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('hashchange', finish);
      resolve();
    };
    window.addEventListener('hashchange', finish);
    setTimeout(finish, ms); // 兜底：hash 未变化时也能继续
  });
}

/** 导航到工具页并等渲染完成（已在该页时先弹回首页强制重渲染，拿到干净面板） */
async function gotoTool(toolId) {
  const target = `#/tool/${toolId}`;
  if (location.hash === target) {
    location.hash = '#/';
    await waitHashChange();
  }
  location.hash = target;
  await waitHashChange();
  await new Promise((r) => setTimeout(r, 80)); // 面板事件绑定就绪
}

function setValue(el, cap) {
  if (el.tagName === 'SELECT') {
    const v = String(cap.value ?? '');
    if ([...el.options].some((o) => o.value === v)) el.value = v;
  } else if (el.type === 'checkbox') {
    el.checked = !!cap.value;
  } else {
    el.value = cap.value ?? '';
  }
  // 派发 input/change：让工具页的联动状态（校验、内部 state、按钮可用性）同步
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 把表单快照回填到 root 下与捕获同构的控件集合（同名标签按 DOM 顺序消费）。
 * @returns {number} 成功回填的字段数
 */
export function applyFormSnapshot(root, form) {
  if (!root || !Array.isArray(form) || !form.length) return 0;
  const targets = [];
  for (const w of root.querySelectorAll('.field')) {
    const label = w.querySelector(':scope > label');
    const el = w.querySelector('input:not([type=file]):not([type=password]), select, textarea');
    if (label && el) targets.push({ label: label.textContent.trim(), el });
  }
  for (const l of root.querySelectorAll('label.checkbox-row')) {
    const el = l.querySelector('input[type=checkbox]');
    if (el) targets.push({ label: (l.querySelector('span')?.textContent || '').trim(), el });
  }
  const used = new Set();
  let applied = 0;
  for (const cap of form) {
    const i = targets.findIndex((t, idx) => !used.has(idx)
      && t.label === cap.label
      && (cap.type === 'checkbox' ? t.el.type === 'checkbox' : cap.type === 'select' ? t.el.tagName === 'SELECT' : t.el.type !== 'checkbox'));
    if (i < 0) continue;
    used.add(i);
    setValue(targets[i].el, cap);
    applied++;
  }
  return applied;
}

/**
 * 一键复原一条历史任务：跳转工具页 → 灌回输入文件 → 回填表单参数。
 * @param {string} id 历史记录 id
 * @returns {Promise<boolean>} 是否复原成功
 */
export async function restoreFromRecord(id) {
  const rec = await getHistory(id);
  if (!rec) { toast('历史记录不存在', 'error'); return false; }
  const tool = getTool(rec.tool);
  if (!tool) { toast(`功能「${rec.toolName}」当前不存在，无法复原`, 'error'); return false; }
  const files = (rec.inputs || []).filter((i) => i && i.blob)
    .map((i) => new File([i.blob], i.name, { type: i.mime || '' }));
  await gotoTool(rec.tool);
  const root = document.querySelector('.ws-main');
  if (!root) { toast('工具页打开失败', 'error'); return false; }
  let fileN = 0;
  if (files.length) {
    if (!sendToActivePanel(files)) { toast('该工具页没有输入面板，仅恢复了参数', 'error'); }
    else fileN = files.length;
  }
  await new Promise((r) => setTimeout(r, 60)); // 文件 onAdd 联动先走
  const applied = applyFormSnapshot(root, rec.form);
  toast(`已复原「${rec.toolName}」：${fileN ? `${fileN} 个文件` : '无输入文件记录'}${applied ? ` · ${applied} 项参数` : ''}，确认后点击开始处理`);
  return true;
}
