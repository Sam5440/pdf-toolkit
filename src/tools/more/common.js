// 「更多」工具族共享 UI 助手：结果卡片（下载/ZIP/历史）、参数卡、选择器。
// 目标：让各工具控制器只写「参数表单 + 调引擎」的差异化部分。
import { iconNode } from '../../components/icons.js';
import {
  button, progressCard, warningsBox, toast,
} from '../../components/ui.js';
import { fmtBytes } from '../../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';
import { downloadArtifact, downloadZip } from '../../core/download.js';

/** 参数卡片：<div class=card><div class=card-body>…</div></div>，返回 {card, body} */
export function paramsCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginTop = '14px';
  const body = document.createElement('div');
  body.className = 'card-body';
  card.appendChild(body);
  return { card, body };
}

/**
 * 标准结果卡片：统计行 + 产物列表（逐个下载）+ ZIP/历史按钮 + 警告。
 * @param {{arts:Array, summary?:object, toolId:string, toolName:string, docNames:string[], options?:object, el?:HTMLElement, extraNote?:string}} p
 */
export function resultCard(p) {
  const arts = p.arts || [];
  const card = document.createElement('div');
  card.className = 'card';
  const ib = document.createElement('div');
  ib.className = 'card-body';
  const kv = document.createElement('div');
  kv.className = 'kv';
  const b = document.createElement('b');
  b.appendChild(iconNode('success'));
  const bits = Object.entries(p.summary || {}).map(([k, v]) => `${k} ${v}`);
  b.appendChild(document.createTextNode(` 处理完成：${arts.length} 个文件${bits.length ? ` · ${bits.join(' · ')}` : ''}`));
  kv.appendChild(b);
  ib.appendChild(kv);
  const list = document.createElement('div');
  list.style.marginTop = '10px';
  arts.forEach((art, i) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'result-artifact';
    const ico = document.createElement('span');
    ico.className = 'ra-ico';
    ico.replaceChildren(iconNode('doc'));
    const info = document.createElement('div');
    info.className = 'ra-info';
    const nm = document.createElement('div');
    nm.className = 'ra-name';
    nm.textContent = art.name;
    const meta = document.createElement('div');
    meta.className = 'ra-meta';
    meta.textContent = `${arts.length > 1 ? `${i + 1} · ` : ''}${fmtBytes(art.bytes.byteLength)}`;
    info.append(nm, meta);
    rowEl.append(ico, info, button('下载', 'btn-outline btn-sm', () => downloadArtifact(art)));
    list.appendChild(rowEl);
  });
  ib.appendChild(list);
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
  if (arts.length > 1) {
    actions.appendChild(button('打包下载 ZIP', 'btn-primary', () => downloadZip(arts, `${p.toolName}.zip`)));
  }
  // 任务自动记录：完整参数 + 输入/输出文件 + 表单快照（自动记录关闭时退回手动按钮）
  recordTaskOrButton({
    tool: p.toolId, toolName: p.toolName,
    docNames: p.docNames || [],
    options: p.options ?? null,
    docs: p.inputs,
    arts,
    warnings: p.warnings,
    form: capturePageForm(),
  }).then((btn) => {
    if (btn) actions.appendChild(btn);
    else card.appendChild(recordNote());
  }).catch(() => { /* 记录失败不阻塞结果展示 */ });
  ib.appendChild(actions);
  if (p.extraNote) {
    const note = document.createElement('div');
    note.className = 'note';
    note.style.marginTop = '8px';
    note.textContent = p.extraNote;
    ib.appendChild(note);
  }
  const w = warningsBox(p.warnings);
  if (w) ib.appendChild(w);
  card.appendChild(ib);
  return card;
}

/** 执行包装：进度卡 + 错误提示（工具 run 的统一样板） */
export function runWithProgress(container, fn) {
  const box = document.createElement('div');
  box.style.marginTop = '14px';
  container.appendChild(box);
  return async () => {
    box.textContent = '';
    const pc = progressCard();
    box.appendChild(pc.el);
    pc.set(5, '开始处理…');
    const t0 = Date.now();
    try {
      const res = await fn((pct, stage) => pc.set(pct, stage || '处理中…'));
      pc.done();
      return { res, ms: Date.now() - t0 };
    } catch (e) {
      pc.error(e.message);
      if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      return null;
    }
  };
}
