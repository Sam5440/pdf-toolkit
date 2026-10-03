// Markdown → Word (.docx) 轻量原生引擎（离线、零 WASM 依赖）：
// 复用 mdrender 的 parseMarkdownRich + renderRichBlocks 管线（与内置 PDF 引擎同一解析/栅格化层，
// 公式 / Mermaid / 思维导图 / data-URL 图片 / emoji 全部产出 b64 PNG），在此之上直构 OOXML 包
// （fflate zipSync），版式规格对齐 engine-more 的 textStyleOf（标题 2.0/1.55/1.25×、代码 0.92× mono、
// 引用 0.95× 灰字左竖条、表格 #f0f0f0 表头 + 跨页 tblHeader 重复表头）。
//
// 超越点 vs 常见 html-docx 包装方案：真 OOXML 结构（非 altchunk HTML 壳），Word/WPS 原生可编辑；
// 列表用 parser 预计算的 marker 文本 + 悬挂缩进（与 PDF 版式一致，且天然避免多列表续号问题）。
import { zipSync, strToU8 } from 'fflate';
import { parseMarkdownRich, renderRichBlocks } from './mdrender.js';

const XMLNS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const EMU_PER_PT = 12700;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const pt2tw = (pt) => Math.round(pt * 20);
const pt2emu = (pt) => Math.round(pt * EMU_PER_PT);

/** 布尔开关属性拼接 */
const onOff = (tag, on) => (on ? `<w:${tag}/>` : '');

/** 段落内 run 构建器上下文 */
class Ctx {
  constructor() {
    this.media = [];        // {name, bytes}
    this.relEntries = [];   // {id, target}
    this.relSeq = 0;
    this.picSeq = 0;
  }

  relFor(name) {
    const id = `rIdImg${++this.relSeq}`;
    this.relEntries.push({ id, target: `media/${name}` });
    return id;
  }

