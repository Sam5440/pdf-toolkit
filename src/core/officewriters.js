// 最小 Office/ODF/RTF/EPUB 写入器（纯字符串 + fflate，worker 与主线程均可使用）。
// 输入统一为「页数据」：[{ lines: [{ text, size, bold, heading? }] }]（heading: 0=正文 1..3=标题级）。
// 定位：文本级转换——保留全部文字与段落结构；不还原像素排版（与 PDF24 同类转换的保真级别一致）。
import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // 去掉 XML 非法控制字符
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// 生成物显式声明东亚字体：主题/运行级都留空的 OOXML 在部分查看器（WPS /
// LibreOffice 特定版本 / 旧版 PowerPoint）里会以纯西文字体渲染中文 → 豆腐块。
// 微软雅黑覆盖 Windows/WPS 主流环境；macOS PowerPoint 缺字时自动替换为苹方。
const EA_FONT = '微软雅黑';

const HEAD_SIZE = { 1: 32, 2: 26, 3: 22 }; // 半磅单位用不到，直接用 pt

/** 供 docx/odt 使用的段落 XML 生成器家族 */
function docxParagraph(line) {
  const text = String(line.text ?? '');
  const heading = line.heading || 0;
  const sizeHalfPt = Math.max(2, Math.round((heading ? HEAD_SIZE[heading] : (line.size || 11)) * 2));
  const bold = heading || line.bold;
  if (!text.trim()) return '<w:p/>';
  return `<w:p><w:pPr>${heading ? `<w:outlineLvl w:val="${heading - 1}"/>` : ''}</w:pPr>` +
    `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="${EA_FONT}"/>` +
    `${bold ? '<w:b/>' : ''}<w:sz w:val="${sizeHalfPt}"/></w:rPr>` +
    `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

export function buildDocx(pages, { title = '' } = {}) {
  const body = pages.map((p) => p.lines.map(docxParagraph).join('')).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(documentXml),
  });
}

// 文本型与图片型 PPTX 共用的 theme 部件（OOXML 固定骨架；ea 声明东亚字体防豆腐块）
const PPTX_THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="${EA_FONT}"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="${EA_FONT}"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/** PPTX：每页一帧，一个文本框容纳全部行 */
export function buildPptx(pages) {
  const n = pages.length;
  const slideXml = (lines) => {
    const paras = lines.length ? lines : [{ text: '' }];
    const body = paras.map((l) => {
      const heading = l.heading || 0;
      const sz = Math.round((heading ? HEAD_SIZE[heading] : (l.size || 14)) * 100);
      const rpr = `<a:rPr lang="zh-CN" sz="${Math.min(40000, Math.max(900, sz))}"${heading || l.bold ? ' b="1"' : ''}><a:latin typeface="Calibri"/><a:ea typeface="${EA_FONT}"/></a:rPr>`;
      return `<a:p><a:pPr/><a:r>${rpr}<a:t>${esc(l.text)}</a:t></a:r></a:p>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="文本框"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="7772400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  };
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${pages.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5486400"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${pages.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`),
    'ppt/theme/theme1.xml': strToU8(PPTX_THEME_XML),
  };
  pages.forEach((p, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slideXml(p.lines));
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
  });
  return zipSync(files);
}

/**
 * PPTX（图片型）：每页一帧整页图片，观感与原 PDF 一致（文字不可编辑）。
 * @param {Array<{bytes:Uint8Array, mime:string, w:number, h:number}>} slides
 *   每页一项：bytes/mime 为该页渲染图，w/h 为该页可视尺寸（pt，含 /Rotate 旋转后）。
 * @param {{slideWPt?:number, slideHPt?:number, fit?:'contain'|'cover'|'stretch'}} opts
 *   slideWPt/slideHPt 幻灯片尺寸（pt，缺省取第一页尺寸 → 1:1 铺满）；
 *   fit 决定页图与幻灯片比例不一致时的填充方式：等比适应留白 / 铺满裁切 / 拉伸变形。
 */
