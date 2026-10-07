// PDF 转 Word（更多 · 对齐 PDF24 pdf-to-word）＋ 同族导出工具的共用工厂
// 文本级转换：提取带字号/加粗信息的行 → 生成可编辑文档；不还原像素排版。
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { buildOffice, buildPptxImages } from '../../core/officewriters.js';
import { PDFJS_ASSET_OPTS } from '../../core/pdfjs-assets.js';
import { setEngineStatus } from '../../core/wasm-registry.js';
import { log } from '../../core/logs.js';
import { buildOutputName, paramsToken } from '../../core/naming.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';
const SCAN_NOTE = '未检测到文本层（可能是扫描件或图片型 PDF），已自动转为图片型演示文稿（文字不可编辑）。如需可编辑文字，请先使用「OCR 识别」工具。';

// 引擎缺陷绕过：引擎路径失败时走本地管线兜底（失败原因进运行日志，设置面板可查）：
// 主线程 pdfjs 提取富文本行（与引擎 richLinesOf 同算法）→ core/officewriters.buildOffice 生成产物。
let pdfjsPromise = null;
function getPdfjsMain() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pjs.GlobalWorkerOptions.workerSrc = workerUrl;
      setEngineStatus('pdfjs', 'ready', `v${pjs.version || '?'} · 主线程转换`);
      return pjs;
    })();
  }
  return pdfjsPromise;
}

/** 主线程富文本行提取（与 engine-more richLinesOf 同逻辑）：[{lines:[{text,size,heading,bold}]}] */
async function richLinesLocal(file, pageIdxs, onProgress) {
  const pjs = await getPdfjsMain();
  const doc = await pjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, ...PDFJS_ASSET_OPTS }).promise;
  const raw = [];
  const allSizes = [];
  for (let i = 0; i < pageIdxs.length; i++) {
    const page = await doc.getPage(pageIdxs[i] + 1);
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str !== undefined && it.str.trim());
    const rows = new Map();
    for (const it of items) {
      const y = Math.round(it.transform[5] / 2) * 2;
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], str: it.str, size, bold: /bold/i.test(it.fontName || '') });
      allSizes.push(size);
    }
    const sorted = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    raw.push(sorted.map(([, arr]) => {
      arr.sort((a, b) => a.x - b.x);
      return {
        text: arr.map((i2) => i2.str).join('').replace(/\s+$/, ''),
        size: Math.max(...arr.map((i2) => i2.size)),
        bold: arr.some((i2) => i2.bold),
      };
    }).filter((l) => l.text));
    onProgress?.(i + 1, pageIdxs.length);
  }
  allSizes.sort((a, b) => a - b);
  const median = allSizes[Math.floor(allSizes.length / 2)] || 10;
  return raw.map((lines) => ({
    lines: lines.map((l) => {
      let heading = 0;
      const ratio = l.size / median;
      if (ratio >= 1.85) heading = 1;
      else if (ratio >= 1.45) heading = 2;
      else if (ratio >= 1.2 && l.text.length < 60) heading = 3;
      return { text: l.text, size: Math.round(l.size * 10) / 10, heading, bold: l.bold };
    }),
  }));
}

/** 主线程逐页渲染 PNG（扫描件兜底的最后一道：引擎也不可用时仍能出图片型 PPTX） */
async function renderPagesPngLocal(file, pageIdxs, dpi, onProgress) {
  const pjs = await getPdfjsMain();
  const doc = await pjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, ...PDFJS_ASSET_OPTS }).promise;
  const scale = dpi / 72;
  const arts = [];
  for (let i = 0; i < pageIdxs.length; i++) {
    const page = await doc.getPage(pageIdxs[i] + 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('页面编码失败'))), 'image/jpeg', 0.92));
    arts.push({
      name: `p${String(i + 1).padStart(3, '0')}.jpg`,
      mime: 'image/jpeg',
      bytes: new Uint8Array(await blob.arrayBuffer()),
      w: vp.width / scale, // 视觉尺寸（pt）
      h: vp.height / scale,
    });
    onProgress?.(i + 1, pageIdxs.length);
  }
  return arts;
}

const SCAN_WARN_OTHERS = '未检测到文本层（可能是扫描件或图片型 PDF），文本级导出结果为空。请先使用「OCR 识别」工具生成文字层后再转换。';

/**
 * 导出工具工厂：上传 PDF → pdf.exportOffice（引擎不可用时本地 buildOffice）→ 产物下载。
 * 扫描件（无文本层）：pptx 自动降级为图片型 PPT；其他格式给出 OCR 引导警告。
 * @param {{id:string, name:string, format:string, desc:string, formatOptions?:Array<{value,label}>}} p
 *   formatOptions 提供时展示输出格式选择（如 pdf2odf 的 odt/ods/odp）。
 */
