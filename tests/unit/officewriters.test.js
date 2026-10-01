// officewriters（Office/ODF/RTF/EPUB 写入器）+ tiff 编解码单元测试（node 环境）
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildOffice, buildDocx, buildXlsx, buildPptx, buildOdt, buildEpub,
  buildRtf, buildHtml, buildMd,
} from '../../src/core/officewriters.js';
import { encodeTiff, decodeTiff } from '../../src/core/tiff.js';

const pages = [
  {
    lines: [
      { text: 'Fixture Page 1', size: 22, heading: 1, bold: false },
      { text: '第 1 页：示例文档', size: 16, heading: 0, bold: false },
      { text: 'The quick brown fox', size: 12, heading: 0, bold: true },
    ],
  },
  {
    lines: [{ text: '第二页内容 plain', size: 12, heading: 0 }],
  },
];

describe('officewriters · zip 族', () => {
  it('buildDocx：word/document.xml 含原文与标题大纲', () => {
    const zip = unzipSync(buildDocx(pages));
    expect(Object.keys(zip)).toContain('word/document.xml');
    expect(Object.keys(zip)).toContain('[Content_Types].xml');
    const doc = strFromU8(zip['word/document.xml']);
    expect(doc).toContain('<w:document');
    expect(doc).toContain('Fixture Page 1');
    expect(doc).toContain('第 1 页：示例文档');
    expect(doc).toContain('<w:outlineLvl w:val="0"/>'); // heading 1
  });

  it('buildXlsx：sheet1 含单元格文本，workbook 登记两张表', () => {
    const zip = unzipSync(buildXlsx(pages));
    const sheet1 = strFromU8(zip['xl/worksheets/sheet1.xml']);
    expect(sheet1).toContain('<worksheet');
    expect(sheet1).toContain('inlineStr');
    expect(sheet1).toContain('Fixture Page 1');
    const wb = strFromU8(zip['xl/workbook.xml']);
    expect(wb).toContain('第1页');
    expect(wb).toContain('第2页');
  });

  it('buildPptx：slide1/slide2 存在且含文本，presentation 引用两页', () => {
    const zip = unzipSync(buildPptx(pages));
    expect(Object.keys(zip)).toContain('ppt/slides/slide1.xml');
    expect(Object.keys(zip)).toContain('ppt/slides/slide2.xml');
    const s1 = strFromU8(zip['ppt/slides/slide1.xml']);
    expect(s1).toContain('<p:sld');
    expect(s1).toContain('Fixture Page 1');
    const pres = strFromU8(zip['ppt/presentation.xml']);
    expect(pres).toContain('rId2');
  });

  it('buildOdt：mimetype 首条目 + content.xml 标题/段落', () => {
    const zip = unzipSync(buildOdt(pages));
    expect(Object.keys(zip)[0]).toBe('mimetype');
    expect(strFromU8(zip.mimetype)).toContain('opendocument.text');
    const content = strFromU8(zip['content.xml']);
    expect(content).toContain('<text:h text:outline-level="1">Fixture Page 1</text:h>');
    expect(content).toContain('<text:p>第 1 页：示例文档</text:p>');
  });

  it('buildEpub：ch1.xhtml/content.opf/container.xml 结构完整', () => {
    const zip = unzipSync(buildEpub(pages, { title: '测试书' }));
    expect(Object.keys(zip)).toContain('OEBPS/ch1.xhtml');
    expect(Object.keys(zip)).toContain('OEBPS/content.opf');
    expect(Object.keys(zip)).toContain('META-INF/container.xml');
    const ch = strFromU8(zip['OEBPS/ch1.xhtml']);
    expect(ch).toContain('Fixture Page 1');
    expect(strFromU8(zip['OEBPS/content.opf'])).toContain('测试书');
  });

  it('buildOffice 统一入口：format → ext/mime 正确', () => {
    const r = buildOffice('md', pages);
    expect(r.ext).toBe('md');
    expect(r.mime).toContain('text/markdown');
    expect(() => buildOffice('nope', pages)).toThrow(/不支持的导出格式/);
  });
});

describe('officewriters · 字符串族', () => {
  it('buildRtf：文件头 + \\u 转义中文', () => {
    const s = strFromU8(buildRtf(pages));
    expect(s.startsWith('{\\rtf1')).toBe(true);
    expect(s).toContain('\\u'); // 中文以 \uN 转义
    expect(s).toContain('Fixture Page 1');
    expect(s).toContain('}'); // 闭合
  });

  it('buildHtml：<html> 骨架 + 标题/段落', () => {
    const s = strFromU8(buildHtml(pages, { title: 'T' }));
    expect(s).toContain('<!DOCTYPE html>');
    expect(s).toContain('<html');
    expect(s).toContain('<h1>Fixture Page 1</h1>');
    expect(s).toContain('<p>第 1 页：示例文档</p>');
  });

  it('buildMd：标题映射 #，页间分隔 ---', () => {
    const s = strFromU8(buildMd(pages));
    expect(s).toContain('# Fixture Page 1');
    expect(s).toContain('第二页内容 plain');
    expect(s).toContain('---');
  });

  it('XML 转义：< > & 不破坏结构', () => {
    const zip = unzipSync(buildDocx([{ lines: [{ text: 'a<b>&"c"', size: 11 }] }]));
    const doc = strFromU8(zip['word/document.xml']);
    expect(doc).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
  });
});

describe('tiff roundtrip', () => {
  it('RGB + 灰度两页：encode → decode 像素一致', async () => {
    const w = 4, h = 3;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 29) % 256;
      rgba[i * 4 + 1] = (i * 61) % 256;
      rgba[i * 4 + 2] = (i * 97) % 256;
      rgba[i * 4 + 3] = 255;
    }
    const gray = new Uint8Array([200, 100, 50, 25, 12, 250]);
    const tiff = encodeTiff([
      { data: rgba, w, h },
      { data: gray, w: 3, h: 2, gray: true },
    ]);
    expect(tiff[0]).toBe(0x49); // 'II' 小端
    const out = await decodeTiff(tiff);
    expect(out).toHaveLength(2);
    expect(out[0].w).toBe(w);
    expect(out[0].h).toBe(h);
    const d = out[0].data;
    for (let i = 0; i < w * h; i++) {
      expect(d[i * 4]).toBe(rgba[i * 4]);
      expect(d[i * 4 + 1]).toBe(rgba[i * 4 + 1]);
      expect(d[i * 4 + 2]).toBe(rgba[i * 4 + 2]);
      expect(d[i * 4 + 3]).toBe(255);
    }
    const g = out[1].data;
    for (let i = 0; i < 6; i++) {
      expect(g[i * 4]).toBe(gray[i]);
      expect(g[i * 4 + 3]).toBe(255);
    }
  });

  it('空页面数组抛错', () => {
    expect(() => encodeTiff([])).toThrow(/无页面数据/);
  });
});