export function buildPptxImages(slides, opts = {}) {
  if (!slides.length) throw new Error('没有可写入的页面');
  for (const s of slides) {
    if (!(s.w > 0) || !(s.h > 0)) throw new Error('页面尺寸缺失，无法确定幻灯片版式');
  }
  const EMU_PT = 12700; // 1pt = 12700 EMU
  const sw = Math.round((opts.slideWPt || slides[0].w) * EMU_PT);
  const sh = Math.round((opts.slideHPt || slides[0].h) * EMU_PT);
  const fit = opts.fit || 'contain';
  // 页图在幻灯片上的位置（EMU）；cover 可能产生负偏移（居中裁切）
  const place = (wPt, hPt) => {
    if (fit === 'stretch') return { x: 0, y: 0, cx: sw, cy: sh };
    const s = (fit === 'cover' ? Math.max : Math.min)(sw / (wPt * EMU_PT), sh / (hPt * EMU_PT));
    const cx = Math.round(wPt * EMU_PT * s);
    const cy = Math.round(hPt * EMU_PT * s);
    return { x: Math.round((sw - cx) / 2), y: Math.round((sh - cy) / 2), cx, cy };
  };
  const extOf = (mime) => (mime === 'image/jpeg' ? 'jpg' : 'png');
  const exts = [...new Set(slides.map((s2) => extOf(s2.mime)))];
  const MIME_CT = { png: 'image/png', jpg: 'image/jpeg' };

  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map((e) => `<Default Extension="${e}" ContentType="${MIME_CT[e]}"/>`).join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${sw}" cy="${sh}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`),
    'ppt/theme/theme1.xml': strToU8(PPTX_THEME_XML),
  };
  slides.forEach((s2, i) => {
    const ext = extOf(s2.mime);
    const pos = place(s2.w, s2.h);
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="第 ${i + 1} 页"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:spPr><a:xfrm><a:off x="${pos.x}" y="${pos.y}"/><a:ext cx="${pos.cx}" cy="${pos.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.${ext}"/></Relationships>`);
    files[`ppt/media/image${i + 1}.${ext}`] = s2.bytes;
  });
  return zipSync(files);
}

