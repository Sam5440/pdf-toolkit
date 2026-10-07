// PDF 转图片型 PPT（更多 · 默认收藏）：每页渲染为整幅图片、铺满一帧幻灯片。
// 与文本级 pdf2ppt 互补——观感与原 PDF 完全一致，代价是文字不可编辑/不可选中。
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  toast, field, select, numberInput, textInput, row, button,
} from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parsePageRange } from '../../core/pagerange.js';
import { buildPptxImages } from '../../core/officewriters.js';
import { buildOutputName, paramsToken } from '../../core/naming.js';

const NOTE = '图片型：每页整幅渲染为图片并铺满幻灯片，观感 1:1 还原，但文字不可编辑/选中';

const SLIDE_RATIOS = {
  '16:9': { wPt: 960, hPt: 540, label: '16:9 宽屏' },
  '4:3': { wPt: 720, hPt: 540, label: '4:3 标准' },
};
const FIT_LABELS = { contain: '等比适应', cover: '铺满裁切', stretch: '拉伸填满' };

registerTool({
  id: 'pdf2pptimg',
  name: 'PDF 转图片型 PPT',
  group: 'm-frompdf',
  defaultFav: true, // 默认收藏：出现在首页「PDF 转格式」分区
  desc: '每页渲染为图片、整幅铺满一帧幻灯片，观感与原 PDF 一致',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0, pages: [] };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        state.pages = [];
        goBtn.disabled = true;
        try {
          const info = await ensureDoc(state.doc);
          state.pageCount = info.pageCount;
          state.pages = info.pages || [];
          goBtn.disabled = false;
        } catch (e) {
          toast(e.message, 'error');
        }
        renderPreview();
      },
      onRemove() {
        state.doc = null;
        state.pageCount = 0;
        state.pages = [];
        goBtn.disabled = true;
        renderPreview();
      },
    });

    // ---- 参数 ----
    const { card, body } = paramsCard();

    const pagesInp = textInput('', '如 1-3,5（留空=全部页）');
    const previewChips = document.createElement('div');
    previewChips.className = 'range-chips';
    const pagesField = field('页范围', pagesInp, '留空 = 全部页；支持 1-3,5、odd、even');
    pagesField.appendChild(previewChips);

    const slideSel = select([
      { value: 'auto', label: '跟随 PDF 首页（整页铺满，推荐）' },
      { value: '16:9', label: '16:9 宽屏' },
      { value: '4:3', label: '4:3 标准' },
    ], 'auto');
    const fitSel = select([
      { value: 'contain', label: '等比适应（留白居中，不变形）' },
      { value: 'cover', label: '铺满裁切（超出部分裁掉）' },
      { value: 'stretch', label: '拉伸填满（可能变形）' },
    ], 'contain');
    const fitField = field('填充方式（比例不一致时生效）', fitSel,
      '跟随页面比例且各页等大时，等比适应即为整页铺满');
    const fmtSel = select([
      { value: 'png', label: 'PNG（无损，文字锐利）' },
      { value: 'jpeg', label: 'JPEG（体积小）' },
    ], 'png');
    const dpiInp = numberInput(150, { min: 72, max: 300, step: 1 });
    const qInp = numberInput(0.92, { min: 0.05, max: 1, step: 0.05 });

    body.append(
      pagesField,
      row(field('幻灯片比例', slideSel), fitField),
      row(field('图片格式', fmtSel), field('DPI（72-300）', dpiInp)),
      field('JPEG 质量（0.05-1，仅 JPEG 生效）', qInp),
    );

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
      sum.textContent = `共 ${r.pages.length} 页（每页一帧幻灯片）`;
      previewChips.appendChild(sum);
    }
    renderPreview();

    // ---- 执行 ----
    const goBtn = button('开始转换', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const doc = state.doc;
      if (!doc) { toast('请先选择 PDF 文件', 'error'); return null; }
      const dpi = Math.round(Number(dpiInp.value) || 0);
      if (dpi < 72 || dpi > 300) { toast('DPI 需在 72-300 之间', 'error'); return null; }
      let quality = Number(qInp.value);
      if (!Number.isFinite(quality)) quality = 0.92;
      quality = Math.min(1, Math.max(0.05, quality));
      const pagesArg = pagesInp.value.trim() || 'all';
      const range = parsePageRange(pagesArg, state.pageCount);
      if (!range.ok) { toast(range.error, 'error'); return null; }
      const format = fmtSel.value;
      const slide = slideSel.value;
      const fit = fitSel.value;

      // 1) 引擎逐页渲染位图（worker，含进度）
      const res = await run('pdf.toImages', {
        docId: doc.id, pages: pagesArg, dpi, format, quality, bg: '#ffffff',
      }, {
        onProgress: (pr) => setP(pr.total ? (pr.done / pr.total) * 85 : 40, pr.stage || '渲染中…'),
      }, new Map([[doc.id, doc]]));

      // 2) 组装 PPTX：每页一帧整页图
      setP(90, '生成 PPTX…');
      const ratio = SLIDE_RATIOS[slide];
      const built = buildPptxImages(
        res.artifacts.map((a, i) => {
          const pm = state.pages[range.pages[i]] || {};
          return { bytes: a.bytes, mime: a.mime, w: pm.visualW, h: pm.visualH };
        }),
        ratio ? { slideWPt: ratio.wPt, slideHPt: ratio.hPt, fit } : { fit },
      );
      const art = {
        name: `${buildOutputName({ name: doc.name, op: '转图片型PPT', params: paramsToken({ slide, fit, dpi }) })}.pptx`,
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: built,
      };
      const ratioLabel = ratio ? ratio.label : '跟随 PDF 首页';
      resultBox.appendChild(resultCard({
        arts: [art],
        summary: { 幻灯片: `${res.artifacts.length} 页`, 比例: ratioLabel, 填充: FIT_LABELS[fit], 格式: format.toUpperCase(), DPI: dpi },
        toolId: 'pdf2pptimg', toolName: 'PDF 转图片型 PPT',
        docNames: [doc.name],
        options: { pages: pagesArg, dpi, format, slide, fit },
        extraNote: NOTE,
      }));
      return { artifacts: [art], summary: { slides: res.artifacts.length, ratio: ratioLabel, fit } };
    });
  },
});
