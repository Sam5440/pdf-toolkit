// 数据库页（#/data）：本机用户数据库概览 + 全量导出 / 导入恢复。
// 覆盖：设置与外观、收藏、最近使用、工作流（localStorage）+ 历史（含输入输出文件）、
// 暂存区（含文件夹）、外挂字体（IndexedDB）。引擎 WASM 缓存可重新下载，不在其中。
import { esc, fmtBytes } from '../core/format.js';
import { toast, openModal, confirmDialog, button } from './ui.js';
import { iconNode } from './icons.js';
import { storageSummary, exportAll, importAll, backupName } from '../core/userdb.js';
import { pickFiles } from '../core/files.js';
import { downloadArtifact } from '../core/download.js';

export function renderDataPage(content) {
  const head = document.createElement('div');
  head.className = 'card';
  head.style.marginBottom = '16px';
  head.innerHTML = `
    <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
      <div class="hero-ico" data-hero-ico></div>
      <div style="flex:1;min-width:0">
        <b style="font-size:15px">本地数据库</b>
        <div class="note" style="margin-top:4px">您的全部数据（历史任务与文件、暂存区、字体、设置、工作流）只保存在本机浏览器中。这里可以整库打包导出为一个备份文件，或从备份文件一键恢复——换设备、清浏览器数据前先导出。</div>
      </div>
    </div>`;
  head.querySelector('[data-hero-ico]').appendChild(iconNode('database'));
  content.appendChild(head);

  const summaryCard = document.createElement('div');
  summaryCard.className = 'card';
  summaryCard.style.marginBottom = '16px';
  const sbody = document.createElement('div');
  sbody.className = 'card-body';
  sbody.innerHTML = '<div class="hint"><span class="spinner"></span> 统计中…</div>';
  summaryCard.appendChild(sbody);
  content.appendChild(summaryCard);

  storageSummary().then((s) => {
    const rows = [
      ['历史任务（含输入/输出文件）', `${s.history.count} 条 · ${fmtBytes(s.history.bytes)}`],
      ['暂存区（含文件夹）', `${s.tray.count} 个 · ${fmtBytes(s.tray.bytes)}`],
      ['外挂字体', `${s.fonts.count} 个 · ${fmtBytes(s.fonts.bytes)}`],
      ['工作流', `${s.workflows.count} 条`],
      ['设置与偏好键', `${s.localStorageKeys} 项`],
    ];
    sbody.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border)';
      row.innerHTML = `<span>${esc(k)}</span><b class="ver-mono" style="font-size:13px">${esc(v)}</b>`;
      sbody.appendChild(row);
    }
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '8px';
    note.textContent = '引擎 WASM 缓存（pandoc/Typst 等）不参与备份，需要时会自动重新下载。';
    sbody.appendChild(note);
  });

  const ops = document.createElement('div');
  ops.className = 'card';
  const obody = document.createElement('div');
  obody.className = 'card-body';

  const exportBtn = button('导出全部数据', 'btn-primary', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    toast('正在打包全部数据…');
    try {
      const blob = await exportAll();
      downloadArtifact({ name: backupName(), mime: 'application/zip', bytes: blob });
      toast('备份已导出，请妥善保管（内含全部本机数据）');
    } catch (e) {
      toast(`导出失败：${e.message}`, 'error', 5000);
    } finally {
      btn.disabled = false;
    }
  });
  exportBtn.setAttribute('aria-label', '导出全部本机数据为备份包');

  const importBtn = button('导入备份包', 'btn-outline', async () => {
    const files = await pickFiles({ multiple: false, accept: '.zip,application/zip' });
    if (!files.length) return;
    const ok = await confirmDialog({
      title: '导入备份包',
      message: '导入将覆盖本机现有全部数据（历史、暂存区、字体、设置、工作流），完成后自动刷新页面。确定继续？',
      confirmText: '覆盖并导入',
      destructive: true,
    });
    if (!ok) return;
    try {
      const { manifest, restored } = await importAll(files[0]);
      const box = document.createElement('div');
      box.innerHTML = `
        <p style="margin:0 0 10px;font-size:13.5px">导入完成（备份时间 ${esc(new Date(manifest.exportedAt).toLocaleString())}）：</p>
        <div class="hint">历史 ${restored.history} 条 · 暂存区 ${restored.tray} 个 · 字体 ${restored.fonts} 个 · 设置 ${restored.settings} 项</div>`;
      openModal('导入成功', box);
      setTimeout(() => location.reload(), 1600);
    } catch (e) {
      toast(`导入失败：${e.message}`, 'error', 5000);
    }
  });
  importBtn.setAttribute('aria-label', '从备份包导入数据（覆盖现有）');

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:center';
  row.append(exportBtn, importBtn);
  obody.appendChild(row);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.style.marginTop = '8px';
  hint.textContent = '备份为 .zip 文件；导入时按备份内容整库覆盖，不会与现有数据合并。';
  obody.appendChild(hint);
  ops.appendChild(obody);
  content.appendChild(ops);
}