/** XLSX：一页一张工作表，行文本按 2+ 空格分列，全部 inlineStr */
export function buildXlsx(pages) {
  const splitCols = (text) => {
    const t = String(text ?? '');
    const cols = t.split(/\s{2,}|\t+/).map((s) => s.trim()).filter(Boolean);
    return cols.length > 1 ? cols : [t.trim()];
  };
  const sheetXml = (page) => {
    const rows = page.lines.map((l, ri) => {
      const cols = splitCols(l.text);
      const cells = cols.map((c, ci) => `<c r="${String.fromCharCode(65 + Math.min(ci, 25))}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${pages.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${pages.map((_, i) => `<sheet name="第${i + 1}页" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pages.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  pages.forEach((p, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(p)); });
  return zipSync(files);
}

const ODF_NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2"`;

function odfHead(bodyXml, extraStyles = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS}><office:automatic-styles>${extraStyles}</office:automatic-styles><office:body>${bodyXml}</office:body></office:document-content>`;
}

export function buildOdt(pages) {
  const body = `<office:text>${pages.map((p, i) => {
    const paras = p.lines.map((l) => {
      const heading = l.heading || 0;
      if (heading) return `<text:h text:outline-level="${heading}">${esc(l.text)}</text:h>`;
      return `<text:p>${esc(l.text)}</text:p>`;
    }).join('');
    return (i > 0 ? `<text:p text:style-name="P_sep"/>` : '') + paras;
  }).join('')}</office:text>`;
  const styles = '<style:style style:name="P_sep" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.2in"/></style:style>';
  return odfZip(odfHead(body, styles), 'application/vnd.oasis.opendocument.text');
}

export function buildOds(pages) {
  const body = `<office:spreadsheet>${pages.map((p, i) => {
    const rows = p.lines.map((l) => {
      const cells = String(l.text ?? '').split(/\s{2,}|\t+/).map((s) => s.trim()).filter(Boolean);
      if (!cells.length) return '<table:table-row/>';
      return `<table:table-row>${cells.map((c) => `<table:table-cell office:value-type="string"><text:p>${esc(c)}</text:p></table:table-cell>`).join('')}</table:table-row>`;
    }).join('');
    return `<table:table table:name="第${i + 1}页">${rows}</table:table>`;
  }).join('')}</office:spreadsheet>`;
  return odfZip(odfHead(body), 'application/vnd.oasis.opendocument.spreadsheet');
}

export function buildOdp(pages) {
  const body = `<office:presentation>${pages.map((p, i) => {
    const frame = `<draw:frame presentation:style-name="pr1" draw:layer="layout" svg:width="24cm" svg:height="13cm" svg:x="1.5cm" svg:y="3cm"><draw:text-box>${p.lines.map((l) => `<text:p>${esc(l.text)}</text:p>`).join('')}</draw:text-box></draw:frame>`;
    return `<draw:page draw:name="page${i + 1}" draw:master-page-name="Default">${frame}</draw:page>`;
  }).join('')}</office:presentation>`;
  const styles = '<style:style style:name="pr1" style:family="presentation"><style:graphic-properties draw:fill="none" draw:stroke="none"/></style:style>';
  return odfZip(odfHead(body, styles), 'application/vnd.oasis.opendocument.presentation');
}

/** ODF 打包：mimetype 必须为首个未压缩条目 */
function odfZip(contentXml, mime) {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NS}><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`;
  return zipSync({
    mimetype: [strToU8(mime), { level: 0 }],
    'content.xml': strToU8(contentXml),
    'styles.xml': strToU8(stylesXml),
    'META-INF/manifest.xml': strToU8(manifest),
  });
}

/** RTF：\uN 转义任意 Unicode；每页用 \page 分隔 */
export function buildRtf(pages) {
  const out = ['{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss SimSun;}}'];
  const escRtf = (s) => {
    let r = '';
    for (const ch of String(s ?? '')) {
      const cp = ch.codePointAt(0);
      if (ch === '\\' || ch === '{' || ch === '}') r += `\\${ch}`;
      else if (cp < 128) r += ch;
      else if (cp > 32767) r += `\\u${cp - 65536}?`;
      else r += `\\u${cp}?`;
    }
    return r;
  };
  pages.forEach((p, i) => {
    if (i > 0) out.push('\\page');
    for (const l of p.lines) {
      const heading = l.heading || 0;
      if (heading) out.push(`{\\fs${Math.round(HEAD_SIZE[heading] * 2)}\\b `);
      out.push(escRtf(l.text));
      if (heading) out.push('}');
      out.push('\\par');
    }
  });
  out.push('}');
  return strToU8(out.join('\n'));
}

export function buildHtml(pages, { title = '文档' } = {}) {
  const body = pages.map((p) => {
    const inner = p.lines.map((l) => {
      const h = l.heading || 0;
      if (h) return `<h${h}>${esc(l.text)}</h${h}>`;
      return `<p>${esc(l.text)}</p>`;
    }).join('\n');
    return `<section class="page">\n${inner}\n</section>`;
  }).join('\n');
  const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:'Noto Sans SC',system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.7;color:#222}
section.page{border-bottom:1px dashed #bbb;padding-bottom:1.5rem;margin-bottom:1.5rem}h1{font-size:1.7em}h2{font-size:1.4em}h3{font-size:1.15em}</style>
</head><body>${body}</body></html>`;
  return strToU8(html);
}

export function buildMd(pages) {
  const parts = [];
  pages.forEach((p, i) => {
    if (i > 0) parts.push('\n---\n');
    for (const l of p.lines) {
      const h = l.heading || 0;
      parts.push(h ? `${'#'.repeat(h)} ${l.text}` : l.text);
      parts.push('');
    }
  });
  return strToU8(parts.join('\n'));
}

/** EPUB：每页一章 */
export function buildEpub(pages, { title = '文档', author = 'PDF 万能工具箱' } = {}) {
  const uuid = `urn:uuid:${crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
  const chapter = (p, i) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第 ${i + 1} 页</title></head><body>${p.lines.map((l) => {
    const h = l.heading || 0;
    return h ? `<h${Math.min(h, 6)}>${esc(l.text)}</h${Math.min(h, 6)}>` : `<p>${esc(l.text)}</p>`;
  }).join('\n')}</body></html>`;
  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dc:language>zh</dc:language><dc:identifier id="bookid">${uuid}</dc:identifier></metadata><manifest>${pages.map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">${pages.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('')}</spine></package>`),
    'OEBPS/toc.ncx': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/></head><docTitle><text>${esc(title)}</text></docTitle><navMap>${pages.map((_, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>第 ${i + 1} 页</text></navLabel><content src="ch${i + 1}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`),
  };
  pages.forEach((p, i) => { files[`OEBPS/ch${i + 1}.xhtml`] = strToU8(chapter(p, i)); });
  return zipSync(files);
}

/** 统一入口：format → { bytes, mime, ext } */
export function buildOffice(format, pages, opts = {}) {
  const t = String(format).toLowerCase();
  const map = {
    docx: () => ({ bytes: buildDocx(pages, opts), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' }),
    pptx: () => ({ bytes: buildPptx(pages), mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' }),
    xlsx: () => ({ bytes: buildXlsx(pages), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' }),
    odt: () => ({ bytes: buildOdt(pages), mime: 'application/vnd.oasis.opendocument.text', ext: 'odt' }),
    ods: () => ({ bytes: buildOds(pages), mime: 'application/vnd.oasis.opendocument.spreadsheet', ext: 'ods' }),
    odp: () => ({ bytes: buildOdp(pages), mime: 'application/vnd.oasis.opendocument.presentation', ext: 'odp' }),
    rtf: () => ({ bytes: buildRtf(pages), mime: 'application/rtf', ext: 'rtf' }),
    html: () => ({ bytes: buildHtml(pages, opts), mime: 'text/html;charset=utf-8', ext: 'html' }),
    md: () => ({ bytes: buildMd(pages), mime: 'text/markdown;charset=utf-8', ext: 'md' }),
    epub: () => ({ bytes: buildEpub(pages, opts), mime: 'application/epub+zip', ext: 'epub' }),
  };
  if (!map[t]) throw new Error(`不支持的导出格式 ${format}`);
  return map[t]();
}
