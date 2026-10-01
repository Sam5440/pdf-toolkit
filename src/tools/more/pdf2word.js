// PDF 转 Word（更多 · 对齐 PDF24 pdf-to-word）＋ 同族导出工具的共用工厂
// 文本级转换：提取带字号/加粗信息的行 → 生成可编辑文档；不还原像素排版。
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, select, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { buildOffice } from '../../core/officewriters.js';

const NOTE = '文本级转换：保留文字与段落结构，不还原排版';

// 引擎缺陷绕过：engine-more.js 的 pdf.exportOffice → richLinesOf 引用了未导入的
// pdfjsOpen（ReferenceError）。引擎修复前走本地管线：主线程 pdfjs 提取富文本行
// （与引擎 richLinesOf 同算法）→ core/officewriters.buildOffice 生成产物。
let pdfjsPromise = null;
function getPdfjsMain() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pjs;
    })();
  }
  return pdfjsPromise;
}

/** 主线程富文本行提取（与 engine-more richLinesOf 同逻辑）：[{lines:[{text,size,heading,bold}]}] */
async function richLinesLocal(file, pageIdxs, onProgress) {
  const pjs = await getPdfjsMain();
  const doc = await pjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
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

/**
 * 导出工具工厂：上传 PDF → pdf.exportOffice（引擎不可用时本地 buildOffice）→ 产物下载。
 * @param {{id:string, name:string, format:string, desc:string, formatOptions?:Array<{value,label}>}} p
 *   formatOptions 提供时展示输出格式选择（如 pdf2odf 的 odt/ods/odp）。
 */
export function officeExportTool(p) {
  registerTool({
    id: p.id,
    name: p.name,
    group: 'more',
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
        } catch {
          // 本地管线（见文件头说明）：解析页数 → 富文本行 → buildOffice
          const info = await ensureDoc(state.doc);
          const pageIdxs = info.pages.map((_, i) => i);
          const pagesData = await richLinesLocal(state.doc.file, pageIdxs, (done, total) => {
            setP((done / total) * 70, `解析第 ${done} 页`);
          });
          setP(85, '生成文档…');
          const built = buildOffice(format, pagesData, {
            title: state.doc.name.replace(/\.pdf$/i, ''),
          });
          arts = [{
            name: `${state.doc.name.replace(/\.pdf$/i, '')}.${built.ext}`,
            mime: built.mime,
            bytes: built.bytes,
          }];
          summary = { format, pages: pageIdxs.length };
        }
        const card2 = resultCard({
          arts,
          summary: { 格式: summary.format.toUpperCase(), 页数: summary.pages },
          toolId: p.id, toolName: p.name,
          docNames: [state.doc.name],
          options: { format },
          extraNote: NOTE,
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
