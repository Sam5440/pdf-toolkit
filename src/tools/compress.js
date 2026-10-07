// PDF 压缩 — 三种模式智能寻优 + SSIM 质量评估 + 候选列表与推荐
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run, abort } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { progressCard, warningsBox, toast, field, numberInput, select, checkbox, row, button } from '../components/ui.js';
import { fmtBytes, esc } from '../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { downloadArtifact, downloadZip } from '../core/download.js';

const MODE_LABELS = { smart: '智能图像重压', raster: '栅格化重建', structural: '结构无损' };
const MODE_DESC = {
  smart: '重编码 PDF 内嵌图像（推荐，保持文字可选）',
  raster: '整页转为图像：文字不可选中、体积换清晰度',
  structural: '仅重写文件结构，几乎不损质量，压缩有限',
};

registerTool({
  id: 'compress',
  name: 'PDF 压缩',
  group: 'optimize',
  desc: '三种模式智能寻优：图像重压/栅格化/结构无损 + SSIM 质量评估',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '处理全程在本地浏览器完成，文件不离开您的设备',
    });

    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    // 目标体积
    const targetNum = numberInput(2, { min: 0.05, step: 0.1 });
    const targetUnit = select([{ value: 'MB', label: 'MB' }, { value: 'KiB', label: 'KiB' }], 'MB');
    body.appendChild(field('目标体积（可选，0=不限，引擎将在达标方案中选质量最高者）', row(targetNum, targetUnit)));

    // 模式多选
    const modeBox = document.createElement('div');
    modeBox.className = 'field';
    const modeLabel = document.createElement('label');
    modeLabel.textContent = '压缩模式（可多选）';
    modeBox.appendChild(modeLabel);
    const modeChecks = {};
    for (const m of ['smart', 'raster', 'structural']) {
      const c = checkbox(`${MODE_LABELS[m]} —— ${MODE_DESC[m]}`, m !== 'raster');
      modeChecks[m] = c._input;
      modeBox.appendChild(c);
    }
    body.appendChild(modeBox);

    // SSIM
    const ssimCheck = checkbox('评估质量（SSIM ≥ 0.90 才算达标；关闭可提速）', true);
    body.appendChild(field('质量评估', ssimCheck, 'SSIM 与原稿的结构相似度（0-1），越高越接近原稿'));

    // 状态与按钮
    const goBtn = button('开始压缩', 'btn-primary', () => doCompress());
    goBtn.style.width = '100%';
    const cancelBtn = button('取消', 'btn-outline', () => { if (opId) abort(opId); });
    cancelBtn.style.display = 'none';
    body.appendChild(row(goBtn, cancelBtn));
    controls.appendChild(body);

    const liveBox = document.createElement('div');
    liveBox.style.marginTop = '14px';
    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';
    container.append(panel.el, controls, liveBox, resultBox);

    let opId = null;

    async function doCompress() {
      const docs = panel.docs();
      resultBox.innerHTML = '';
      liveBox.innerHTML = '';
      if (!docs.length) { toast('请先选择 PDF 文件', 'error'); return; }
      const doc = docs[0];

      const modes = {};
      for (const [k, c] of Object.entries(modeChecks)) modes[k] = c.checked;
      if (!Object.values(modes).some(Boolean)) { toast('请至少选择一种压缩模式', 'error'); return; }
      const tv = parseFloat(targetNum.value) || 0;
      const targetBytes = tv > 0 ? Math.round(tv * (targetUnit.value === 'MB' ? 1024 * 1024 : 1024)) : null;

      const pc = progressCard();
      liveBox.appendChild(pc.el);
      goBtn.disabled = true;
      cancelBtn.style.display = '';
      const t0 = Date.now();

      // 候选实时列表（progress.rows 快照）
      const liveList = document.createElement('div');
      liveList.className = 'card';
      liveList.style.marginTop = '10px';
      const liveBody = document.createElement('div');
      liveBody.className = 'card-body';
      liveBody.innerHTML = '<b style="font-size:13px">候选进度</b>';
      const liveRows = document.createElement('div');
      liveRows.className = 'muted-sm';
      liveBody.appendChild(liveRows);
      liveList.appendChild(liveBody);

      try {
        const docsMap = new Map([[doc.id, doc]]);
        const res = await run('compress.run', {
          docId: doc.id,
          modes,
          targetBytes,
          minSsim: ssimCheck.checked ? 0.9 : 0,
        }, {
          onProgress(p) {
            if (p.total) pc.set((p.done / p.total) * 100, p.stage);
            else pc.indeterminate(p.stage);
            if (p.rows) {
              if (!liveList.isConnected) liveBox.appendChild(liveList);
              liveRows.textContent = '';
              for (const r of p.rows) {
                const line = document.createElement('div');
                line.textContent = r.status === 'done'
                  ? `✓ ${MODE_LABELS[r.mode] || r.mode} · ${r.label} → ${fmtBytes(r.size)}${r.ssim != null ? ` · SSIM ${r.ssim.toFixed(4)}` : ''}`
                  : r.status === 'failed'
                    ? `✗ ${MODE_LABELS[r.mode] || r.mode} · ${r.label} → ${r.error || '失败'}`
                    : `… ${MODE_LABELS[r.mode] || r.mode} · ${r.label}`;
                liveRows.appendChild(line);
              }
            }
          },
          onSpawn(id) { opId = id; },
        }, docsMap);
        pc.done();
        renderResult(res, doc, Date.now() - t0, targetBytes, modes);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
        cancelBtn.style.display = 'none';
        opId = null;
      }
    }

    function artifactOf(res, rowId) {
      return res.artifacts.find((a) => a.id === rowId) || null;
    }

    function renderResult(res, doc, ms, targetBytes, modes) {
      const src = res.srcSize;
      const best = res.rows.find((r) => r.id === res.bestId);
      const bestArt = best && artifactOf(res, best.id);

      // ── 推荐方案卡 ──
      const card = document.createElement('div');
      card.className = 'card';
      const cb = document.createElement('div');
      cb.className = 'card-body';
      const head = document.createElement('div');
      head.className = 'kv';
      if (best && bestArt) {
        const reached = targetBytes == null || best.size <= targetBytes;
        head.innerHTML = `${iconSvg('winner')} 推荐方案：<b>${MODE_LABELS[best.mode] || best.mode} · ${esc(best.label)}</b>
          <br>体积 ${fmtBytes(best.size)}（原 ${fmtBytes(src)}，压缩为原 ${best.ratio}%） · 用时 ${Math.round(ms / 100) / 10}s
          ${best.ssim != null ? ` · SSIM ${best.ssim.toFixed(4)}` : ''}
          ${reached ? ' <span class="badge">达标</span>' : ' <span class="badge badge-warn">未达目标体积</span>'}`;
      } else {
        head.textContent = '未能生成任何有效候选，请调整参数后重试。';
      }
      cb.appendChild(head);

      // 压缩前后体积对比条
      if (best) {
        const bars = document.createElement('div');
        bars.style.marginTop = '10px';
        const mk = (label, bytes, color) => {
          const wrap = document.createElement('div');
          wrap.style.marginBottom = '4px';
          const l = document.createElement('div');
          l.className = 'muted-sm';
          l.textContent = `${label}：${fmtBytes(bytes)}`;
          const track = document.createElement('div');
          track.className = 'progress-bar';
          const fill = document.createElement('div');
          fill.style.width = `${Math.max(2, Math.min(100, (bytes / Math.max(src, best.size)) * 100))}%`;
          fill.style.background = color;
          track.appendChild(fill);
          wrap.append(l, track);
          return wrap;
        };
        bars.appendChild(mk('原文件', src, 'var(--border)'));
        bars.appendChild(mk('压缩后', best.size, 'var(--primary)'));
        cb.appendChild(bars);
      }

      if (bestArt) {
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
        actions.appendChild(button('下载推荐结果', 'btn-primary', () => downloadArtifact(bestArt)));
        if (res.artifacts.length > 1) {
          actions.appendChild(button('打包下载全部候选 ZIP', 'btn-outline', () => downloadZip(res.artifacts, '压缩候选.zip')));
        }
        recordTaskOrButton({
          tool: 'compress', toolName: 'PDF 压缩',
          docNames: [doc.name],
          options: { targetBytes, ssim: ssimCheck.checked, modes: Object.entries(modes).filter(([, v]) => v).map(([k]) => MODE_LABELS[k]) },
          docs: [doc],
          outputs: res.artifacts.slice(0, 3).map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.byteLength, blob: new Blob([a.bytes], { type: a.mime }) })),
          form: capturePageForm(),
        }).then((recBtn) => {
          if (recBtn) actions.appendChild(recBtn);
          else cb.appendChild(recordNote());
        });
        cb.appendChild(actions);
      }

      // 无达标提示
      if (targetBytes != null && best && best.size > targetBytes) {
        const tip = document.createElement('div');
        tip.className = 'alert alert-warn';
        tip.style.marginTop = '10px';
        tip.textContent = '未找到完全达标的方案，已推荐质量最高的候选；可尝试提高目标体积或开启栅格化模式。';
        cb.appendChild(tip);
      }
      const w = warningsBox(res.warnings);
      if (w) { w.style.marginTop = '10px'; cb.appendChild(w); }
      card.appendChild(cb);
      resultBox.appendChild(card);

      // ── 候选明细表 ──
      const okRows = res.rows.filter((r) => r.ok);
      if (okRows.length) {
        const tbl = document.createElement('div');
        tbl.className = 'card';
        tbl.style.marginTop = '14px';
        const tb = document.createElement('div');
        tb.className = 'card-body';
        const th = document.createElement('b');
        th.style.fontSize = '13.5px';
        th.textContent = `全部候选（${okRows.length}/${res.rows.length} 成功）`;
        tb.appendChild(th);
        for (const r of [...okRows].sort((a, b) => a.size - b.size)) {
          const line = document.createElement('div');
          line.className = 'result-artifact';
          const info = document.createElement('div');
          info.className = 'kv';
          const isBest = r.id === res.bestId;
          info.innerHTML = `${isBest ? iconSvg('winner') : '·'} ${MODE_LABELS[r.mode] || r.mode} · ${esc(r.label)}
            → <b>${fmtBytes(r.size)}</b>（${r.ratio}%）${r.ssim != null ? ` · SSIM ${r.ssim.toFixed(4)}` : ''} · ${r.elapsed}s
            ${targetBytes != null && r.size <= targetBytes ? ' <span class="badge">达标</span>' : ''}`;
          const art = artifactOf(res, r.id);
          const right = document.createElement('div');
          if (art) right.appendChild(button('下载此版本', 'btn-outline btn-sm', () => downloadArtifact(art)));
          line.append(info, right);
          tb.appendChild(line);
        }
        // 失败候选
        const failed = res.rows.filter((r) => !r.ok);
        if (failed.length) {
          const fw = document.createElement('div');
          fw.className = 'muted-sm';
          fw.style.marginTop = '8px';
          fw.textContent = `失败 ${failed.length} 项：${failed.map((r) => `${r.label}（${r.error}）`).join('；')}`;
          tb.appendChild(fw);
        }
        tbl.appendChild(tb);
        resultBox.appendChild(tbl);
      }
    }
  },
});
