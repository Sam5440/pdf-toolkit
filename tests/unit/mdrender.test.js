// mdrender 纯函数单元测试（vitest node 环境，无 DOM）
// renderRichBlocks 依赖 DOM / katex / mermaid / markmap，由 playwright e2e + pytest 交叉验证。
import { describe, it, expect } from 'vitest';
import {
  splitInlineMath,
  parseMarkdownRich,
  splitEmojiClusters,
} from '../../src/core/mdrender.js';

describe('splitInlineMath', () => {
  it('基本 $...$：前后文字段 + 数学段', () => {
    expect(splitInlineMath('质能方程 $E=mc^2$ 著名')).toEqual([
      { t: 's', v: '质能方程 ' },
      { t: 'm', tex: 'E=mc^2' },
      { t: 's', v: ' 著名' },
    ]);
  });

  it('\\(...\\) 定界符', () => {
    expect(splitInlineMath('a \\(a+b\\) b')).toEqual([
      { t: 's', v: 'a ' },
      { t: 'm', tex: 'a+b' },
      { t: 's', v: ' b' },
    ]);
  });

  it('\\$ 转义：反斜杠+美元不算定界符，保留为字面美元', () => {
    expect(splitInlineMath('价格 \\$5 和 \\$6')).toEqual([{ t: 's', v: '价格 $5 和 $6' }]);
  });

  it('孤立 $（无配对）保持原文字', () => {
    expect(splitInlineMath('成本 $5 和 6 元')).toEqual([{ t: 's', v: '成本 $5 和 6 元' }]);
  });

  it('CJK 紧邻 $x^2$系数 正确切分', () => {
    expect(splitInlineMath('$x^2$系数')).toEqual([
      { t: 'm', tex: 'x^2' },
      { t: 's', v: '系数' },
    ]);
  });

  it('负号内容 $-1$', () => {
    expect(splitInlineMath('温度 $-1$ 度')).toEqual([
      { t: 's', v: '温度 ' },
      { t: 'm', tex: '-1' },
      { t: 's', v: ' 度' },
    ]);
  });

  it('行内 $$ 对当行内数学切分（dd 标记 display 定界）', () => {
    expect(splitInlineMath('a $$x+y$$ b')).toEqual([
      { t: 's', v: 'a ' },
      { t: 'm', tex: 'x+y', dd: true },
      { t: 's', v: ' b' },
    ]);
  });

  it('多个数学原子与纯文本（相邻文字段合并）', () => {
    expect(splitInlineMath('$a$ 和 $b$')).toEqual([
      { t: 'm', tex: 'a' },
      { t: 's', v: ' 和 ' },
      { t: 'm', tex: 'b' },
    ]);
  });

  it('纯文本返回单个文字段', () => {
    expect(splitInlineMath('普通文本')).toEqual([{ t: 's', v: '普通文本' }]);
  });
});