  /** 行内图片 run（b64 data URL → media 文件）。返回 '' 表示嵌入失败由调用方降级 */
  imageRun(b64, wPt, hPt) {
    const m = /^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/i.exec(String(b64 ?? ''));
    if (!m) return '';
    const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
    let bytes;
    try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { return ''; }
    const name = `image${this.media.length + 1}.${ext === 'jpeg' ? 'jpeg' : ext}`;
    this.media.push({ name, bytes });
    const rid = this.relFor(name);
    const id = ++this.picSeq;
    const cx = pt2emu(Math.max(1, wPt));
    const cy = pt2emu(Math.max(1, hPt));
    return `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>`
      + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${id}" name="Picture ${id}"/>`
      + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
      + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
}

/** 富段（s/b/c/m/e）→ run XML 序列。rPrBase: 额外 rPr（颜色等） */
function segsToRuns(ctx, segs, { fontSize, rPrBase = '', mono = false } = {}) {
  const out = [];
  for (const seg of segs ?? []) {
    if (seg.t === 'e' || (seg.t === 'm' && seg.b64)) {
      const run = ctx.imageRun(seg.b64, seg.wPt, seg.hPt);
      if (run) { out.push(run); continue; }
      out.push(`<w:r><w:t xml:space="preserve">${esc(seg.t === 'm' ? `$${seg.tex}$` : '[图]')}</w:t></w:r>`);
      continue;
    }
    if (seg.t === 'm') { // 数学栅格化失败时的兜底（理论上游已兜）
      out.push(`<w:r><w:t xml:space="preserve">${esc(`$${seg.tex}$`)}</w:t></w:r>`);
      continue;
    }
    const v = String(seg.v ?? '');
    if (!v) continue;
    const isCode = seg.t === 'c' || mono;
    const rPr = [
      rPrBase,
      onOff('b', seg.t === 'b'),
      isCode
        ? `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>`
        : '',
      seg.color ? `<w:color w:val="${String(seg.color).replace('#', '').toUpperCase()}"/>` : '',
      isCode ? `<w:sz w:val="${Math.round(fontSize * 0.92 * 2)}"/>` : '',
    ].join('');
    // 换行按 w:br 切（段落内软换行）
    const parts = v.split('\n');
    const body = parts.map((p, i) => (i ? '<w:br/>' : '') + (p ? `<w:t xml:space="preserve">${esc(p)}</w:t>` : '')).join('');
    out.push(`<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${body}</w:r>`);
  }
  return out.join('');
}

/** 通用段落包装 */
function para(inner, pPr = '') {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
}

const spacingPPr = ({ before = 0, after = 0, lh = 1.6 }) => {
  // w:line 为 240/行倍（auto 规则）；行距乘 240 四舍五入
  return `<w:spacing w:before="${pt2tw(before)}" w:after="${pt2tw(after)}" w:line="${Math.round(lh * 240)}" w:lineRule="auto"/>`;
};

/**
 * blocks（renderRichBlocks 产物）→ document.xml body 内容 + 上下文（media/rels）。
 * 版式对齐 engine-more textStyleOf。
 */
function buildBody(ctx, blocks, { fontSize }) {
  const parts = [];
  const codeLinePara = (line) => para(
    // line: [{v, c?}]——mdhl 高亮 token 行（c=十六进颜色）；无 tokens 时为单 token 纯文本
    (Array.isArray(line) ? line : [{ v: line }]).map((tk) => (
      segsToRuns(ctx, [{ t: 'c', v: tk.v, color: tk.c }], { fontSize })
    )).join(''),
    `${spacingPPr({ before: 0, after: 0, lh: 1.45 })}<w:ind w:left="${pt2tw(fontSize)}"/>`,
  );

  for (const b of blocks) {
    switch (b.type) {
      case 'h1': case 'h2': case 'h3': {
        const scale = b.type === 'h1' ? 2.0 : b.type === 'h2' ? 1.55 : 1.25;
        const sz = Math.round(fontSize * scale * 2);
        const st = b.type === 'h1'
          ? { before: fontSize * 1.2, after: fontSize * 0.6, lh: 1.3 }
          : b.type === 'h2' ? { before: fontSize * 1.0, after: fontSize * 0.5, lh: 1.3 }
            : { before: fontSize * 0.8, after: fontSize * 0.4, lh: 1.35 };
        parts.push(para(
          segsToRuns(ctx, b.segs ?? [{ t: 's', v: b.text ?? '' }], { fontSize, rPrBase: `<w:b/><w:sz w:val="${sz}"/>` }),
          `<w:keepNext/>${spacingPPr(st)}<w:outlineLvl w:val="${Number(b.type[1]) - 1}"/>`,
        ));
        break;
      }
      case 'p':
        parts.push(para(
          segsToRuns(ctx, b.segs ?? [{ t: 's', v: b.text ?? '' }], { fontSize }),
          spacingPPr({ before: 3, after: 3, lh: 1.6 }),
        ));
        break;
      case 'li': {
        const level = b.level ?? 0;
        const left = fontSize * 1.8 * (level + 1);
        const marker = String(b.marker ?? '•');
        const hang = Math.min(marker.length * fontSize * 0.62 + fontSize * 0.5, left);
        const runs = `<w:r><w:t xml:space="preserve">${esc(marker)}\t</w:t></w:r>`
          + segsToRuns(ctx, b.segs ?? [{ t: 's', v: b.text ?? '' }], { fontSize });
        parts.push(para(
          runs,
          `${spacingPPr({ before: 2, after: 2, lh: 1.55 })}<w:ind w:left="${pt2tw(left)}" w:hanging="${pt2tw(hang)}"/>`,
        ));
        break;
      }
      case 'quote':
        parts.push(para(
          segsToRuns(ctx, b.segs ?? [{ t: 's', v: b.text ?? '' }], { fontSize, rPrBase: '<w:color w:val="545B66"/>' }),
          `<w:pBdr><w:left w:val="single" w:sz="12" w:space="6" w:color="CBD5E1"/></w:pBdr>`
          + `${spacingPPr({ before: 4, after: 4, lh: 1.55 })}`
          + `<w:ind w:left="${pt2tw(fontSize * 1.2 + 6)}"/>`,
        ));
        break;
      case 'code': {
        // mdhl 高亮：tokens 按 \n 断行逐 token 着色；无 tokens 回退整块纯文本
        const lines = Array.isArray(b.tokens)
          ? tokenLines(b.tokens)
          : String(b.text ?? '').split('\n').map((v) => [{ v }]);
        if (!lines.length) break;
        parts.push(lines.map(codeLinePara).join(''));
        break;
      }
      case 'table': buildTable(ctx, parts, b, fontSize); break;
      case 'hr':
        parts.push(para(
          '<w:r><w:t xml:space="preserve"> </w:t></w:r>',
          '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="9CA3AF"/></w:pBdr>'
          + `${spacingPPr({ before: 6, after: 6, lh: 1.0 })}`,
        ));
        break;
      case 'img': {
        const run = ctx.imageRun(b.b64, b.wPt, b.hPt);
        if (run) parts.push(para(run, `${spacingPPr({ before: 6, after: 6, lh: 1.2 })}<w:jc w:val="center"/>`));
        break;
      }
      default: break;
    }
  }
  return parts.join('');
}

/** 表格：#aaaaaa 全边框、表头 #f0f0f0 加粗 + tblHeader 跨页重复 */
function buildTable(ctx, parts, b, fontSize) {
  const rows = b.rows ?? [];
  if (!rows.length) return;
  const border = '<w:top w:val="single" w:sz="4" w:color="AAAAAA"/><w:left w:val="single" w:sz="4" w:color="AAAAAA"/>'
    + '<w:bottom w:val="single" w:sz="4" w:color="AAAAAA"/><w:right w:val="single" w:sz="4" w:color="AAAAAA"/>'
    + '<w:insideH w:val="single" w:sz="4" w:color="AAAAAA"/><w:insideV w:val="single" w:sz="4" w:color="AAAAAA"/>';
  const xml = [`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders>`
    + `<w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="113" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="113" w:type="dxa"/></w:tblCellMar></w:tblPr>`];
  rows.forEach((row, ri) => {
    const head = ri === 0;
    const cells = row.map((cell) => {
      const segs = Array.isArray(cell) ? cell : [{ t: 's', v: String(cell ?? '') }];
      const rPr = head ? '<w:b/>' : '';
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/>' : ''}</w:tcPr>`
        + para(segsToRuns(ctx, segs, { fontSize, rPrBase: rPr }), spacingPPr({ before: 1, after: 1, lh: 1.4 }))
        + `</w:tc>`;
    });
    xml.push(`<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`);
  });
  xml.push('</w:tbl>');
  parts.push(xml.join(''));
  // 表后间距：空段（≈1 行）+ after 4pt ≈ 15pt，对齐内置 PDF 引擎 14pt 与 GitHub 12pt 规范
  parts.push(para('', spacingPPr({ before: 0, after: 4, lh: 1.0 })));
}

/** mdhl 高亮 token [{v,c}] → 视觉行（与 engine-more/mddocx 消费侧同构；\n 断行） */
function tokenLines(tokens) {
  const lines = [[]];
  for (const tk of tokens) {
    const parts = String(tk.v ?? '').split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ v: p, c: tk.c });
    });
  }
  return lines;
}

