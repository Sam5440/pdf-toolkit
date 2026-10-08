// 收藏管理单元测试（node 环境：localStorage 缺失 → 内存兜底，持久化由 e2e 覆盖）
import { describe, it, expect, beforeEach } from 'vitest';
import {
  defaultFavoriteIds,
  getFavorites,
  isFavorite,
  isMoreGroup,
  toggleFavorite,
  resetFavorites,
} from '../../src/core/favorites.js';
import { TOOLS, GROUPS } from '../../src/tools/registry.js';

describe('favorites', () => {
  beforeEach(() => resetFavorites());

  it('默认收藏 = 核心工具 + defaultFav 标记工具（15 核心 + 8 个常用扩展工具）', () => {
    const def = defaultFavoriteIds();
    expect(def).toHaveLength(25);
    for (const id of def) expect(isFavorite(id)).toBe(true);
    expect(getFavorites().size).toBe(25);
    expect(isFavorite('crop')).toBe(true); // 裁剪 PDF 默认收藏
    expect(isFavorite('md2pdf')).toBe(true); // Markdown 转 PDF 默认收藏
    expect(isFavorite('pdf2pptimg')).toBe(true); // PDF 转图片型 PPT 默认收藏
    for (const id of ['qrcode-scan', 'hash-calc', 'crypt', 'imgocr', 'filebed']) {
      expect(isFavorite(id)).toBe(true); // 常用小功能批次默认收藏
    }
  });

  it('「更多」工具除 defaultFav 外默认全部不收藏', () => {
    const moreTools = TOOLS.filter((t) => isMoreGroup(t.group));
    expect(moreTools.length).toBe(56);
    for (const t of moreTools) {
      if (t.defaultFav) continue;
      expect(isFavorite(t.id)).toBe(false);
    }
    expect(moreTools.filter((t) => t.defaultFav).map((t) => t.id)).toEqual(
      ['crop', 'md2pdf', 'qrcode-scan', 'hash-calc', 'crypt', 'imgocr', 'filebed', 'image-bed', 'textbed', 'pdf2pptimg'],
    );
  });

  it('切换收藏：加 → 删', () => {
    expect(isFavorite('qrcode')).toBe(false);
    toggleFavorite('qrcode');
    expect(isFavorite('qrcode')).toBe(true);
    toggleFavorite('qrcode');
    expect(isFavorite('qrcode')).toBe(false);
  });

  it('核心工具可取消收藏（首页不再显示的语义）', () => {
    toggleFavorite('compress');
    expect(isFavorite('compress')).toBe(false);
    expect(getFavorites().size).toBe(24);
  });

  it('defaultFav 工具也可取消收藏', () => {
    toggleFavorite('md2pdf');
    expect(isFavorite('md2pdf')).toBe(false);
    expect(getFavorites().size).toBe(24);
  });

  it('resetFavorites 恢复默认（含全部 defaultFav 工具）', () => {
    toggleFavorite('qrcode');
    toggleFavorite('compress');
    toggleFavorite('md2pdf');
    resetFavorites();
    expect(isFavorite('compress')).toBe(true);
    expect(isFavorite('crop')).toBe(true);
    expect(isFavorite('md2pdf')).toBe(true);
    expect(isFavorite('pdf2pptimg')).toBe(true);
    for (const id of ['qrcode-scan', 'hash-calc', 'crypt', 'imgocr', 'filebed']) {
      expect(isFavorite(id)).toBe(true);
    }
    expect(isFavorite('qrcode')).toBe(false);
    expect(getFavorites().size).toBe(25);
  });

  it('isMoreGroup 只认 hiddenOnHome 分组', () => {
    expect(isMoreGroup('m-page')).toBe(true);
    expect(isMoreGroup('m-util')).toBe(true);
    expect(isMoreGroup('optimize')).toBe(false);
    expect(isMoreGroup('not-exist')).toBe(false);
  });

  it('hiddenOnHome 分组共 9 个；默认收藏的扩展工具均带 defaultFav 标记', () => {
    const more = GROUPS.filter((g) => g.hiddenOnHome);
    expect(more.map((g) => g.id).sort()).toEqual(
      ['m-edit', 'm-fix', 'm-frompdf', 'm-img', 'm-page', 'm-secure', 'm-topdf', 'm-util', 'm-view'].sort(),
    );
    const def = new Set(defaultFavoriteIds());
    for (const g of more) {
      for (const t of TOOLS.filter((x) => x.group === g.id)) {
        if (def.has(t.id)) expect(t.defaultFav).toBe(true);
        else expect(t.defaultFav).toBeFalsy();
      }
    }
  });
});