export function officeExportTool(p) {
  registerTool({
    id: p.id,
    name: p.name,
    group: 'm-frompdf',
    desc: p.desc,
    accepts: 'pdf',
    multiple: false,
    render(container) {
      const state = { doc: null };

      const panel = inputPanel({
        multiple: false,
        accept: 'application/pdf,.pdf',
        acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
        async onAdd(added) {
          state.doc = added[added.length - 1];
          goBtn.disabled = !state.doc;
        },
        onRemove() { state.doc = null; goBtn.disabled = true; },
      });

      const { card, body } = paramsCard();
      let fmtSel = null;
      if (p.formatOptions) {
        fmtSel = select(p.formatOptions, p.formatOptions[0]?.value);
        body.appendChild(field('输出格式', fmtSel));
      }

      const goBtn = button('开始转换', 'btn-primary', () => exec());
      goBtn.style.cssText = 'width:100%;margin-top:14px';
      goBtn.disabled = true;

      const resultBox = document.createElement('div');
      container.append(panel.el, card, goBtn, resultBox);

      const exec = runWithProgress(resultBox, async (setP) => {
        const format = fmtSel ? fmtSel.value : p.format;
        let arts;
        let summary;
        let warnings = [];
        let pagesData = null;
        let engineFailed = null;
        try {
          const res = await run('pdf.exportOffice', {
            docId: state.doc.id,
            pages: 'all',
            format,
          }, {
            onProgress: (pr) => setP(pr.total ? (pr.done / pr.total) * 100 : 60, pr.stage),
          }, new Map([[state.doc.id, state.doc]]));
          arts = res.artifacts;
          summary = res.summary;
        } catch (err) {
          // 引擎路径失败不再静默：原因进运行日志，再走本地兜底管线
          engineFailed = err;
          log('office', `${p.id} 引擎导出失败，已走本地兜底管线`, { level: 'warn', detail: `${err.code || ''} ${err.message}`.trim() });
          // 本地管线：解析页数 → 富文本行 → buildOffice
          const info = await ensureDoc(state.doc);
          const pageIdxs = info.pages.map((_, i) => i);
          pagesData = await richLinesLocal(state.doc.file, pageIdxs, (done, total) => {
            setP((done / total) * 70, `解析第 ${done} 页`);
          });
          setP(85, '生成文档…');
          const built = buildOffice(format, pagesData, {
            title: state.doc.name.replace(/\.pdf$/i, ''),
          });
          arts = [{
            name: `${buildOutputName({ name: state.doc.name, op: 'PDF转Word', params: paramsToken({ format }) })}.${built.ext}`,
            mime: built.mime,
            bytes: built.bytes,
          }];
          summary = { format, pages: pageIdxs.length };
        }
        // 空文本检测（扫描件）：引擎路径看 summary.lines，本地路径直接数行
        const linesTotal = pagesData
          ? pagesData.reduce((s, pg) => s + pg.lines.length, 0)
          : (summary.lines ?? null);
        if (linesTotal === 0) {
          if (format === 'pptx' || format === 'odp') {
            log('office', `${p.id} 未检测到文本层，自动转图片型 ${format.toUpperCase()}`, { level: 'warn' });
            setP(70, `未检测到文本层（扫描件？），转图片型 ${format.toUpperCase()}…`);
            warnings = [SCAN_NOTE];
            let imgs = null;
            try {
              const res = await run('pdf.toImages', {
                docId: state.doc.id, pages: 'all', dpi: 150, format: 'jpeg', quality: 0.92, bg: '#ffffff',
              }, {
                onProgress: (pr) => setP(pr.total ? 70 + (pr.done / pr.total) * 20 : 80, pr.stage),
              }, new Map([[state.doc.id, state.doc]]));
              const info = await ensureDoc(state.doc);
              imgs = res.artifacts.map((a, i) => ({
                bytes: a.bytes, mime: a.mime,
                w: info.pages[i]?.visualW, h: info.pages[i]?.visualH,
              }));
            } catch (err2) {
              log('office', `${p.id} 引擎渲染不可用，转主线程渲染`, { level: 'warn', detail: String(err2?.message || err2) });
              const info = await ensureDoc(state.doc);
              const pageIdxs = info.pages.map((_, i) => i);
              imgs = await renderPagesPngLocal(state.doc.file, pageIdxs, 150, (done, total) => {
                setP(70 + (done / total) * 20, `渲染第 ${done} 页`);
              });
            }
            setP(95, `生成 ${format.toUpperCase()}…`);
            if (format === 'pptx') {
              const built = buildPptxImages(imgs, { fit: 'contain' });
              arts = [{
                name: `${buildOutputName({ name: state.doc.name, op: 'PDF转PPT', params: paramsToken({ format }) })}.pptx`,
                mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                bytes: built,
              }];
              summary = { format, pages: imgs.length };
            } else {
              // odp：无图片型写入器，维持文本级产物并给出引导
              warnings = [SCAN_WARN_OTHERS];
            }
          } else {
            warnings = [SCAN_WARN_OTHERS];
          }
        }
        const card2 = resultCard({
          arts,
          summary: { 格式: summary.format.toUpperCase(), 页数: summary.pages },
          toolId: p.id, toolName: p.name,
          docNames: [state.doc.name],
          options: { format },
          extraNote: NOTE,
          warnings,
        });
        resultBox.appendChild(card2);
        return { artifacts: arts, summary };
      });
    },
  });
}

officeExportTool({
  id: 'pdf2word',
  name: 'PDF 转 Word',
  format: 'docx',
  desc: `生成 DOCX（保留段落与标题层级）。${NOTE}`,
});