/** 生成完整 .docx 字节。返回 {bytes, warnings, title, richCount} */
export async function markdownToDocx(text, {
  fontSize = 11,
  paper = 'a4',
  name = '文档',
} = {}) {
  const parsed = parseMarkdownRich(text);
  if (!parsed.blocks.length) throw new Error('没有可排版的内容');
  const { blocks, warnings } = await renderRichBlocks(parsed.blocks, { fontSize });
  const title = parsed.title || name;

  const ctx = new Ctx();
  const body = buildBody(ctx, blocks, { fontSize });
  const mediaEntries = Object.fromEntries(ctx.media.map((m) => [`word/${m.name}`, m.bytes]));

  const relXml = ctx.relEntries.map((r) =>
    `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('');
  const stylesRel = '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const paperSz = paper === 'letter'
    ? { w: 12240, h: 15840 }
    : paper === 'a5' ? { w: 8391, h: 11906 }
      : paper === 'a3' ? { w: 16838, h: 23811 }
        : paper === 'legal' ? { w: 12240, h: 20160 }
          : { w: 11906, h: 16838 }; // a4

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${XMLNS_W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>${body}
<w:sectPr><w:pgSz w:w="${paperSz.w}" w:h="${paperSz.h}"/>
<w:pgMar w:top="960" w:right="960" w:bottom="960" w:left="960" w:header="720" w:footer="720" w:gutter="0"/>
</w:sectPr></w:body></w:document>`;

  const halfPt = Math.round(fontSize * 2);
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${XMLNS_W}">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>
<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

  const zip = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${stylesRel}${relXml}</Relationships>`),
    ...mediaEntries,
  });

  const richCount = blocks.filter((b) => b.type === 'img').length;
  return { bytes: zip, warnings, title, richCount };
}
