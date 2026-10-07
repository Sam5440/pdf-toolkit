// 产物命名规则单测：模板令牌/参数截断/时间令牌/区分段提取/多产物改名/去重
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NAMING_TEMPLATE, NAMING_PARAM_MAX,
  opLabel, paramsToken, timeToken, buildOutputName,
  artifactDiscriminator, applyNamingToArtifacts,
} from '../../src/core/naming.js';

describe('opLabel', () => {
  it('已知 op 映射中文操作名，未知 op 回退末段', () => {
    expect(opLabel('compress.run')).toBe('压缩');
    expect(opLabel('pages.split')).toBe('拆分');
    expect(opLabel('pdf.unknownOp')).toBe('unknownOp');
    expect(opLabel('')).toBe('处理');
  });
});

describe('paramsToken', () => {
  it('拼接原始类型参数，跳过文档句柄/大对象/敏感键', () => {
    const args = {
      docId: 'doc_1', docIds: ['a'], limits: {}, spec: { layers: [] },
      items: [], quality: 70, grayscale: true, mode: 'deep',
      password: 'x', apiToken: 'y',
    };
    const s = paramsToken(args);
    expect(s.startsWith('quality=70')).toBe(true); // 超 10 字符截断
    expect(s.length).toBeLessThanOrEqual(NAMING_PARAM_MAX);
  });

  it('短参数串完整保留，多键逗号连接', () => {
    expect(paramsToken({ a: '1', b: '2' })).toBe('a=1,b=2');
    expect(paramsToken({ mode: 'a4' })).toBe('mode=a4');
  });

  it('参数串超过 10 字符按 10 截断', () => {
    const s = paramsToken({ quality: 70, dpi: 200 });
    expect(s.length).toBeLessThanOrEqual(NAMING_PARAM_MAX);
    expect(s.startsWith('quality=70')).toBe(true);
  });

  it('空参数/无可用参数返回空串', () => {
    expect(paramsToken(null)).toBe('');
    expect(paramsToken({})).toBe('');
    expect(paramsToken({ docId: 'x' })).toBe('');
  });
});

describe('timeToken', () => {
  it('本地时区 YYYYMMDD-HHmm', () => {
    expect(timeToken(new Date(2026, 9, 7, 15, 8, 30))).toBe('20261007-1508');
  });
});

describe('buildOutputName', () => {
  it('默认模板：原名-操作-参数-时间', () => {
    expect(buildOutputName({
      name: '报告.pdf', op: '压缩', params: 'quality=70', time: '20261007-1508',
    })).toBe('报告-压缩-quality=70-20261007-1508');
  });

  it('空参数段自动折叠，不产生连续分隔符', () => {
    expect(buildOutputName({ name: 'a.pdf', op: '合并', params: '', time: 't' })).toBe('a-合并-t');
    expect(buildOutputName({ name: 'a.pdf', op: '合并', time: 't', template: '{name}-{op}-{params}-{time}' })).toBe('a-合并-t');
    expect(buildOutputName({ name: 'a.pdf', op: '合并', time: 't', template: '{params}-{name}-{op}' })).toBe('a-合并');
  });

  it('自定义模板与 {i} 序号令牌生效', () => {
    expect(buildOutputName({
      name: 'a.pdf', op: '拆分', time: 't', index: '01',
      template: '{op}_{name}_{i}',
    })).toBe('拆分_a_01');
  });

  it('非法字符安全化（sanitizeFilename）', () => {
    const nm = buildOutputName({ name: 'a/b:c.pdf', op: '压缩', params: '', time: 't' });
    expect(nm).not.toMatch(/[/ :]/);
  });
});

describe('artifactDiscriminator', () => {
  it('从引擎产物名剥离 base 前缀提取区分段', () => {
    expect(artifactDiscriminator('报告_p001_图01.png', '报告')).toBe('p001_图01');
    expect(artifactDiscriminator('报告_第1-3页.pdf', '报告')).toBe('第1-3页');
    expect(artifactDiscriminator('无关名字.pdf', '报告')).toBe('');
    expect(artifactDiscriminator('报告.pdf', '报告')).toBe('');
    expect(artifactDiscriminator('x.pdf', '')).toBe('');
  });
});

describe('applyNamingToArtifacts', () => {
  const docs = new Map([['doc_1', { name: '报告.pdf' }]]);

  it('单产物：完整规则名（原名-操作-参数-时间）', () => {
    const arts = [{ name: '报告_压缩.pdf', bytes: new Uint8Array(8) }];
    applyNamingToArtifacts(arts, { op: 'compress.run', args: { docId: 'doc_1', quality: 70 }, docs, now: new Date(2026, 9, 7, 15, 8).getTime() });
    expect(arts[0].name).toBe('报告-压缩-quality=70-20261007-1508.pdf');
  });

  it('多产物：保留引擎逐项区分段（页码/图序），保证唯一', () => {
    const arts = [
      { name: '报告_p001.png', bytes: new Uint8Array(1) },
      { name: '报告_p002.png', bytes: new Uint8Array(1) },
    ];
    applyNamingToArtifacts(arts, { op: 'pdf.toImages', args: { docId: 'doc_1', dpi: 200 }, docs, now: new Date(2026, 9, 7, 15, 8).getTime() });
    expect(arts[0].name).toBe('报告-转图片-dpi=200-20261007-1508-p001.png');
    expect(arts[1].name).toBe('报告-转图片-dpi=200-20261007-1508-p002.png');
  });

  it('多产物但提取不到区分段时回退 01/02 序号', () => {
    const arts = [{ name: '未知来源.jpg' }, { name: '未知来源.jpg' }];
    applyNamingToArtifacts(arts, { op: 'pages.merge', args: {}, docs: null, now: new Date(2026, 9, 7, 15, 8).getTime() });
    expect(arts[0].name).toContain('-01.jpg');
    expect(arts[1].name).toContain('-02.jpg');
    expect(arts[0].name).not.toBe(arts[1].name);
  });

  it('同名多产物继续去重加 (n) 后缀', () => {
    const arts = [{ name: '报告_p001.png' }, { name: '报告_p001.png' }];
    applyNamingToArtifacts(arts, { op: 'pdf.toImages', args: { docId: 'doc_1' }, docs, now: new Date(2026, 9, 7, 15, 8).getTime() });
    expect(arts[1].name).toMatch(/\(2\)\.png$/);
  });

  it('空产物列表与缺 docs 时不抛错（{name} 回退产物自身名）', () => {
    expect(applyNamingToArtifacts([], { op: 'compress.run', args: {} })).toEqual([]);
    const arts = [{ name: '单独文档_水印.pdf' }];
    applyNamingToArtifacts(arts, { op: 'wm.apply', args: {}, docs: new Map(), now: new Date(2026, 9, 7, 15, 8).getTime() });
    expect(arts[0].name).toBe('单独文档_水印-水印-20261007-1508.pdf');
  });

  it('默认模板常量符合用户规则', () => {
    expect(DEFAULT_NAMING_TEMPLATE).toBe('{name}-{op}-{params}-{time}');
  });
});
