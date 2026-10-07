// 任务记录中枢：每个生成任务完成后自动存一条「完整参数历史」——
// 无损参数（敏感键剔除）+ 输入/输出文件 + 工具页表单快照，供历史页一键复原
// 与工作流复用。设置 taskAutoRecord=false 时退回手动「存入历史」按钮。
import { addHistory } from './history.js';
import { getSettings } from './settings.js';
import { log } from './logs.js';
import { listDocuments } from './files.js';
import { button, toast } from '../components/ui.js';

/** 自动记录开关（设置「处理」区） */
export function isAutoRecordEnabled() {
  return getSettings().taskAutoRecord !== false;
}

/**
 * 采集工具页表单快照：扫 root 下 .field（label[for]→控件）与 label.checkbox-row，
 * 产出有序 [{label,type,value}]。密码/文件输入一律跳过（不落盘红线）。
 * 匹配复原按「同名标签按 DOM 顺序逐一消费」进行，两侧顺序一致即可靠。
 */
export function captureFormSnapshot(root) {
  if (typeof document === 'undefined' || !root) return [];
  const out = [];
  for (const w of root.querySelectorAll('.field')) {
    const label = w.querySelector(':scope > label');
    const el = w.querySelector('input:not([type=file]):not([type=password]), select, textarea');
    if (!label || !el) continue;
    out.push({ label: label.textContent.trim(), type: el.tagName === 'SELECT' ? 'select' : (el.type || 'text'), value: el.type === 'checkbox' ? el.checked : String(el.value ?? '') });
  }
  for (const l of root.querySelectorAll('label.checkbox-row')) {
    const el = l.querySelector('input[type=checkbox]');
    if (!el) continue;
    out.push({ label: (l.querySelector('span')?.textContent || '').trim(), type: 'checkbox', value: el.checked });
  }
  return out;
}

/**
 * 解析任务输入文件：优先调用方显式给出的 docs；
 * 否则按 docNames 到当前活跃输入面板（本页刚处理完的面板）匹配，
 * 缺口再到全局文档注册表按名补齐（同名取最近添加——重加同名几乎必为同一文件）。
 * @returns {Array<{id,name,size,type,file}>}
 */
export function resolveInputs({ docs, docNames }) {
  const names = new Set((docNames || []).filter(Boolean));
  const found = [];
  const seen = new Set();
  const push = (d) => {
    if (!d || seen.has(d.id)) return;
    seen.add(d.id);
    found.push(d);
  };
  for (const d of docs || []) push(d);
  // 全局文档注册表按名补缺（最近添加优先；同名重复添加取最新——几乎必为同一文件）
  if (names.size && found.length < names.size) {
    const all = listDocuments().slice().reverse();
    for (const n of names) {
      if (found.some((d) => d.name === n)) continue;
      const hit = all.find((d) => d.name === n);
      if (hit) push(hit);
    }
  }
  return found;
}

/** 产物 → 历史输出条目（bytes 包装成 Blob） */
function outputEntries(arts) {
  return (arts || []).filter((a) => a && a.bytes != null).map((a) => ({
    name: a.name,
    mime: a.mime || 'application/octet-stream',
    size: a.bytes.byteLength,
    blob: new Blob([a.bytes], { type: a.mime || 'application/octet-stream' }),
  }));
}

/**
 * 记录一次任务（自动记录开启时）。返回是否已记录。
 * @param {{tool,toolName,docNames,options,docs,arts,outputs,warnings,auto}} p
 *  - docs: 输入文档对象（可省略，按 docNames 自动解析）
 *  - arts: 引擎产物 [{name,mime,bytes}]（与 outputs 二选一）
 */
export async function recordTask(p) {
  const inputs = resolveInputs({ docs: p.docs, docNames: p.docNames })
    .map((d) => ({ name: d.name, mime: d.type || '', size: d.size, blob: d.file }));
  const rec = {
    id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    tool: p.tool,
    toolName: p.toolName || p.tool,
    docNames: p.docNames || [],
    options: p.options ?? null,
    inputs,
    outputs: p.outputs || outputEntries(p.arts),
    warnings: p.warnings || [],
    form: p.form || [],
    auto: p.auto !== false,
  };
  try {
    await addHistory(rec);
    return true;
  } catch (e) {
    log('history', '任务记录写入失败', { level: 'warn', detail: String(e?.message || e) });
    return false;
  }
}

/**
 * 生成任务完成后调用：自动记录开启 → 记录并返回 null（调用方展示「已自动存入历史」）；
 * 关闭 → 返回一个手动「存入历史」按钮（沿用旧交互，但保存内容同样完整）。
 * @returns {Promise<HTMLElement|null>}
 */
export async function recordTaskOrButton(p) {
  if (isAutoRecordEnabled()) {
    await recordTask({ ...p, auto: true });
    return null;
  }
  return button(p.saveLabel || '存入历史', 'btn-outline', async () => {
    await recordTask({ ...p, auto: false });
    toast('已保存到历史');
  });
}

/** 当前工具页整页表单快照（参数卡等全部控件；非工具页/无 DOM 时返回空） */
export function capturePageForm() {
  if (typeof document === 'undefined') return [];
  return captureFormSnapshot(document.querySelector('.ws-main'));
}

/** 「已自动存入历史」提示行（resultCard / 工具结果卡复用） */
export function recordNote(text = '已自动存入历史，可在「历史」页查看或一键复原') {
  if (typeof document === 'undefined') return null;
  const d = document.createElement('div');
  d.className = 'hint';
  d.style.marginTop = '6px';
  d.textContent = text;
  return d;
}
