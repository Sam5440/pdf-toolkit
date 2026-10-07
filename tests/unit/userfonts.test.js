// 外挂字体家族名解析单测：合成 sfnt name 表（ttf / otf / ttc / 非 sfnt）覆盖纯函数
// （IndexedDB 层归 e2e；node 环境下 listUserFonts 返回空数组不抛错）
import { describe, it, expect } from 'vitest';
import { readFontFamily, isUserFontId, FONT_EXT_RE, getRemoteUrls, setRemoteUrls } from '../../src/core/userfonts.js';

/** 构造最小 sfnt 二进制：tableDirectory 只含 name 表；name 记录按给定记录集 */
function makeSfnt({ family16, family1, platform = 3 } = {}) {
  const enc = new TextEncoder();
  const records = [];
  const strings = [];
  const push = (nameID, s) => {
    records.push({ platform, nameID });
    strings.push(platform === 1 ? enc.encode(s) : utf16be(s));
  };
  if (family16 != null) push(16, family16);
  if (family1 != null) push(1, family1);

  const nameTable = new Uint8Array(6 + records.length * 12 + strings.reduce((s, b) => s + b.length, 0));
  const dv = new DataView(nameTable.buffer);
  dv.setUint16(0, 0); // format
  dv.setUint16(2, records.length);
  dv.setUint16(4, 6 + records.length * 12); // stringOffset
  let sOff = 0;
  records.forEach((r, i) => {
    const rec = 6 + i * 12;
    dv.setUint16(rec, r.platform); // platformID
    dv.setUint16(rec + 2, platform === 1 ? 0 : 1); // encodingID
    dv.setUint16(rec + 4, 0x409); // languageID
    dv.setUint16(rec + 6, r.nameID);
    dv.setUint16(rec + 8, strings[i].length);
    dv.setUint16(rec + 10, sOff);
    nameTable.set(strings[i], 6 + records.length * 12 + sOff);
    sOff += strings[i].length;
  });

  const header = new Uint8Array(12 + 16);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(0, 0x00010000); // sfnt version（TrueType）
  hdv.setUint16(4, 1); // numTables
  hdv.setUint32(12, 0x6e616d65); // 'name'
  hdv.setUint32(20, header.length + nameTable.length - nameTable.length + 0); // offset 占位，下面修正
  // name 表偏移 = 28（12 头 + 16 单条目录）
  hdv.setUint32(20, 28);
  const out = new Uint8Array(28 + nameTable.length);
  out.set(header, 0);
  out.set(nameTable, 28);
  return out;
}

function utf16be(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c >> 8;
    out[i * 2 + 1] = c & 0xff;
  }
  return out;
}

function makeTtc(firstOffset = 44) {
  const inner = makeSfnt({ family1: 'Inner Family' });
  // ttc 头：tag(0-3) version(4-7) numFonts(8-11) + 字体偏移表（首项 @12）
  const container = new Uint8Array(firstOffset + inner.length);
  const dv = new DataView(container.buffer);
  dv.setUint32(0, 0x74746366); // 'ttcf'
  dv.setUint32(8, 1); // numFonts
  dv.setUint32(12, firstOffset);
  container.set(inner, firstOffset);
  return container;
}

describe('readFontFamily', () => {
  it('sfnt platform 3（UTF-16BE）：nameID 16 优先于 1', () => {
    const buf = makeSfnt({ family16: '霞鹜文楷', family1: 'LXGW WenKai' });
    expect(readFontFamily(buf)).toBe('霞鹜文楷');
  });

  it('无 nameID 16 时回退 nameID 1', () => {
    const buf = makeSfnt({ family1: 'Noto Sans SC' });
    expect(readFontFamily(buf)).toBe('Noto Sans SC');
  });

  it('platform 1（ASCII）也能解析', () => {
    const buf = makeSfnt({ family1: 'Arial', platform: 1 });
    expect(readFontFamily(buf)).toBe('Arial');
  });

  it('ttc 集合：取第一个字体的家族名', () => {
    expect(readFontFamily(makeTtc())).toBe('Inner Family');
  });

  it('非 sfnt（woff/woff2/空）返回空串，不抛错', () => {
    const woff = new Uint8Array(16);
    new DataView(woff.buffer).setUint32(0, 0x774F4646); // 'wOFF'
    expect(readFontFamily(woff)).toBe('');
    expect(readFontFamily(new Uint8Array(0))).toBe('');
    expect(readFontFamily(new Uint8Array([1, 2, 3]))).toBe('');
  });
});

describe('杂项', () => {
  it('isUserFontId 只认 user- 前缀', () => {
    expect(isUserFontId('user-abc')).toBe(true);
    expect(isUserFontId('noto-sc')).toBe(false);
    expect(isUserFontId('')).toBe(false);
  });

  it('FONT_EXT_RE 匹配常见字体扩展', () => {
    expect(FONT_EXT_RE.test('a.TTF')).toBe(true);
    expect(FONT_EXT_RE.test('a.woff2')).toBe(true);
    expect(FONT_EXT_RE.test('a.pdf')).toBe(false);
  });

  it('远程 URL 设置：去重、去空行（node 内存态）', () => {
    const urls = setRemoteUrls([' https://a.com/f.ttf ', '', 'https://b.com/g.otf', 'https://a.com/f.ttf']);
    expect(urls).toEqual(['https://a.com/f.ttf', 'https://b.com/g.otf']);
    expect(getRemoteUrls()).toEqual(urls);
  });
});
