// 文件剪贴板单测：格式计划 / MIME 扩展名 / 剪贴板读取提取（纯函数；用户链路归 e2e）
import { describe, it, expect } from 'vitest';
import {
  customFormatName, extFromMime, planCopyFormats, clipboardFilesFromItems,
} from '../../src/tools/more/clipboard-files.js';

describe('customFormatName', () => {
  it('标准 MIME 加 web 前缀；大小写与参数被规范化', () => {
    expect(customFormatName('application/pdf')).toBe('web application/pdf');
    expect(customFormatName('IMAGE/PNG;charset=utf-8')).toBe('web image/png');
    expect(customFormatName(' text/plain ')).toBe('web text/plain');
  });

  it('空 / 非法类型回退 octet-stream', () => {
    expect(customFormatName('')).toBe('web application/octet-stream');
    expect(customFormatName(null)).toBe('web application/octet-stream');
    expect(customFormatName('not-a-mime')).toBe('web application/octet-stream');
  });
});

describe('extFromMime', () => {
  it('常见映射与未知子类型', () => {
    expect(extFromMime('application/pdf')).toBe('pdf');
    expect(extFromMime('image/svg+xml')).toBe('svg');
    expect(extFromMime('image/jpeg')).toBe('jpg');
    expect(extFromMime('application/x-foo')).toBe('foo');
    expect(extFromMime('video/quicktime')).toBe('mov');
  });

  it('空 / 完全未知回退 bin', () => {
    expect(extFromMime('')).toBe('bin');
    expect(extFromMime('weird!!')).toBe('bin');
    expect(extFromMime('application/!#$%')).toBe('bin');
  });
});

describe('planCopyFormats', () => {
  const png = { name: 'a.png', type: 'image/png', size: 10 };
  const jpg = { name: 'b.jpg', type: 'image/jpeg', size: 10 };
  const txt = { name: 'c.txt', type: 'text/plain', size: 10 };
  const unknown = { name: 'd', type: '', size: 10 };

  it('图片转 PNG、其余走自定义格式', () => {
    const plan = planCopyFormats([png, txt], { supportsCustom: true });
    expect(plan[0]).toMatchObject({ kind: 'image', fmt: 'image/png', note: expect.stringContaining('原样') });
    expect(plan[1]).toMatchObject({ kind: 'custom', fmt: 'web text/plain' });
  });

  it('第二张图片报错（OS 剪贴板只有一个图像 flavor）', () => {
    const plan = planCopyFormats([png, jpg], { supportsCustom: true });
    expect(plan[0].kind).toBe('image');
    expect(plan[1].kind).toBe('error');
    expect(plan[1].error).toContain('一次只能保留一张图片');
  });

  it('不支持自定义格式的浏览器：非图片报错并提示 Chrome/Edge', () => {
    const plan = planCopyFormats([txt], { supportsCustom: false });
    expect(plan[0].kind).toBe('error');
    expect(plan[0].error).toContain('Chrome / Edge 104+');
  });

  it('未知类型按通用二进制自定义格式', () => {
    const plan = planCopyFormats([unknown], { supportsCustom: true });
    expect(plan[0]).toMatchObject({ kind: 'custom', fmt: 'web application/octet-stream' });
  });
});

describe('clipboardFilesFromItems', () => {
  const mkItem = (types, blobs) => ({
    types,
    getType: async (t) => blobs[t],
  });

  it('自定义格式优先于 text/plain，扩展名按 MIME 推断', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const items = [mkItem(['web application/pdf', 'text/plain'], {
      'web application/pdf': new Blob([pdfBytes], { type: 'application/pdf' }),
      'text/plain': new Blob(['report.pdf（1 KB）'], { type: 'text/plain' }),
    })];
    const files = await clipboardFilesFromItems(items, { stamp: '120000' });
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('剪贴板-120000.pdf');
    expect(files[0].type).toBe('application/pdf');
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(pdfBytes);
  });

  it('仅有 text/plain 时回退存为 txt', async () => {
    const items = [mkItem(['text/plain'], {
      'text/plain': new Blob(['hello 剪贴板'], { type: 'text/plain' }),
    })];
    const files = await clipboardFilesFromItems(items, { stamp: '090500' });
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('剪贴板文本-090500.txt');
    expect(await files[0].text()).toBe('hello 剪贴板');
  });

  it('多条目并行提取：图片 + 自定义格式各成一个文件', async () => {
    const items = [
      mkItem(['image/png'], { 'image/png': new Blob([new Uint8Array([1])], { type: 'image/png' }) }),
      mkItem(['web application/zip'], { 'web application/zip': new Blob([new Uint8Array([2])], { type: 'application/zip' }) }),
    ];
    const files = await clipboardFilesFromItems(items, { stamp: '235959' });
    expect(files.map((f) => f.name)).toEqual(['剪贴板-235959.png', '剪贴板-235959.zip']);
  });

  it('空条目返回空数组（调用方给出提示）', async () => {
    expect(await clipboardFilesFromItems([])).toEqual([]);
    expect(await clipboardFilesFromItems(undefined)).toEqual([]);
  });
});
