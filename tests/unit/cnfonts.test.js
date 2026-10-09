// 内置中文字体别名表单测（纯逻辑；不触碰 FontFace/caches/fetch）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CN_FONT_FILES, cnFontIdsForNames, parseFontFamilyList } from '../../src/core/cnfonts.js';

describe('cnfonts 内置中文字体', () => {
  it('覆盖 10 种常见中文字体名（含中英文与 GB2312 变体）', () => {
    const cases = [
      // 宋体系 → noto-serif
      ['SimSun', 'noto-serif'], ['NSimSun', 'noto-serif'], ['宋体', 'noto-serif'], ['新宋体', 'noto-serif'],
      ['STSong', 'noto-serif'], ['STZhongsong', 'noto-serif'], ['华文宋体', 'noto-serif'], ['华文中宋', 'noto-serif'],
      // 黑体系 → noto-sans
      ['SimHei', 'noto-sans'], ['黑体', 'noto-sans'], ['Microsoft YaHei', 'noto-sans'],
      ['MicrosoftYaHei', 'noto-sans'], ['微软雅黑', 'noto-sans'], ['STHeiti', 'noto-sans'],
      ['华文黑体', 'noto-sans'], ['STXihei', 'noto-sans'], ['华文细黑', 'noto-sans'],
      ['DengXian', 'noto-sans'], ['等线', 'noto-sans'],
      // 楷体系 → wenkai
      ['KaiTi', 'wenkai'], ['楷体', 'wenkai'], ['KaiTi_GB2312', 'wenkai'], ['楷体_GB2312', 'wenkai'],
      ['STKaiti', 'wenkai'], ['华文楷体', 'wenkai'],
      // 仿宋系 → zhuque
      ['FangSong', 'zhuque'], ['仿宋', 'zhuque'], ['FangSong_GB2312', 'zhuque'], ['仿宋_GB2312', 'zhuque'],
      ['STFangsong', 'zhuque'], ['华文仿宋', 'zhuque'],
    ];
    for (const [name, id] of cases) {
      expect(cnFontIdsForNames([name]), `${name} → ${id}`).toEqual(new Set([id]));
    }
  });

  it('GBK 字体名（pdf.js latin1 乱码串）也有别名', () => {
    // 宋体/黑体/楷体/仿宋 的 GBK 字节逐字节转 char
    expect(cnFontIdsForNames(['\u00CB\u00CE\u00CC\u00E5'])).toEqual(new Set(['noto-serif'])); // 宋体
    expect(cnFontIdsForNames(['\u00BA\u00DA\u00CC\u00E5'])).toEqual(new Set(['noto-sans'])); // 黑体
    expect(cnFontIdsForNames(['\u00BF\u00AC\u00CC\u00E5'])).toEqual(new Set(['wenkai'])); // 楷体
    expect(cnFontIdsForNames(['\u00B7\u00C2\u00CB\u00CE'])).toEqual(new Set(['zhuque'])); // 仿宋
  });

  it('别名无跨文件冲突；4 个字体文件资产在库', () => {
    const seen = new Map();
    for (const f of CN_FONT_FILES) {
      for (const a of f.aliases) {
        const key = a.toLowerCase();
        expect(seen.has(key) ? `别名 ${a} 重复归属 ${seen.get(key)}/${f.id}` : null).toBeNull();
        seen.set(key, f.id);
      }
    }
    for (const f of CN_FONT_FILES) {
      const p = path.resolve(import.meta.dirname, '../../public/fonts/cn', f.file);
      expect(fs.existsSync(p), `${p} 缺失（跑 python3 scripts/build_cn_fonts.py）`).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(500_000);
    }
    expect(fs.existsSync(path.resolve(import.meta.dirname, '../../public/fonts/cn/LICENSES.md'))).toBe(true);
  });

  it('parseFontFamilyList 解析内联样式且过滤通用族名', () => {
    expect(parseFontFamilyList("font-family: '微软雅黑', DengXian, sans-serif; color:#333")).toEqual(['微软雅黑', 'DengXian']);
    expect(parseFontFamilyList('font-family: "SimHei"')).toEqual(['SimHei']);
    expect(parseFontFamilyList('font-family:serif')).toEqual([]);
    expect(parseFontFamilyList('color:red')).toEqual([]);
    expect(parseFontFamilyList('')).toEqual([]);
    expect(parseFontFamilyList("font-family:'宋体',楷体")).toEqual(['宋体', '楷体']);
  });

  it('cnFontIdsForNames 大小写不敏感、空输入安全', () => {
    expect(cnFontIdsForNames(['simsun'])).toEqual(new Set(['noto-serif']));
    expect(cnFontIdsForNames([])).toEqual(new Set());
    expect(cnFontIdsForNames(undefined)).toEqual(new Set());
  });
});