describe('parseMarkdownRich', () => {
  it('标题层级映射：depth≥4 收敛为 h3；title 取首个 h1', () => {
    const { title, blocks, warnings } = parseMarkdownRich('# 一级\n## 二级\n### 三级\n#### 四级\n\n普通段落');
    expect(warnings).toEqual([]);
    expect(title).toBe('一级');
    expect(blocks.map((b) => b.type)).toEqual(['h1', 'h2', 'h3', 'h3', 'p']);
    expect(blocks[0].text).toBe('一级');
    expect(blocks[4].text).toBe('普通段落');
    expect(blocks[4].segs).toBeUndefined();
  });

  it('嵌套无序列表扁平化：level 0/1/2 与 marker •/◦/▪', () => {
    const { blocks } = parseMarkdownRich('- 甲\n  - 乙\n    - 丙');
    expect(blocks.map((b) => b.type)).toEqual(['li', 'li', 'li']);
    expect(blocks.map((b) => b.level)).toEqual([0, 1, 2]);
    expect(blocks.map((b) => b.marker)).toEqual(['•', '◦', '▪']);
    expect(blocks.map((b) => b.text)).toEqual(['甲', '乙', '丙']);
  });

  it('有序列表 marker 为编号；嵌套有序 level 递增', () => {
    const { blocks } = parseMarkdownRich('1. 第一\n2. 第二\n\n1. 外层\n   1. 内层');
    expect(blocks[0].marker).toBe('1.');
    expect(blocks[1].marker).toBe('2.');
    expect(blocks[0].text).toBe('第一');
    expect(blocks[2].level).toBe(0);
    expect(blocks[3].level).toBe(1);
  });

  it('fenced code 分派：mermaid/mindmap/math/latex → img 块，其余 → code', () => {
    const { blocks } = parseMarkdownRich(
      '```mermaid\nflowchart TD\n    A[开始] --> B{是否继续?}\n```\n\n'
      + '```math\nE=mc^2\n```\n\n'
      + '```latex\n\\alpha+\\beta\n```\n\n'
      + '```mindmap\n- 根\n  - 叶\n```\n\n'
      + '```js\nconsole.log(1);\n```\n\n'
      + '```\nplain fence\n```',
    );
    expect(blocks[0]).toMatchObject({ type: 'img', kind: 'mermaid' });
    expect(blocks[0].code).toContain('flowchart TD');
    expect(blocks[1]).toEqual({ type: 'img', kind: 'math', tex: 'E=mc^2' });
    expect(blocks[2]).toEqual({ type: 'img', kind: 'math', tex: '\\alpha+\\beta' });
    expect(blocks[3]).toMatchObject({ type: 'img', kind: 'mindmap' });
    expect(blocks[3].code).toContain('根');
    expect(blocks[4].lang).toBe('js');
    expect(blocks[4].tokens.map((t) => t.v).join('')).toBe('console.log(1);'); // 语法高亮 token
    expect(blocks[4].tokens.some((t) => t.c === '#6f42c1')).toBe(true); // log 函数名紫色
    expect(blocks[5].lang).toBe(''); // 无语言：自动探测（此处无命中 → 单个无色 token）
    expect(blocks[5].tokens.map((t) => t.v).join('')).toBe('plain fence');
  });

  it('独立 $$...$$ 段 → display 数学块', () => {
    const { blocks } = parseMarkdownRich('前文\n\n$$\\int_0^\\infty e^{-x^2}\\,dx=\\frac{\\sqrt{\\pi}}{2}$$\n\n后文');
    expect(blocks[1]).toEqual({ type: 'img', kind: 'math', tex: '\\int_0^\\infty e^{-x^2}\\,dx=\\frac{\\sqrt{\\pi}}{2}', display: true });
    expect(blocks[0].text).toBe('前文');
    expect(blocks[2].text).toBe('后文');
  });

  it('段落内含 $...$ → segs 混合数组；纯文本块无 segs', () => {
    const { blocks } = parseMarkdownRich('能量 $E=mc^2$ 守恒与 $\\alpha$。\n\n纯文本段落。');
    expect(blocks[0].type).toBe('p');
    expect(blocks[0].segs).toEqual([
      { t: 's', v: '能量 ' },
      { t: 'm', tex: 'E=mc^2' },
      { t: 's', v: ' 守恒与 ' },
      { t: 'm', tex: '\\alpha' },
      { t: 's', v: '。' },
    ]);
    expect(blocks[1]).toEqual({ type: 'p', text: '纯文本段落。' });
  });

  it('表格：首行为 header，分隔行跳过', () => {
    const { blocks } = parseMarkdownRich('| 指标 | 数值 |\n| --- | --- |\n| 频率 | 50 |\n| 电压 | 220 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].rows).toEqual([['指标', '数值'], ['频率', '50'], ['电压', '220']]);
  });

  it('http 图片：warning 且不产块', () => {
    const { blocks, warnings } = parseMarkdownRich('![远图](https://example.com/a.png)');
    expect(blocks).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('离线模式不抓取远程图片: https://example.com/a.png');
  });

  it('data: URL 图片保留为 img 块', () => {
    const { blocks, warnings } = parseMarkdownRich('![本图](data:image/png;base64,AAAA)');
    expect(warnings).toEqual([]);
    expect(blocks).toEqual([{ type: 'img', kind: 'image', src: 'data:image/png;base64,AAAA' }]);
  });

  it('html 块：warning 提示跳过', () => {
    const { warnings } = parseMarkdownRich('<div class="x">块级 HTML</div>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('跳过 HTML');
  });

  it('行内富段：strong→b、codespan→c、em/link 只取文本；纯文本块保持 text 形式', () => {
    const { blocks } = parseMarkdownRich('**粗体** 与 *斜体* 与 `代码` 与 [链接](https://x.y)');
    expect(blocks[0].segs).toEqual([
      { t: 'b', v: '粗体' },
      { t: 's', v: ' 与 斜体 与 ' },
      { t: 'c', v: '代码' },
      { t: 's', v: ' 与 链接' },
    ]);
    expect(blocks[0].text).toBeUndefined();
  });

  it('标题含行内代码 → segs（c 段）；纯标题保持 text', () => {
    const { blocks } = parseMarkdownRich('## 接口 `/v1/chat`\n\n## 纯标题');
    expect(blocks[0].segs).toEqual([
      { t: 's', v: '接口 ' },
      { t: 'c', v: '/v1/chat' },
    ]);
    expect(blocks[1]).toEqual({ type: 'h2', text: '纯标题' });
  });

  it('表格单元格：纯文本为字符串，含行内代码/粗体 → 富段', () => {
    const { blocks } = parseMarkdownRich('| A | B |\n| --- | --- |\n| 纯 | `码` 与 **粗** |');
    expect(blocks[0].rows[0]).toEqual(['A', 'B']);
    expect(blocks[0].rows[1][0]).toBe('纯');
    expect(blocks[0].rows[1][1]).toEqual([
      { t: 'c', v: '码' },
      { t: 's', v: ' 与 ' },
      { t: 'b', v: '粗' },
    ]);
  });

  it('引用与分隔线', () => {
    const { blocks } = parseMarkdownRich('> 引用一句\n> 第二行\n\n---');
    expect(blocks[0]).toEqual({ type: 'quote', text: '引用一句\n第二行' });
    expect(blocks[1]).toEqual({ type: 'hr' });
  });
});

describe('splitEmojiClusters', () => {
  it('纯文本不产 emoji 簇', () => {
    expect(splitEmojiClusters('普通文字 123')).toEqual([{ v: '普通文字 123', emoji: false }]);
  });

  it('emoji 与文字混排切簇；VS16 附着到 emoji', () => {
    expect(splitEmojiClusters('结论 ✅ 通过')).toEqual([
      { v: '结论 ', emoji: false },
      { v: '✅', emoji: true },
      { v: ' 通过', emoji: false },
    ]);
  });

  it('⚠️ = ⚠(字体有字形,保持文字) + VS16(丢弃)', () => {
    expect(splitEmojiClusters('⚠️警告')).toEqual([{ v: '⚠警告', emoji: false }]);
  });

  it('孤立 VS16 直接丢弃', () => {
    expect(splitEmojiClusters('a️b')).toEqual([{ v: 'ab', emoji: false }]);
  });

  it('✓ 与 ⚠ 保持文字（字体覆盖），✅/❌/⭐ 为 emoji', () => {
    const r = splitEmojiClusters('✓⚠ ✅ ❌ ⭐');
    expect(r.filter((c) => c.emoji).map((c) => c.v)).toEqual(['✅', '❌', '⭐']);
    expect(r.filter((c) => !c.emoji).map((c) => c.v)).toEqual(['✓⚠ ', ' ', ' ']);
  });
});
