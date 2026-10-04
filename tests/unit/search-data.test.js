// 全局搜索数据与检索逻辑单测：64 个工具的关键词/介绍全覆盖 + 匹配冒烟
import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../src/tools/core.js';
import '../../src/tools/registry.js';
import { SEARCH_INTROS, SEARCH_KEYWORDS } from '../../src/core/search-data.js';
import { search } from '../../src/components/search.js';

describe('搜索数据完整性', () => {
  it('每个注册工具都有完整介绍与关键词', () => {
    expect(TOOLS.length).toBeGreaterThan(60);
    for (const t of TOOLS) {
      const intro = SEARCH_INTROS[t.id];
      expect(intro, `工具 ${t.id} 缺少介绍`).toBeTruthy();
      expect(intro.length, `工具 ${t.id} 介绍过短`).toBeGreaterThanOrEqual(12);
      const kws = SEARCH_KEYWORDS[t.id];
      expect(Array.isArray(kws), `工具 ${t.id} 缺少关键词`).toBe(true);
      expect(kws.length, `工具 ${t.id} 关键词不足 6 个`).toBeGreaterThanOrEqual(6);
    }
  });

  it('搜索数据没有孤儿键（全部对应真实工具）', () => {
    const ids = new Set(TOOLS.map((t) => t.id));
    for (const id of Object.keys(SEARCH_INTROS)) expect(ids.has(id), `SEARCH_INTROS 孤儿键: ${id}`).toBe(true);
    for (const id of Object.keys(SEARCH_KEYWORDS)) expect(ids.has(id), `SEARCH_KEYWORDS 孤儿键: ${id}`).toBe(true);
  });

  it('关键词与介绍中不包含工具 id 本身以外的误植占位', () => {
    for (const kws of Object.values(SEARCH_KEYWORDS)) {
      for (const k of kws) expect(typeof k).toBe('string');
    }
  });
});

describe('搜索检索逻辑', () => {
  it('按名称命中：压缩 → PDF 压缩排最前', () => {
    const r = search('压缩');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].item.id).toBe('compress');
  });

  it('按关键词命中：word → PDF 转 Word 在结果中', () => {
    const r = search('word');
    expect(r.some((x) => x.item.id === 'pdf2word')).toBe(true);
  });

  it('多关键词 AND：转 ppt 命中两个 PPT 工具', () => {
    const r = search('转 ppt');
    expect(r.some((x) => x.item.id === 'pdf2ppt')).toBe(true);
    expect(r.some((x) => x.item.id === 'pdf2pptimg')).toBe(true);
  });

  it('英文关键词：ocr 命中 OCR 工具', () => {
    const r = search('ocr');
    expect(r[0].item.id).toBe('ocr');
  });

  it('无结果时返回空列表（面板显示空态）', () => {
    expect(search('zzzz不存在的功能qqq')).toHaveLength(0);
  });

  it('空查询返回收藏工具与快捷操作', () => {
    const r = search('');
    expect(r.some((x) => x.item.kind === 'action')).toBe(true);
    expect(r.some((x) => x.item.kind === 'tool' && x.item.fav)).toBe(true);
    expect(r.every((x) => x.item.kind === 'action' || x.item.fav)).toBe(true);
  });
});
