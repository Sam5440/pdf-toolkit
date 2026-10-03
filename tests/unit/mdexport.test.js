// mdhtml（HTML 即时预览）与 mddocx（Word 轻量引擎）单元测试（node 环境可跑部分）
import { describe, it, expect } from 'vitest';
import { mdToHtmlSync } from '../../src/core/mdhtml.js';
import { markdownToDocx } from '../../src/core/mddocx.js';
import { highlightTokens, highlightHtml, normalizeLang, tokenLines } from '../../src/core/mdhl.js';
import { parseMarkdownRich } from '../../src/core/mdrender.js';
import { zipSync, strToU8, unzipSync } from 'fflate';

describe('mdhtml: mdToHtmlSync', () => {
  it('渲染 GFM 表格与对齐', () => {
    const html = mdToHtmlSync('| A | B |\n|:--|--:|\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('align="right"');
  });

  it('渲染任务列表 checkbox', () => {
    const html = mdToHtmlSync('- [ ] 待办\n- [x] 完成\n');
    expect((html.match(/type="checkbox"/g) || []).length).toBe(2);
    expect(html).toContain('checked');
  });

  it('渲染行内与独立 KaTeX 公式', () => {
    const html = mdToHtmlSync('含 $E=mc^2$ 公式\n\n$$\\int_0^1 x dx$$\n');
    expect(html).toContain('katex');
  });

  it('渲染脚注与回链', () => {
    const html = mdToHtmlSync('正文[^1]\n\n[^1]: 注释内容\n');
    expect(html).toContain('data-footnote-ref');
    expect(html).toContain('data-footnote-backref');
    expect(html).toContain('footnotes');
  });

  it('mermaid 代码块输出占位（decorate 阶段渲染）', () => {
    const html = mdToHtmlSync('```mermaid\ngraph LR; A-->B;\n```\n');
    expect(html).toContain('data-kind="mermaid"');
  });

  it('代码块带语言角标与语法高亮 span', () => {
    const html = mdToHtmlSync('```python\ndef f(): pass\n```\n');
    expect(html).toContain('mdx-code-lang');
    expect(html).toContain('<span class="hljs-keyword">def</span>');
    expect(html).toContain('<span class="hljs-title function_">f</span>');
  });

  it('外链带 target=_blank', () => {
    const html = mdToHtmlSync('[链接](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('mddocx: markdownToDocx', () => {
  const MD = [
    '# 主标题',
    '',
    '正文段落，含 **粗体** 与 `行内代码`。',
    '',
    '- 无序一',
    '- 无序二',
    '1. 有序一',
    '2. 有序二',
    '',
    '> 引用内容',
    '',
    '| 表头A | 表头B |',
    '|:---|---:|',
    '| 左 | 右 |',
    '',
    '```python',
    'def hello():',
    '    pass',
    '```',
    '',
    '---',
  ].join('\n');

  async function unpack(bytes) {
    // fflate unzipSync 需要 Uint8Array
    const files = unzipSync(new Uint8Array(bytes));
    const text = (n) => new TextDecoder().decode(files[n]);
    return { files, text };
  }

  it('产出合法 docx 包（content types / rels / document / styles）', async () => {
    const { bytes } = await markdownToDocx(MD, { fontSize: 11 });
    const { files, text } = await unpack(bytes);
    expect(files['[Content_Types].xml']).toBeTruthy();
    expect(files['_rels/.rels']).toBeTruthy();
    expect(files['word/document.xml']).toBeTruthy();
    expect(files['word/styles.xml']).toBeTruthy();
    expect(files['word/_rels/document.xml.rels']).toBeTruthy();
    expect(text('word/document.xml')).toContain('<w:body>');
  });

  it('标题/粗体/代码/引用/表格/分隔线全部入文', async () => {
    const { bytes } = await markdownToDocx(MD, { fontSize: 11 });
    const { text } = await unpack(bytes);
    const doc = text('word/document.xml');
    expect(doc).toContain('主标题');
    expect(doc).toContain('粗体');
    expect(doc).toContain('<w:b/>');
    expect(doc).toContain('F3F4F6'); // 代码底色
    expect(doc).toContain('CBD5E1'); // 引用左竖条
    expect(doc).toContain('F0F0F0'); // 表头底色
    expect(doc).toContain('<w:tblHeader/>');
    expect(doc).toContain('9CA3AF'); // 分隔线
    expect(doc).toContain('Consolas');
    expect(doc).toContain('D73A49'); // 代码块语法高亮：python def 关键字（GitHub Light 色板）
  });

  it('A4 sectPr 与字号规格', async () => {
    const { bytes } = await markdownToDocx(MD, { fontSize: 12, paper: 'a4' });
    const { text } = await unpack(bytes);
    const doc = text('word/document.xml');
    expect(doc).toContain('w:w="11906" w:h="16838"');
    expect(doc).toContain('<w:outlineLvl w:val="0"/>'); // 标题入大纲层级
    expect(text('word/styles.xml')).toContain('w:val="24"'); // 12pt → 24 half-points
  });

  it('列表 marker + 悬挂缩进', async () => {
    const { bytes } = await markdownToDocx(MD, { fontSize: 11 });
    const { text } = await unpack(bytes);
    const doc = text('word/document.xml');
    expect(doc).toContain('w:hanging=');
    expect(doc).toContain('1.\t');
    expect(doc).toContain('•\t');
  });

  it('空内容报错', async () => {
    await expect(markdownToDocx('   \n', {})).rejects.toThrow('没有可排版的内容');
  });

  it('zip 结构可被 fflate 原样读回（roundtrip）', async () => {
    const { bytes } = await markdownToDocx('# 回环\n\n段落\n', { fontSize: 11 });
    const round = zipSync({ 'a.docx': new Uint8Array(bytes) });
    expect(round.byteLength).toBeGreaterThan(0);
  });
});

describe('mdhl: 代码语法高亮（GitHub Light 色板，参考 md-to-pdf / markdown-pdf / pandoc-skylighting）', () => {
  it('js token 着色且文本逐字还原', () => {
    const code = 'const a = 1; // 注释\nreturn "你好";';
    const toks = highlightTokens(code, 'js');
    expect(toks.map((t) => t.v).join('')).toBe(code);
    const colors = new Set(toks.filter((t) => t.c).map((t) => t.c));
    expect(colors.has('#d73a49')).toBe(true); // const/return 关键字
    expect(colors.has('#032f62')).toBe(true); // 字符串
    expect(colors.has('#6a737d')).toBe(true); // 注释
  });

  it('未知语言 → null（纯文本回退，与 md-to-pdf 策略一致）；无语言 → 自动探测', () => {
    expect(highlightTokens('x = 1', 'notalang')).toBeNull();
    expect(Array.isArray(highlightTokens('SELECT a FROM t;', ''))).toBe(true);
  });

  it('tokenLines 按 \\n 断行，行数与原文 split 一致（含空行）', () => {
    const code = 'a\n\nb';
    const lines = tokenLines(highlightTokens(code, 'js'));
    expect(lines.length).toBe(code.split('\n').length);
    expect(lines[1]).toEqual([]);
  });

  it('highlightHtml 输出 hljs 类 span；未知语言回退纯转义', () => {
    expect(highlightHtml('const a;', 'js')).toContain('<span class="hljs-keyword">const</span>');
    expect(highlightHtml('<b>', 'notalang')).toBe('&lt;b&gt;');
  });

  it('normalizeLang 提取首词并小写（围栏附加信息剥离）', () => {
    expect(normalizeLang('JS {1,3}')).toBe('js');
    expect(normalizeLang('  ')).toBe('');
  });
});

describe('parseMarkdownRich: 代码块携带 lang/tokens', () => {
  it('js 围栏产出 lang 与彩色 tokens（token 连回 === 原文）', () => {
    const { blocks } = parseMarkdownRich('```js\nconst a = 1;\n```\n');
    const cb = blocks.find((b) => b.type === 'code');
    expect(cb.lang).toBe('js');
    expect(Array.isArray(cb.tokens)).toBe(true);
    expect(cb.tokens.some((t) => t.c === '#d73a49')).toBe(true);
    expect(cb.tokens.map((t) => t.v).join('')).toBe(cb.text); // token 连回 === 代码原文
    expect(cb.text).toBe('const a = 1;'); // marked 会去掉围栏尾换行
  });

  it('未知语言产出 lang 且 tokens 为 null（引擎回退单色）', () => {
    const { blocks } = parseMarkdownRich('```notalang\nfoo bar\n```\n');
    const cb = blocks.find((b) => b.type === 'code');
    expect(cb.lang).toBe('notalang');
    expect(cb.tokens).toBeNull();
  });
});
