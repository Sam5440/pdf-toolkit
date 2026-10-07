// 暂存区数据层单测：入架/去重/全类型收件/产物包装/文件夹管理/移除/订阅/拖放还原
// （node 环境无 indexedDB：持久层自动降级为 no-op，持久化行为归 e2e 覆盖）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TRAY_MIME, addToTray, addFilesToTray, addResultArtifacts,
  removeFromTray, clearTray, trayItems, trayCount, trayBytes,
  getTrayItem, resolveTrayFiles, onTrayChange, isPdf, isPreviewable,
  trayFolders, createTrayFolder, setTrayItemFolder, renameTrayFolder,
  removeTrayFolder, normalizeFolderPath,
} from '../../src/core/tray.js';

function pdfFile(name = 'a.pdf', size = 1234) {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

beforeEach(() => {
  clearTray();
});

describe('isPdf / isPreviewable 判定', () => {
  it('按扩展名或 MIME 判定', () => {
    expect(isPdf('a.pdf', '')).toBe(true);
    expect(isPdf('A.PDF', '')).toBe(true);
    expect(isPdf('a', 'application/pdf')).toBe(true);
    expect(isPdf('a.png', 'image/png')).toBe(false);
    expect(isPdf('a.pdfx', '')).toBe(false);
  });

  it('isPreviewable：PDF 与图片可预览，其他类型不可', () => {
    expect(isPreviewable({ name: 'a.pdf', mime: 'application/pdf' })).toBe(true);
    expect(isPreviewable({ name: 'a.png', mime: 'image/png' })).toBe(true);
    expect(isPreviewable({ name: 'a.jpg', mime: '' })).toBe(true);
    expect(isPreviewable({ name: 'a.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe(false);
  });
});

describe('addToTray / addFilesToTray', () => {
  it('入架并记录元数据，同一 File 重复入架返回原项', () => {
    const f = pdfFile();
    const a = addToTray(f, { source: 'upload' });
    const b = addToTray(f, { source: 'result' });
    expect(b.id).toBe(a.id);
    expect(trayCount()).toBe(1);
    expect(a.source).toBe('upload');
    expect(a.mime).toBe('application/pdf');
  });

  it('不同 File 对象同名也各自入架', () => {
    addToTray(pdfFile('a.pdf'));
    addToTray(pdfFile('a.pdf'));
    expect(trayCount()).toBe(2);
  });

  it('addFilesToTray 接受全部类型（PDF/图片/文档）', () => {
    const added = addFilesToTray([
      pdfFile('a.pdf'),
      new File([new Uint8Array(4)], 'b.png', { type: 'image/png' }),
      new File([new Uint8Array(8)], 'c.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    ], { source: 'upload' });
    expect(added.length).toBe(3);
    expect(trayCount()).toBe(3);
  });

  it('缺失 MIME 的产物按扩展名补齐（png → image/png）', () => {
    addToTray(new File([new Uint8Array(4)], 'b.png', { type: '' }));
    expect(trayItems()[0].mime).toBe('image/png');
  });
});

describe('addResultArtifacts（引擎产物入口）', () => {
  it('PDF/图片产物包装为 File 入架，缺失字节跳过', () => {
    const n = addResultArtifacts([
      { name: '合并.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) },
      { name: '页_1.jpg', mime: 'image/jpeg', bytes: new Uint8Array([4]) },
      { name: '无字节.pdf', mime: 'application/pdf' },
      { name: '无MIME.pdf', bytes: new Uint8Array([5]) },
    ]);
    expect(n).toBe(3);
    expect(trayCount()).toBe(3);
    const items = trayItems();
    expect(items[0].source).toBe('result');
    expect(items[0].file).toBeInstanceOf(File);
    expect(items[0].file.size).toBe(3);
    expect(items[0].name).toBe('合并.pdf');
  });

  it('Blob 产物同样入架，无 mime 的产物按扩展名识别并补 application/pdf', () => {
    addResultArtifacts([{ name: 'x.pdf', bytes: new Blob([new Uint8Array([9])]) }]);
    const it = trayItems()[0];
    expect(it.mime).toBe('application/pdf');
    expect(it.size).toBe(1);
  });

  it('已在暂存区的 File 再次作为产物传入不重复入架', () => {
    addResultArtifacts([{ name: 'x.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }]);
    const f = trayItems()[0].file;
    const n = addResultArtifacts([{ name: 'x.pdf', mime: 'application/pdf', bytes: f }]);
    expect(n).toBe(0);
    expect(trayCount()).toBe(1);
  });

  it('folder 选项把产物归档到指定文件夹', () => {
    addResultArtifacts(
      [{ name: 'p1.png', mime: 'image/png', bytes: new Uint8Array([1]) }, { name: 'p2.png', mime: 'image/png', bytes: new Uint8Array([2]) }],
      { folder: 'PDF 转图片 · 测试' },
    );
    expect(trayFolders().map((f) => f.path)).toEqual(['PDF 转图片 · 测试']);
    expect(trayItems().every((i) => i.folder === 'PDF 转图片 · 测试')).toBe(true);
  });

  it('空/非法入参安全返回 0', () => {
    expect(addResultArtifacts(undefined)).toBe(0);
    expect(addResultArtifacts([])).toBe(0);
    expect(addResultArtifacts([null])).toBe(0);
  });
});

describe('文件夹管理', () => {
  it('normalizeFolderPath 规范化路径', () => {
    expect(normalizeFolderPath(' /a//b/ ')).toBe('a/b');
    expect(normalizeFolderPath('')).toBe('');
    expect(normalizeFolderPath('///')).toBe('');
  });

  it('createTrayFolder 幂等，trayFolders 带条目统计', () => {
    expect(createTrayFolder('归档')).toBe(true);
    expect(createTrayFolder('归档')).toBe(false);
    addToTray(pdfFile('a.pdf'), { folder: '归档' });
    const fs = trayFolders();
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ path: '归档', count: 1 });
  });

  it('setTrayItemFolder 移动条目；目标不存在时自动创建', () => {
    const a = addToTray(pdfFile('a.pdf'));
    expect(setTrayItemFolder(a.id, '新分类')).toBe(true);
    expect(trayItems()[0].folder).toBe('新分类');
    expect(trayFolders().map((f) => f.path)).toContain('新分类');
    expect(setTrayItemFolder(a.id, '')).toBe(true);
    expect(trayItems()[0].folder).toBe('');
  });

  it('renameTrayFolder 级联子路径改名', () => {
    const a = addToTray(pdfFile('a.pdf'), { folder: '工作/子集' });
    createTrayFolder('工作');
    createTrayFolder('工作/子集');
    const n = renameTrayFolder('工作', '归档');
    expect(n).toBe(1);
    expect(trayItems()[0].folder).toBe('归档/子集');
    expect(trayFolders().map((f) => f.path).sort()).toEqual(['归档', '归档/子集']);
    expect(a.id).toBeTruthy();
  });

  it('renameTrayFolder 拒绝移进自身子目录与重名目标', () => {
    createTrayFolder('工作');
    createTrayFolder('其他');
    expect(renameTrayFolder('工作', '工作/深层')).toBe(0);
    expect(renameTrayFolder('工作', '其他')).toBe(0);
  });

  it('removeTrayFolder 把条目移回根目录并删除文件夹', () => {
    addToTray(pdfFile('a.pdf'), { folder: '临时' });
    expect(removeTrayFolder('临时')).toBe(1);
    expect(trayItems()[0].folder).toBe('');
    expect(trayFolders()).toHaveLength(0);
    expect(removeTrayFolder('不存在')).toBe(0);
  });

  it('清空同时清空文件夹', () => {
    addToTray(pdfFile('a.pdf'), { folder: 'x' });
    clearTray();
    expect(trayFolders()).toHaveLength(0);
  });
});

describe('移除 / 清空 / 统计', () => {
  it('removeFromTray 移除指定项并返回是否成功', () => {
    const a = addToTray(pdfFile('a.pdf'));
    const b = addToTray(pdfFile('b.pdf'));
    expect(removeFromTray(a.id)).toBe(true);
    expect(removeFromTray(a.id)).toBe(false);
    expect(trayItems().map((i) => i.id)).toEqual([b.id]);
  });

  it('trayBytes 汇总大小，clearTray 清空', () => {
    addToTray(pdfFile('a.pdf', 100));
    addToTray(pdfFile('b.pdf', 50));
    expect(trayBytes()).toBe(150);
    clearTray();
    expect(trayCount()).toBe(0);
    expect(trayBytes()).toBe(0);
  });

  it('getTrayItem 按 id 查找，找不到返回 null', () => {
    const a = addToTray(pdfFile());
    expect(getTrayItem(a.id).name).toBeTruthy();
    expect(getTrayItem('nope')).toBeNull();
  });
});

describe('订阅与拖放还原', () => {
  it('入架/移除/清空触发订阅回调', () => {
    const fn = vi.fn();
    onTrayChange(fn);
    const a = addToTray(pdfFile());
    removeFromTray(a.id);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('取消订阅后不再回调；回调抛错不影响其他订阅者', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    const off1 = onTrayChange(bad);
    const off2 = onTrayChange(ok);
    off1();
    expect(() => addToTray(pdfFile())).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    off2();
  });

  it('resolveTrayFiles 按 id 还原 File，未知 id 跳过', () => {
    const a = addToTray(pdfFile('a.pdf'));
    const b = addToTray(pdfFile('b.pdf'));
    const files = resolveTrayFiles([a.id, 'missing', b.id]);
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('TRAY_MIME 为约定的拖放数据类型', () => {
    expect(TRAY_MIME).toBe('application/x-pdf-toolkit-tray');
  });
});
