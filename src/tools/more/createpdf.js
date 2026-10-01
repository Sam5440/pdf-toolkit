// 生成 PDF（更多 · 对齐 PDF24 create-pdf）：Markdown 子集撰写 → 引擎 text.toPdf 分页渲染
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { field, select, textInput, button, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';
import { parseMarkdown } from '../../core/importers.js';

const PAPER_OPTS = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'a5', label: 'A5' },
  { value: 'a3', label: 'A3' },
  { value: 'legal', label: 'Legal' },
];
const FONT_OPTS = [
  { value: '10', label: '10pt（紧凑）' },
  { value: '11', label: '11pt（标准）' },
  { value: '12', label: '12pt（大）' },
  { value: '14', label: '14pt（更大）' },
];
const SYNTAX_NOTE = '支持语法：# 标题（最多三级）、- 列表、**粗体**、| 表格 |、``` 代码块、> 引用、--- 分隔线、空行分段。';

registerTool({
  id: 'createpdf',
  name: '生成 PDF',
  group: 'more',
  desc: '富文本撰写并导出 PDF（标题/列表/表格）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const { card: writeCard, body: writeBody } = paramsCard();

    const titleInp = textInput('', '文档标题（同时用作文件名，可留空）');
    titleInp.setAttribute('data-cp-title', '');
    writeBody.appendChild(field('标题', titleInp));

    const ta = document.createElement('textarea');
    ta.setAttribute('data-cp-text', '');
    ta.rows = 16;
    ta.placeholder = '# 一级标题\n\n正文段落，支持 **粗体**。\n\n- 列表项一\n- 列表项二\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用一行\n\n---';
    ta.style.cssText = 'width:100%;min-height:300px;resize:vertical;padding:10px 12px;border:1px solid var(--border);'
      + 'border-radius:8px;background:var(--bg-soft);color:var(--text);font:13px/1.65 ui-monospace,Menlo,Consolas,monospace';
    writeBody.appendChild(field('正文（Markdown 子集）', ta, SYNTAX_NOTE));

    const { card, body } = paramsCard();
    const paperSel = select(PAPER_OPTS, 'a4');
    body.appendChild(field('纸张', paperSel));
    const sizeSel = select(FONT_OPTS, '11');
    body.appendChild(field('正文字号', sizeSel));

    const goBtn = button('生成 PDF', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;
    ta.addEventListener('input', () => { goBtn.disabled = !ta.value.trim(); });

    const resultBox = document.createElement('div');
    container.append(writeCard, card, goBtn, resultBox);

    const exec = runWithProgress(resultBox, async (setP) => {
      const text = ta.value;
      if (!text.trim()) throw new Error('请先输入正文内容');
      setP(15, '解析 Markdown…');
      const { blocks } = parseMarkdown(text);
      if (!blocks.length) throw new Error('没有可排版的内容');
      const title = titleInp.value.trim() || '未命名文档';
      const res = await run('text.toPdf', {
        name: title,
        blocks,
        paper: paperSel.value,
        margin: 48,
        fontSize: Number(sizeSel.value) || 11,
        title,
      }, {
        onProgress: (p) => setP(p.total ? 20 + (p.done / p.total) * 80 : 50, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'createpdf', toolName: '生成 PDF',
        docNames: [],
        options: { paper: paperSel.value, fontSize: Number(sizeSel.value) },
      }));
      toast('PDF 已生成');
      return res;
    });
  },
});
