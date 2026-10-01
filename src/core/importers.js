// 文档解析器（主线程）：把 txt / markdown / rtf / epub / html / odf / xlsx 解析为
// 统一的「块」模型，交给引擎 text.toPdf 分页渲染。
// 块模型：{type:'h1'|'h2'|'h3'|'p'|'li'|'quote'|'code'|'hr'|'pagebreak'|'table', text?, rows?, marker?}
import { unzipSync, strFromU8 } from 'fflate';

export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder('utf-8').decode(u8.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    try { return new TextDecoder('gb18030').decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); }
  }
}

// --- Markdown（子集：标题/列表/引用/代码块/表格/粗斜体剥离为纯文本保结构） ---

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let inCode = false, codeBuf = [], listMarker = null, paraBuf = [];
  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1');
  const flushPara = () => {
    if (paraBuf.length) { blocks.push({ type: 'p', text: paraBuf.map(inline).join(' ') }); paraBuf = []; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    if (/^```/.test(line.trim())) {
      if (inCode) { blocks.push({ type: 'code', text: codeBuf.join('\n') }); codeBuf = []; inCode = false; }
      else { flushPara(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const mH = /^(#{1,6})\s+(.*)$/.exec(line);
    if (mH) {
      flushPara();
      blocks.push({ type: `h${Math.min(3, mH[1].length)}`, text: inline(mH[2]) });
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); continue; }
    if (line.startsWith('>')) { flushPara(); blocks.push({ type: 'quote', text: inline(line.replace(/^>\s?/, '')) }); continue; }
    const mUl = /^\s*[-*+]\s+(.*)$/.exec(line);
    const mOl = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (mUl || mOl) {
      flushPara();
      blocks.push({ type: 'li', text: inline(mUl ? mUl[1] : mOl[1]), marker: mUl ? '•' : null });
      continue;
    }
    if (/^\s*\|.+\|\s*$/.test(line)) {
      flushPara();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'table') prev.rows.push(cells);
      else blocks.push({ type: 'table', rows: [cells] });
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    paraBuf.push(line.trim());
  }
  if (inCode && codeBuf.length) blocks.push({ type: 'code', text: codeBuf.join('\n') });
  flushPara();
  return { blocks };
}

// --- RTF（子集：\uN Unicode、\'hh 字节、\par 分段、ANSI 组跳过） ---

export function parseRtf(bytes) {
  const text = String(bytes ?? '');
  let out = '';
  let i = 0;
  let skipGroup = 0;
  const HEX = '0123456789abcdef';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      // 目的组（fonttbl/colortbl/stylesheet/info/\*）跳过
      const rest = text.slice(i, i + 30);
      if (/^\{\\\*|^\{\\fonttbl|^\{\\colortbl|^\{\\stylesheet|^\{\\info|^\{\\themedata/.test(rest)) skipGroup++;
      i++;
      continue;
    }
    if (ch === '}') { if (skipGroup > 0) skipGroup--; i++; continue; }
    if (skipGroup > 0) { i++; continue; }
    if (ch === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?/.exec(text.slice(i));
      if (m) {
        const word = m[1];
        if (word === 'par' || word === 'line' || word === 'sect') out += '\n';
        else if (word === 'tab') out += '    ';
        else if (word === 'u') {
          const cp = Number(m[2]);
          if (Number.isFinite(cp)) {
            // 跳过替代字符（\uc1 时跟 1 个字符）
            const uc = /\\uc(\d+)/.exec(text.slice(0, i))?.[1];
            const skipN = uc ? Number(uc) : 1;
            let j = i + m[0].length;
            // 替代字符可能是 \'hh 或普通字符
            if (text.slice(j, j + 2) === "\\'") j += 4;
            else if (skipN > 0) j += skipN;
            i = j;
            out += String.fromCodePoint(cp < 0 ? cp + 65536 : cp);
            continue;
          }
        } else if (word === 'uc' || word === 'ansicpg' || word === 'fonttbl' || word === 'f' || word === 'fs' || word === 'b' || word === 'i' || word === 'ul' || word === 'ulnone' || word === 'qc' || word === 'ql' || word === 'qr' || word === 'pard' || word === 'plain' || word === 'rtf' || word === 'deff' || word === 'ansi' || word === 'mac' || word === 'pc' || word === 'pca' || word === 's' || word === 'widctlpar' || word === 'li' || word === 'ri' || word === 'sa' || word === 'sb' || word === 'sl' || word === 'fi' || word === 'tx' || word === 'cell' || word === 'row' || word === 'brdrt' || word === 'brdrb' || word === 'brdrl' || word === 'brdrr') {
          // 已知控制字，吞掉参数
        }
        i += m[0].length;
        continue;
      }
      const hx = /^\\'([0-9a-fA-F]{2})/.exec(text.slice(i));
      if (hx) {
        // 单字节：按 cp1252 近似（CJK 文档多为 \uN，此处保底）
        const b = parseInt(hx[1], 16);
        if (b >= 128 && b <= 255) {
          const CP1252_HI = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
          out += CP1252_HI[b - 128] ?? String.fromCharCode(b);
        } else out += String.fromCharCode(b);
        i += 4;
        continue;
      }
      // 转义符号
      const esc2 = text[i + 1];
      if (esc2 === '\\' || esc2 === '{' || esc2 === '}') { out += esc2; i += 2; continue; }
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') { i++; continue; }
    out += ch;
    i++;
  }
  const lines = out.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (const l of lines) {
    if (l.trim()) blocks.push({ type: 'p', text: l.trim() });
  }
  return { blocks };
}

// --- HTML ---

export function parseHtml(html, { baseUrl = '' } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,canvas,iframe').forEach((n) => n.remove());
  const title = doc.querySelector('title')?.textContent?.trim() || '';
  const blocks = [];
  const pushText = (el, type) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ type, text: t });
  };
  const walk = (root) => {
    for (const el of root.children) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) pushText(el, `h${Math.min(3, Number(tag[1]))}`);
      else if (tag === 'p') pushText(el, 'p');
      else if (tag === 'li') pushText(el, 'li');
      else if (tag === 'blockquote') pushText(el, 'quote');
      else if (tag === 'pre') blocks.push({ type: 'code', text: el.textContent || '' });
      else if (tag === 'hr') blocks.push({ type: 'hr' });
      else if (tag === 'table') {
        const rows = [];
        el.querySelectorAll('tr').forEach((tr) => {
          const cells = [...tr.querySelectorAll('th,td')].map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim());
          if (cells.length) rows.push(cells);
        });
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (tag === 'ul' || tag === 'ol') {
        walk(el);
      } else if (tag === 'img') {
        const alt = el.getAttribute('alt');
        if (alt) blocks.push({ type: 'p', text: `[图片: ${alt}]` });
      } else if (el.children.length) {
        walk(el);
      } else if (tag === 'br') {
        // 忽略
      } else {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) blocks.push({ type: 'p', text: t });
      }
    }
  };
  walk(doc.body);
  return { blocks, title };
}

// --- EPUB ---

export function parseEpub(bytes) {
  let zip;
  try {
    zip = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new Error('无法读取 EPUB（ZIP）结构');
  }
  const readStr = (p) => (zip[p] ? strFromU8(zip[p]) : null);
  const container = readStr('META-INF/container.xml');
  let opfPath = null;
  if (container) {
    const c = new DOMParser().parseFromString(container, 'application/xml');
    opfPath = c.querySelector('rootfile')?.getAttribute('full-path');
  }
  if (!opfPath || !zip[opfPath]) {
    opfPath = Object.keys(zip).find((k) => /\.opf$/i.test(k));
  }
  const opfDir = opfPath ? opfPath.replace(/[^/]*$/, '') : '';
  let spineFiles = [];
  let title = '';
  if (opfPath && zip[opfPath]) {
    const opf = new DOMParser().parseFromString(strFromU8(zip[opfPath]), 'application/xml');
    title = opf.querySelector('title')?.textContent?.trim() || '';
    const manifest = new Map();
    opf.querySelectorAll('manifest > item').forEach((it) => {
      manifest.set(it.getAttribute('id'), { href: it.getAttribute('href'), type: it.getAttribute('media-type') });
    });
    opf.querySelectorAll('spine > itemref').forEach((ir) => {
      const it = manifest.get(ir.getAttribute('idref'));
      if (it?.href) spineFiles.push(decodeURIComponent(opfDir + it.href));
    });
  }
  if (!spineFiles.length) {
    spineFiles = Object.keys(zip).filter((k) => /\.x?html?$/i.test(k)).sort();
  }
  const blocks = [];
  for (const f of spineFiles) {
    const raw = zip[f];
    if (!raw) continue;
    const { blocks: chBlocks } = parseHtml(strFromU8(raw));
    if (blocks.length) blocks.push({ type: 'pagebreak' });
    blocks.push(...chBlocks);
  }
  if (!blocks.length) throw new Error('EPUB 中没有可提取的文本');
  return { blocks, title };
}

// --- ODF（odt/ods/odp/odg 共用 content.xml） ---

export function parseOdf(bytes, kind = 'odt') {
  let zip;
  try {
    zip = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new Error('无法读取 ODF（ZIP）结构');
  }
  const content = zip['content.xml'] ?? zip['Content.xml'];
  if (!content) throw new Error('ODF 缺少 content.xml');
  const doc = new DOMParser().parseFromString(strFromU8(content), 'application/xml');
  const NS = {
    text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  };
  const q = (el, name) => el.getElementsByTagNameNS(NS[name.split(':')[0]], name.split(':')[1]);
  const blocks = [];
  const textOf = (el) => {
    let out = '';
    const walkNode = (n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue || '';
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.localName === 's') out += ' '.repeat(Number(n.getAttributeNS(NS.text, 'c') || 1));
        else if (n.localName === 'tab') out += '    ';
        else if (n.localName === 'line-break') out += '\n';
        for (const c of n.childNodes) walkNode(c);
      }
    };
    for (const c of el.childNodes) walkNode(c);
    return out;
  };
  const pushPara = (el, forced) => {
    const t = textOf(el).trim();
    if (!t) return;
    if (forced) return blocks.push({ type: forced, text: t });
    const isH = el.localName === 'h';
    if (isH) {
      const lvl = Math.min(3, Number(el.getAttributeNS(NS.text, 'outline-level') || 1) || 1);
      blocks.push({ type: `h${lvl}`, text: t });
    } else if (el.localName === 'p') {
      // ODP 的演讲者备注等场景中,普通段落
      blocks.push({ type: 'p', text: t });
    }
  };
  const body = doc.getElementsByTagNameNS(NS.office, 'body')[0];
  if (!body) throw new Error('ODF 缺少 body');
  const kindBody = body.firstElementChild;
  const kindName = kindBody?.localName || kind;
  if (kindName === 'spreadsheet') {
    for (const table of q(body, 'table:table')) {
      const rows = [];
      for (const tr of q(table, 'table:table-row')) {
        const cells = [];
        for (const tc of q(tr, 'table:table-cell')) {
          const rep = Number(tc.getAttributeNS(NS.table, 'number-columns-repeated') || 1);
          const t = textOf(tc).trim();
          for (let r = 0; r < Math.min(rep, 50); r++) cells.push(t);
        }
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.length) rows.push(cells);
      }
      if (rows.length) blocks.push({ type: 'table', rows });
    }
  } else if (kindName === 'presentation' || kindName === 'drawing') {
    for (const page of q(body, 'draw:page')) {
      for (const frame of q(page, 'draw:frame')) {
        // 演讲者备注不进入 PDF（presentation:class 是属性不是元素）
        if (frame.getAttributeNS(NS.presentation, 'class') === 'notes') continue;
        for (const p of frame.getElementsByTagNameNS(NS.text, 'p')) pushPara(p);
        for (const h of frame.getElementsByTagNameNS(NS.text, 'h')) pushPara(h);
      }
      blocks.push({ type: 'pagebreak' });
    }
    while (blocks.length && blocks[blocks.length - 1].type === 'pagebreak') blocks.pop();
  } else {
    // text：按文档顺序遍历 h/p
    const bodyEl = kindBody || body;
    for (const el of bodyEl.getElementsByTagName('*')) {
      if (el.localName === 'h' || el.localName === 'p') pushPara(el);
    }
  }
  if (!blocks.length) throw new Error('ODF 中没有可提取的文本');
  return { blocks };
}

// --- XLSX ---

export function parseXlsx(bytes) {
  let zip;
  try {
    zip = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new Error('无法读取 XLSX（ZIP）结构');
  }
  const parser = new DOMParser();
  // 共享字符串
  const shared = [];
  if (zip['xl/sharedStrings.xml']) {
    const ss = parser.parseFromString(strFromU8(zip['xl/sharedStrings.xml']), 'application/xml');
    for (const si of ss.getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent || '').join(''));
    }
  }
  // 第一张工作表（workbook.xml 顺序）
  let sheetPath = Object.keys(zip).find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k))
    || Object.keys(zip).find((k) => /^xl\/worksheets\/.*\.xml$/i.test(k));
  if (!sheetPath) throw new Error('XLSX 中没有工作表');
  const ws = parser.parseFromString(strFromU8(zip[sheetPath]), 'application/xml');
  const colName = (ref) => {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return 0;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return c - 1;
  };
  const rows = [];
  for (const rowEl of ws.getElementsByTagName('row')) {
    const cells = [];
    for (const c of rowEl.getElementsByTagName('c')) {
      const idx = colName(c.getAttribute('r'));
      const t = c.getAttribute('t');
      let val = '';
      if (t === 's') {
        const v = c.getElementsByTagName('v')[0]?.textContent;
        val = shared[Number(v)] ?? '';
      } else if (t === 'inlineStr') {
        val = [...c.getElementsByTagName('t')].map((n) => n.textContent || '').join('');
      } else {
        val = c.getElementsByTagName('v')[0]?.textContent ?? '';
      }
      for (let k = cells.length; k < idx; k++) cells.push('');
      cells[idx] = String(val).trim();
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) throw new Error('工作表中没有数据');
  return { blocks: [{ type: 'table', rows }] };
}

/** 按文件名/字节自动选择解析器（供转换工具直接调用） */
export function parseToBlocks(name, bytes) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  switch (ext) {
    case 'txt': case 'text': case 'log': case 'csv':
      return ext === 'csv' ? csvToBlocks(decodeText(bytes)) : { blocks: linesToBlocks(decodeText(bytes)) };
    case 'md': case 'markdown':
      return parseMarkdown(decodeText(bytes));
    case 'rtf':
      return parseRtf(decodeText(bytes));
    case 'epub':
      return parseEpub(bytes);
    case 'html': case 'htm': case 'mhtml': case 'xhtml':
      return parseHtml(decodeText(bytes));
    case 'odt': case 'ods': case 'odp': case 'odg':
      return parseOdf(bytes, ext);
    case 'xlsx':
      return parseXlsx(bytes);
    default:
      throw new Error(`暂不支持的格式 .${ext}（支持 txt/csv/md/rtf/epub/html/odt/ods/odp/odg/xlsx）`);
  }
}

function linesToBlocks(text) {
  const blocks = [];
  for (const l of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    blocks.push({ type: 'p', text: l.replace(/\t/g, '    ') });
  }
  return blocks; // 调用方 parseToBlocks 已包 { blocks }，此处返回数组
}

function csvToBlocks(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  while (rows.length && !rows[rows.length - 1].some((c) => c.trim())) rows.pop();
  return { blocks: rows.length ? [{ type: 'table', rows }] : [] };
}
