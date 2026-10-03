// importers 纯文本解析单元测试（node 环境；DOMParser 类解析不在此覆盖，由 e2e 覆盖）
import { describe, it, expect } from 'vitest';
import {
  decodeText,
  parseMarkdown,
  parseRtf,
  parseToBlocks,
} from '../../src/core/importers.js';

const enc = (s) => new TextEncoder().encode(s);

describe('decodeText', () => {
  it('UTF-8 正常解码', () => {
    expect(decodeText(enc('你好 world'))).toBe('你好 world');
  });

  it('UTF-8 BOM 被剥离', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('BOM 测试')]);
    expect(decodeText(bytes)).toBe('BOM 测试');
  });

  it('UTF-16LE BOM 解码', () => {
    // 手工编码为 UTF-16LE 字节（TextEncoder 不支持 utf-16le）
    const s = 'LE 文本';
    const body = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      body.push(cp & 0xff, (cp >> 8) & 0xff);
    }
    const bytes = new Uint8Array([0xff, 0xfe, ...body]);
    expect(decodeText(bytes)).toBe('LE 文本');
  });

  it('GBK 字节回退解码（中 = D6 D0）', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xb9, 0xfa]); // “中国” GBK
    expect(decodeText(bytes)).toBe('中国');
  });
});

describe('parseMarkdown', () => {
  it('标题映射到 h1/h2/h3（超过三级收敛为 h3）', () => {
    const { blocks } = parseMarkdown('# 一级\n## 二级\n### 三级\n#### 四级');
    expect(blocks.map((b) => b.type)).toEqual(['h1', 'h2', 'h3', 'h3']);
    expect(blocks[0].text).toBe('一级');
  });

  it('无序/有序列表，无序圆点、有序数字编号', () => {
    const { blocks } = parseMarkdown('- 甲\n- 乙\n\n1. 一\n2. 二');
    expect(blocks.filter((b) => b.type === 'li').map((b) => b.text)).toEqual(['甲', '乙', '一', '二']);
    expect(blocks[0].marker).toBe('•');
    expect(blocks[2].marker).toBe('1.');
    expect(blocks[3].marker).toBe('2.');
  });

  it('表格：分隔行被跳过、相邻行合并为同一表格块', () => {
    const { blocks } = parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].rows).toEqual([['A', 'B'], ['1', '2'], ['3', '4']]);
  });

  it('代码块：围栏之间的行原样保留', () => {
    const { blocks } = parseMarkdown('前文\n```\nconst a = 1;\n # 不是标题\n```');
    const code = blocks.find((b) => b.type === 'code');
    expect(code.text).toBe('const a = 1;\n # 不是标题');
    expect(blocks[0].text).toBe('前文');
  });

  it('引用与分隔线', () => {
    const { blocks } = parseMarkdown('> 引用一句\n\n---');
    expect(blocks[0]).toEqual({ type: 'quote', text: '引用一句' });
    expect(blocks[1]).toEqual({ type: 'hr' });
  });

  it('行内语法剥离：粗体/斜体/行内代码/链接', () => {
    const { blocks } = parseMarkdown('这是 **粗体** 与 *斜体* 与 `代码` 与 [链接](https://x.y)');
    expect(blocks[0].type).toBe('p');
    expect(blocks[0].text).toBe('这是 粗体 与 斜体 与 代码 与 链接');
  });

  it('空行分段：连续行合并为一个段落', () => {
    const { blocks } = parseMarkdown('第一行\n第二行\n\n新段落');
    const paras = blocks.filter((b) => b.type === 'p');
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toBe('第一行 第二行');
    expect(paras[1].text).toBe('新段落');
  });
});

describe('parseRtf', () => {
  it("\\uN 中文、\\'hh 字节、\\par 分段、fonttbl 目的组跳过", () => {
    const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\n'
      + '\\f0\\fs24 \\u20013?\\u22269?\\par\n'
      + "Hello \\'41\\'42\\'43\\par\n"
      + '}';
    const { blocks } = parseRtf(rtf);
    expect(blocks.map((b) => b.text)).toEqual(['中国', 'Hello ABC']);
    expect(blocks.every((b) => b.type === 'p')).toBe(true);
  });

  it('\\uN 负码点（ANSI 补码）与 \\tab/转义花括号', () => {
    const rtf = '\\u-10179?\\tab X\\par\n\\{escaped\\}';
    const { blocks } = parseRtf(rtf);
    // -10179 + 65536 = 55357（按 RTF 有符号 16 位补码解读）
    expect(blocks[0].text.charCodeAt(0)).toBe(55357);
    expect(blocks[0].text.endsWith('    X')).toBe(true); // \tab → 4 空格
    expect(blocks[1].text).toBe('{escaped}');
  });

  it('裸换行不分段（RTF 源码换行仅为排版），\\par 才分段', () => {
    const { blocks } = parseRtf('line one\\par\nline two\\par');
    expect(blocks.map((b) => b.text)).toEqual(['line one', 'line two']);
  });
});

describe('parseToBlocks（csv/txt 路径，纯文本可测）', () => {
  it('csv：引号内逗号与双引号转义', () => {
    const csv = '名称,数量,备注\n"键盘, 机械",2,"带""质检""标签"\n鼠标,3,无线';
    const { blocks } = parseToBlocks('data.csv', enc(csv));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].rows).toEqual([
      ['名称', '数量', '备注'],
      ['键盘, 机械', '2', '带"质检"标签'],
      ['鼠标', '3', '无线'],
    ]);
  });

  it('csv：末尾空行被裁剪', () => {
    const { blocks } = parseToBlocks('t.csv', enc('a,b\n1,2\n\n\n'));
    expect(blocks[0].rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('txt：逐行成段，制表符保留为空格', () => {
    const { blocks } = parseToBlocks('log.txt', enc('第一行\t缩进\n第二行'));
    expect(blocks.map((b) => b.type)).toEqual(['p', 'p']);
    expect(blocks[0].text).toBe('第一行    缩进');
  });

  it('md 后缀走 parseMarkdown；未知后缀抛出可读错误', () => {
    expect(parseToBlocks('doc.md', enc('# 标题')).blocks[0].type).toBe('h1');
    expect(() => parseToBlocks('file.xyz', enc('x'))).toThrow(/不支持/);
  });
});
