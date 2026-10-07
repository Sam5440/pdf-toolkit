// 工作流：把历史任务参数拼成可一键执行的流水线。
// 存储（localStorage）只存「参数 + 表单快照」；执行时导航到各工具页重放：
// 灌入文件 → 回填参数 → 点击该工具的运行按钮 → 从暂存区收集本次新产物作为下一步输入。
// 起始文件在运行时选择；中间步骤无产物时沿用上一步输入并提示。
import { getTool } from '../tools/registry.js';
import { trayItems } from './tray.js';
import { sendToActivePanel } from '../components/input.js';
import { applyFormSnapshot } from './restore.js';
import { uid } from './format.js';
import { log } from './logs.js';

const KEY = 'pdftoolkit.workflows.v1';

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    cache = Array.isArray(list) ? list.map(normalizeWorkflow).filter(Boolean) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 配额满忽略 */ }
}

/** 清洗单条工作流（导入/旧数据防御） */
export function normalizeWorkflow(wf) {
  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.steps)) return null;
  const steps = wf.steps.map(normalizeStep).filter(Boolean);
  return {
    id: String(wf.id || uid('wf')),
    name: String(wf.name || '未命名工作流').slice(0, 60),
    createdAt: wf.createdAt || Date.now(),
    updatedAt: wf.updatedAt || Date.now(),
    steps,
  };
}

/** 清洗单个步骤：只保留复原所需字段 */
export function normalizeStep(step) {
  if (!step || typeof step !== 'object' || !step.toolId) return null;
  if (!getTool(step.toolId)) return null; // 工具已下线则剔除
  return {
    id: String(step.id || uid('st')),
    toolId: String(step.toolId),
    toolName: String(step.toolName || step.toolId),
    recordId: step.recordId ? String(step.recordId) : '',
    docNames: Array.isArray(step.docNames) ? step.docNames.map(String).slice(0, 20) : [],
    options: step.options && typeof step.options === 'object' ? step.options : null,
    form: Array.isArray(step.form) ? step.form.slice(0, 80) : [],
  };
}

/** 全部工作流（最近更新在前） */
export function listWorkflows() {
  return [...load()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getWorkflow(id) {
  return load().find((w) => w.id === id) || null;
}

/** 新建/更新工作流，返回存储后的完整对象 */
export function saveWorkflow({ id, name, steps }) {
  const list = load();
  const norm = normalizeWorkflow({
    id: id || uid('wf'),
    name,
    steps,
    createdAt: list.find((w) => w.id === id)?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  if (!norm) throw new Error('工作流数据无效');
  const i = list.findIndex((w) => w.id === norm.id);
  if (i >= 0) list[i] = norm;
  else list.push(norm);
  cache = list;
  save();
  return norm;
}

export function deleteWorkflow(id) {
  const list = load();
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  cache = list;
  save();
  return true;
}

/** 从历史记录（列表页轻量对象）构造一个工作流步骤 */
export function stepFromRecord(rec) {
  return normalizeStep({
    toolId: rec.tool,
    toolName: rec.toolName,
    recordId: rec.id,
    docNames: rec.docNames || [],
    options: rec.options || null,
    form: rec.form || [],
  });
}

// ---------- 执行引擎 ----------

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
    setTimeout(finish, ms);
  });
}

async function gotoToolPage(toolId) {
  const target = `#/tool/${toolId}`;
  if (location.hash === target) {
    location.hash = '#/';
    await waitHashChange();
  }
  location.hash = target;
  await waitHashChange();
  await new Promise((r) => setTimeout(r, 80));
}

/** 在工具页里找「运行」按钮：参数区内第一个可用的主按钮（排除下载/保存/ZIP类） */
function findRunButton(root) {
  const candidates = [...root.querySelectorAll('button.btn-primary')]
    .filter((b) => !b.disabled && !b.closest('.modal-mask')
      && !/下载|保存|ZIP|打包|预览|复制/.test(b.textContent || ''));
  return candidates[0] || null;
}

/** 等待本步完成：新「生成」产物 / 结果区新产物行 / 进度卡到「完成」/ 出错提示 */
function waitStepDone(root, beforeTrayIds, beforeArtRows, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const errToast = document.querySelector('.toast-error');
      if (errToast) {
        clearInterval(timer);
        reject(new Error(`步骤失败：${errToast.textContent?.trim() || '工具报告错误'}`));
        return;
      }
      const alert = root.querySelector('.alert-error');
      if (alert) {
        clearInterval(timer);
        reject(new Error(`步骤失败：${alert.textContent?.trim().slice(0, 120) || '处理出错'}`));
        return;
      }
      const newTray = trayItems().some((t) => t.source === 'result' && !beforeTrayIds.has(t.id));
      const artRows = root.querySelectorAll('.result-artifact').length;
      const newArt = artRows > beforeArtRows;
      // 进度卡 done()：阶段文案恰好为「完成」（进行中是 开始处理…/处理中…/分步文案）
      const pcDone = [...root.querySelectorAll('[data-pc-stage]')]
        .some((el) => el.textContent === '完成');
      if (newTray || newArt || pcDone) {
        clearInterval(timer);
        resolve({ viaTray: newTray || newArt });
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('步骤超时（3 分钟无结果）'));
      }
    }, 300);
  });
}

