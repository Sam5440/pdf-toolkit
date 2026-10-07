// 拆分 PDF（subagent A）：每页一档 / 每N页一档 / 自定义范围组，实时预览分组
import { iconNode } from '../components/icons.js';
import { registerTool } from './core.js';
import { run, ensureDoc } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import {
  progressCard, warningsBox, toast, field, numberInput, textInput, button,
} from '../components/ui.js';
import { parsePageRange, splitGroups } from '../core/pagerange.js';
import { fmtBytes, baseName } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact, downloadZip } from '../core/download.js';

/** 组页码（0基数组）→ 展示文案 */
function fmtGroupPages(pages) {
  if (!pages.length) return '空';
  if (pages.length === 1) return `第${pages[0] + 1}页`;
  // 连续递增 → 区间；否则逐个列出
  let contiguous = true;
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] !== pages[i - 1] + 1) { contiguous = false; break; }
  }
  if (contiguous) return `第${pages[0] + 1}-${pages[pages.length - 1] + 1}页`;
  return `第${pages.map((p) => p + 1).join('、')}页`;
}

registerTool({
  id: 'split',
  name: '拆分 PDF',
  group: 'pages',
  desc: '按每页/每N页/自定义范围拆分为多个文件',
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
        baseInp.value = baseName(state.doc.name);
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch (e) {
          toast(e.message, 'error');
        }
        updatePreview();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        updatePreview();
      },
    });

    // ---- 参数 ----
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const mkRadio = (value, label) => {
      const l = document.createElement('label');
      l.className = 'checkbox-row';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'split-mode';
      r.value = value;
      r.setAttribute('data-mode', value);
      const s = document.createElement('span');
      s.textContent = label;
      l.append(r, s);
      r.addEventListener('change', updatePreview);
      return l;
    };

    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px';
    modeRow.append(
      mkRadio('each', '每页一档'),
      mkRadio('every', '每N页一档'),
      mkRadio('ranges', '自定义范围组'),
    );

    const nInp = numberInput(2, { min: 1, max: 5000, step: 1 });
    nInp.setAttribute('data-split', 'n');
    const nField = field('每份页数 N', nInp, '按顺序每 N 页拆为 1 个文件');

    const rangesInp = document.createElement('textarea');
    rangesInp.rows = 4;
    rangesInp.placeholder = '每行一组，例如：\n1-3\n4,6\n7-8';
    rangesInp.setAttribute('data-split', 'ranges');
    const rangesField = field('范围组（每行一组）', rangesInp, '支持 1-3、5、8-n；行数即输出文件数');

    const baseInp = textInput('', '输出文件名前缀，默认为原文件名');
    const baseField = field('输出文件名前缀', baseInp, `产物命名：前缀_第X-Y页.pdf`);

    const previewChips = document.createElement('div');
    previewChips.className = 'range-chips';
    const previewCount = document.createElement('div');
    previewCount.className = 'note';
    const errBox = document.createElement('div');
    errBox.className = 'alert alert-error';
    errBox.style.marginTop = '10px';
    errBox.style.display = 'none';

    body.append(modeRow, nField, rangesField, baseField, previewChips, previewCount, errBox);
    controls.appendChild(body);

    const goBtn = button('开始拆分', 'btn-primary', () => doSplit());
    goBtn.setAttribute('data-split', 'go');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(panel.el, controls, goBtn, resultBox);

    nInp.addEventListener('input', updatePreview);
    rangesInp.addEventListener('input', updatePreview);

    /** 当前模式 */
    function curMode() {
      const r = modeRow.querySelector('input[type=radio]:checked');
      return r ? r.value : 'each';
    }

    /** 解析当前参数 → {ok:true, groups}|{ok:false, error} */
    function computeGroups() {
      if (!state.doc || !state.pageCount) return { ok: false, error: '请先选择 PDF 文件' };
      const mode = curMode();
      if (mode === 'each' || mode === 'every') {
        const m = { kind: mode };
        if (mode === 'every') {
          const n = Math.floor(Number(nInp.value));
          if (!Number.isFinite(n) || n < 1) return { ok: false, error: '每份页数 N 需为正整数' };
          m.n = n;
        }
        try {
          return { ok: true, mode: m, groups: splitGroups(state.pageCount, m) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      // ranges：每行一组，逐行校验
      const lines = rangesInp.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return { ok: false, error: '请输入至少一组页码范围' };
      const groups = [];
      for (const line of lines) {
        const r = parsePageRange(line, state.pageCount);
        if (!r.ok) return { ok: false, error: `「${line}」：${r.error}` };
        groups.push(r.pages);
      }
      return { ok: true, mode: { kind: 'ranges', groups: lines }, groups };
    }

    function updatePreview() {
      errBox.style.display = 'none';
      previewChips.textContent = '';
      previewCount.textContent = '';
      const isEvery = curMode() === 'every';
      nField.style.display = isEvery ? '' : 'none';
      rangesField.style.display = curMode() === 'ranges' ? '' : 'none';
      if (state.running) { goBtn.disabled = true; return; }
      const res = computeGroups();
      if (!res.ok) {
        errBox.textContent = res.error;
        errBox.style.display = 'block';
        goBtn.disabled = true;
        return;
      }
      res.groups.forEach((g, i) => {
        const chip = document.createElement('span');
        chip.className = 'range-chip';
        chip.textContent = `组${i + 1} · ${fmtGroupPages(g)}（${g.length}页）`;
        previewChips.appendChild(chip);
      });
      previewCount.textContent = `共 ${state.pageCount} 页 · 预计输出 ${res.groups.length} 个文件`;
      goBtn.disabled = false;
    }

    async function doSplit() {
      const res = computeGroups();
      if (!res.ok) { toast(res.error, 'error'); return; }
      const doc = state.doc;
      const docsMap = new Map([[doc.id, doc]]);
      const base = baseInp.value.trim() || '拆分';
      state.running = true;
      goBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(5, '开始拆分…');
      const t0 = Date.now();
      try {
        const out = await run('pages.split', { docId: doc.id, mode: res.mode, baseName: base }, {
          trayFolder: `拆分 · ${base}`,
          onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 0, p.stage || '拆分中…'),
        }, docsMap);
        pc.done();
        renderResult(out, base, doc, Date.now() - t0);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        state.running = false;
        updatePreview();
      }
    }

    function renderResult(res, base, doc, ms) {
      const arts = res.artifacts || [];
      const card = document.createElement('div');
      card.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';

      const kv = document.createElement('div');
      kv.className = 'kv';
      const b = document.createElement('b');
      b.appendChild(iconNode('success'));
      b.appendChild(document.createTextNode(` 拆分完成：${arts.length} 个文件 · 共 ${res.summary?.pages ?? state.pageCount} 页 · 用时 ${Math.round(ms / 100) / 10}s`));
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
        meta.textContent = `组${i + 1} · ${fmtBytes(art.bytes.byteLength)}`;
        info.append(nm, meta);
        const dl = button('下载', 'btn-outline btn-sm', () => downloadArtifact(art));
        rowEl.append(ico, info, dl);
        list.appendChild(rowEl);
      });
      ib.appendChild(list);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      actions.append(
        button('打包下载 ZIP', 'btn-primary', () => downloadZip(arts, '拆分结果.zip')),
        button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'split', toolName: '拆分 PDF',
            docNames: [doc.name],
            options: { mode: res.mode?.kind, n: res.mode?.n ?? null, groups: res.mode?.groups ?? null },
            outputs: arts.map((a) => ({
              name: a.name, mime: a.mime || 'application/pdf',
              size: a.bytes.byteLength, blob: new Blob([a.bytes], { type: a.mime || 'application/pdf' }),
            })),
          });
          toast('已保存到历史');
        }),
      );
      ib.appendChild(actions);
      const w = warningsBox(res.warnings);
      if (w) ib.appendChild(w);
      card.appendChild(ib);
      resultBox.appendChild(card);
    }

    updatePreview();
  },
});
