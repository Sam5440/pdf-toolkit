// PDF 转图片 — 单 PDF，页范围实时解析预览，PNG/JPEG + DPI + JPEG 质量
import { iconNode } from '../components/icons.js';
import { registerTool } from './core.js';
import { run, ensureDoc } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import {
  progressCard, warningsBox, toast, field, select, numberInput, textInput, row, button,
} from '../components/ui.js';
import { fmtBytes } from '../core/format.js';
import { parsePageRange } from '../core/pagerange.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { downloadArtifact, downloadZip } from '../core/download.js';

registerTool({
  id: 'pdf2images',
  name: 'PDF 转图片',
  group: 'convert',
  desc: '按范围导出 PNG/JPEG，可调 DPI 与质量',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择单个 PDF，每页导出为一张图片',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.pageCount = info.pageCount;
        } catch (e) {
          toast(e.message, 'error');
        }
        renderPreview();
      },
    });

    // ---- 参数 ----
    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const pagesInp = textInput('', '如 1-3,5（留空=全部页）');
    const previewChips = document.createElement('div');
    previewChips.className = 'range-chips';
    const pagesField = field('页范围', pagesInp, '留空 = 全部页；支持 1-3,5、odd、even');
    pagesField.appendChild(previewChips);

    const fmtSel = select([
      { value: 'png', label: 'PNG（无损）' },
      { value: 'jpeg', label: 'JPEG（体积小）' },
    ], 'png');
    const dpiInp = numberInput(150, { min: 72, max: 300, step: 1 });
    const qInp = numberInput(0.92, { min: 0.05, max: 1, step: 0.05 });

    body.append(
      pagesField,
      row(field('格式', fmtSel), field('DPI（72-300）', dpiInp)),
      field('JPEG 质量（0.05-1，仅 JPEG 生效）', qInp),
    );
    controls.appendChild(body);

    pagesInp.addEventListener('input', renderPreview);

    function renderPreview() {
      previewChips.innerHTML = '';
      if (!state.doc) {
        const s = document.createElement('span');
        s.className = 'hint';
        s.textContent = '选择 PDF 后可预览页范围解析结果';
        previewChips.appendChild(s);
        return;
      }
      if (!state.pageCount) {
        const s = document.createElement('span');
        s.className = 'hint';
        s.textContent = '正在读取页数…';
        previewChips.appendChild(s);
        return;
      }
      const v = pagesInp.value.trim();
      if (!v) {
        const chip = document.createElement('span');
        chip.className = 'range-chip';
        chip.textContent = `全部 ${state.pageCount} 页`;
        previewChips.appendChild(chip);
        return;
      }
      const r = parsePageRange(v, state.pageCount);
      if (!r.ok) {
        const err = document.createElement('span');
        err.className = 'range-chip';
        err.style.cssText = 'background:var(--no-soft);color:var(--no)';
        err.textContent = r.error;
        previewChips.appendChild(err);
        return;
      }
      const sum = document.createElement('span');
      sum.className = 'range-chip';
      sum.textContent = `共 ${r.pages.length} 页`;
      previewChips.appendChild(sum);
      const MAX = 10;
      for (const p of r.pages.slice(0, MAX)) {
        const chip = document.createElement('span');
        chip.className = 'range-chip';
        chip.textContent = `第${p + 1}页`;
        previewChips.appendChild(chip);
      }
      if (r.pages.length > MAX) {
        const more = document.createElement('span');
        more.className = 'range-chip';
        more.textContent = `+${r.pages.length - MAX} 页`;
        previewChips.appendChild(more);
      }
    }
    renderPreview();

    // ---- 执行 ----
    const goBtn = button('开始转换', 'btn-primary', () => doConvert());
    goBtn.style.cssText = 'width:100%;margin-top:14px';

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(panel.el, controls, goBtn, resultBox);

    async function doConvert() {
      resultBox.innerHTML = '';
      const doc = state.doc;
      if (!doc) { toast('请先选择 PDF 文件', 'error'); return; }
      const dpi = Math.round(Number(dpiInp.value) || 0);
      if (dpi < 72 || dpi > 300) { toast('DPI 需在 72-300 之间', 'error'); return; }
      let quality = Number(qInp.value);
      if (!Number.isFinite(quality)) quality = 0.92;
      quality = Math.min(1, Math.max(0.05, quality));
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      const t0 = Date.now();
      try {
        const res = await run('pdf.toImages', {
          docId: doc.id,
          pages: pagesInp.value.trim() || 'all',
          dpi,
          format: fmtSel.value,
          quality,
          bg: '#ffffff',
        }, {
          trayFolder: `PDF 转图片 · ${doc.name.replace(/\.pdf$/i, '')}`,
          onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 0, p.stage || '渲染中…'),
        }, new Map([[doc.id, doc]]));
        pc.done();
        renderResult(res, doc, dpi, Date.now() - t0);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = false;
      }
    }

    function renderResult(res, doc, dpi, ms) {
      const arts = res.artifacts || [];
      const card = document.createElement('div');
      card.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.appendChild(iconNode('success'));
      kv.appendChild(document.createTextNode(` 转换完成：${arts.length} 张图片 · ${dpi} DPI · ${res.summary?.format === 'jpeg' ? 'JPEG' : 'PNG'} · 用时 ${Math.round(ms / 100) / 10}s`));
      ib.appendChild(kv);
      const w = warningsBox(res.warnings);
      if (w) ib.appendChild(w);

      for (const art of arts) {
        const line = document.createElement('div');
        line.className = 'result-artifact';
        const ico = document.createElement('span');
        ico.className = 'ra-ico';
        ico.replaceChildren(iconNode('image'));
        const info = document.createElement('div');
        info.className = 'ra-info';
        const nm = document.createElement('div');
        nm.className = 'ra-name';
        nm.textContent = art.name;
        const mt = document.createElement('div');
        mt.className = 'ra-meta';
        mt.textContent = fmtBytes(art.bytes.byteLength);
        info.append(nm, mt);
        line.append(ico, info);
        line.appendChild(button('下载', 'btn-outline btn-sm', () => downloadArtifact(art)));
        ib.appendChild(line);
      }

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      actions.append(
        button('ZIP 打包下载', 'btn-primary', () => downloadZip(arts, 'pdf2images.zip')),
        button('全部下载', 'btn-outline', async () => {
          for (const art of arts) {
            downloadArtifact(art);
            await new Promise((r2) => setTimeout(r2, 300));
          }
        }),
      );
      ib.appendChild(actions);
      recordTaskOrButton({
        tool: 'pdf2images', toolName: 'PDF 转图片',
        docNames: [doc.name],
        options: { pages: pagesInp.value.trim() || 'all', dpi, format: fmtSel.value },
        docs: [doc],
        outputs: arts.map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.byteLength, blob: new Blob([a.bytes], { type: a.mime }) })),
        form: capturePageForm(),
      }).then((recBtn) => {
        if (recBtn) actions.appendChild(recBtn);
        else ib.appendChild(recordNote());
      });
      card.appendChild(ib);
      resultBox.appendChild(card);
    }
  },
});
