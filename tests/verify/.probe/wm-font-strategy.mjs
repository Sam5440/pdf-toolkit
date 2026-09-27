// 临时探针：CJK 字体 subset vs 全量嵌入 —— pdf.js 解析 + fitz 渲染
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';

const bytes = fs.readFileSync('public/fonts/NotoSansSC-Regular.otf');

async function makePdf(subset) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(bytes, { subset });
  const p = doc.addPage([595, 842]);
  p.drawText('绝密 1', { x: 100, y: 400, size: 60, font, color: rgb(0.5, 0.5, 0.5), opacity: 0.4, rotate: degrees(30) });
  const out = await doc.save({ useObjectStreams: false });
  return out;
}

async function pdfjsParse(buf, tag) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf).slice(), useSystemFonts: false, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList();
    console.log(`[${tag}] pdf.js parse OK, ops=${ops.fnArray.length}`);
    return true;
  } catch (e) {
    console.log(`[${tag}] pdf.js PARSE FAIL:`, e.constructor.name, String(e.message).slice(0, 120));
    return false;
  }
}

const sub = await makePdf(true);
fs.writeFileSync('/tmp/probe-sub.pdf', sub);
const full = await makePdf(false);
fs.writeFileSync('/tmp/probe-full.pdf', full);
console.log('sizes: subset =', sub.byteLength, ', full =', full.byteLength);

await pdfjsParse(sub, 'subset');
await pdfjsParse(full, 'full');