/**
 * 执行一个步骤：导航 → 灌文件 → 回填参数 → 点运行 → 收集产物。
 * @returns {Promise<File[]>} 本步产物（来自暂存区镜像）
 */
export async function runStep(step, files) {
  const tool = getTool(step.toolId);
  if (!tool) throw new Error(`功能「${step.toolName}」不存在`);
  await gotoToolPage(step.toolId);
  const root = document.querySelector('.ws-main');
  if (!root) throw new Error('工具页打开失败');
  if (!files.length) throw new Error('本步没有可用输入文件');
  if (!sendToActivePanel(files)) throw new Error(`「${step.toolName}」没有输入面板，无法作为工作流步骤`);
  await new Promise((r) => setTimeout(r, 120)); // 文件校验与 onAdd 联动
  applyFormSnapshot(root, step.form);
  const beforeTrayIds = new Set(trayItems().map((t) => t.id));
  const beforeArtRows = root.querySelectorAll('.result-artifact').length;
  const btn = findRunButton(root);
  if (!btn) throw new Error(`找不到「${step.toolName}」的运行按钮`);
  log('workflow', `▶ 步骤 ${step.toolName}（${files.length} 个输入文件）`);
  btn.click();
  await waitStepDone(root, beforeTrayIds, beforeArtRows);
  await new Promise((r) => setTimeout(r, 400)); // 产物入暂存区收尾
  const outs = trayItems()
    .filter((t) => t.source === 'result' && !beforeTrayIds.has(t.id))
    .map((t) => t.file);
  log('workflow', `✓ 步骤 ${step.toolName} 产物 ${outs.length} 个`);
  return outs;
}

/**
 * 依序执行整个工作流。
 * @param {object} wf 工作流对象
 * @param {File[]} startFiles 起始文件
 * @param {{onStep?:Function, isAborted?:Function}} hooks 步骤回调 / 取消判定
 * @returns {Promise<Array<{step, outputs}>>}
 */
export async function runWorkflow(wf, startFiles, { onStep, isAborted } = {}) {
  const results = [];
  let current = [...startFiles];
  for (let i = 0; i < wf.steps.length; i++) {
    if (isAborted?.()) throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELLED' });
    const step = wf.steps[i];
    onStep?.({ index: i, step, status: 'running', inputCount: current.length });
    try {
      const outputs = await runStep(step, current);
      results.push({ step, outputs });
      if (outputs.length) current = outputs;
      else if (i < wf.steps.length - 1) {
        onStep?.({ index: i, step, status: 'no-output' }); // 无产物：后续步骤沿用原输入
      }
      onStep?.({ index: i, step, status: 'done', outputCount: outputs.length });
    } catch (e) {
      onStep?.({ index: i, step, status: 'error', message: e.message });
      throw e;
    }
  }
  return results;
}
