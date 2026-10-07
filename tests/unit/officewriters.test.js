// officewriters（Office/ODF/RTF/EPUB 写入器）+ tiff 编解码单元测试（node 环境）
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildOffice, buildDocx, buildXlsx, buildPptx, buildPptxImages, buildOdt, buildEpub,
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

describe('officewriters · buildPptxImages（图片型）', () => {
  // A4 竖版页：595×842pt → EMU ×12700
  const A4 = { w: 595, h: 842 };
  const slides = [
    { bytes: new Uint8Array([0x89, 1, 2, 3]), mime: 'image/png', ...A4 },
    { bytes: new Uint8Array([0xff, 4, 5]), mime: 'image/jpeg', ...A4 },
  ];

  it('跟随页面尺寸：1:1 铺满（off 0,0，ext=幻灯片尺寸），媒体按页落盘', () => {
    const zip = unzipSync(buildPptxImages(slides));
    expect(Object.keys(zip)).toContain('ppt/media/image1.png');
    expect(Object.keys(zip)).toContain('ppt/media/image2.jpg');
    expect([...zip['ppt/media/image1.png']]).toEqual([0x89, 1, 2, 3]);
    const s1 = strFromU8(zip['ppt/slides/slide1.xml']);
    expect(s1).toContain('<p:pic>');
    expect(s1).toContain('r:embed="rId2"');
    expect(s1).toContain('<a:off x="0" y="0"/><a:ext cx="7556500" cy="10693400"/>');
    const pres = strFromU8(zip['ppt/presentation.xml']);
    expect(pres).toContain('<p:sldSz cx="7556500" cy="10693400"/>');
    const rels1 = strFromU8(zip['ppt/slides/_rels/slide1.xml.rels']);
    expect(rels1).toContain('Target="../media/image1.png"');
    const ct = strFromU8(zip['[Content_Types].xml']);
    expect(ct).toContain('Extension="png"');
    expect(ct).toContain('Extension="jpg"');
  });

  it('16:9 + contain：等比适应留白居中（水平有边距，不出界）', () => {
    const zip = unzipSync(buildPptxImages([slides[0]], { slideWPt: 960, slideHPt: 540, fit: 'contain' }));
    const s1 = strFromU8(zip['ppt/slides/slide1.xml']);
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(s1);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(s1);
    expect(+off[1]).toBeGreaterThan(0); // 左右留白居中
    expect(+ext[1]).toBeLessThan(12192000); // 宽度未占满
    expect(+ext[2]).toBeLessThanOrEqual(6858000); // 高度不超界
    expect(strFromU8(zip['ppt/presentation.xml'])).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
  });

  it('16:9 + cover：铺满裁切（短边占满、长边出界负偏移）', () => {
    const zip = unzipSync(buildPptxImages([slides[0]], { slideWPt: 960, slideHPt: 540, fit: 'cover' }));
    const s1 = strFromU8(zip['ppt/slides/slide1.xml']);
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(s1);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(s1);
    expect(+off[2]).toBeLessThan(0); // 垂直方向出界（裁切）
    expect(+ext[1]).toBeGreaterThanOrEqual(12192000); // 宽度占满
  });

  it('stretch：拉伸填满（off 0,0，ext=幻灯片尺寸）', () => {
    const zip = unzipSync(buildPptxImages([slides[0]], { slideWPt: 960, slideHPt: 540, fit: 'stretch' }));
    const s1 = strFromU8(zip['ppt/slides/slide1.xml']);
    expect(s1).toContain('<a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/>');
  });

  it('空页面 / 尺寸缺失抛错', () => {
    expect(() => buildPptxImages([])).toThrow(/没有可写入的页面/);
    expect(() => buildPptxImages([{ bytes: new Uint8Array([1]), mime: 'image/png' }])).toThrow(/页面尺寸缺失/);
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

  it('东亚字体声明：docx rFonts 与 pptx run/theme 均显式声明中文字体（防部分查看器豆腐块）', () => {
    const docx = unzipSync(buildDocx([{ lines: [{ text: '中文正文', size: 12 }] }]));
    const doc = strFromU8(docx['word/document.xml']);
    expect(doc).toContain('w:eastAsia="微软雅黑"');
    const pptx = unzipSync(buildPptx([{ lines: [{ text: '中文标题', size: 20 }] }]));
    const s1 = strFromU8(pptx['ppt/slides/slide1.xml']);
    expect(s1).toContain('<a:ea typeface="微软雅黑"/>');
    expect(s1).not.toContain('/><a:t>'); // rPr 不再自闭合（需包住 latin/ea 子元素）
    const theme = strFromU8(pptx['ppt/theme/theme1.xml']);
    expect(theme.match(/<a:ea typeface="微软雅黑"\/>/g)).toHaveLength(2); // major + minor
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
