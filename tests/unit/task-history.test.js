// 任务历史 / 复原 / 工作流 / 用户数据库 单元测试（node 环境，无 DOM；
// 表单快照采集与回填的 DOM 行为由 e2e task-history.spec.js 覆盖）
import { describe, it, expect } from 'vitest';
import { sanitizeOptions } from '../../src/core/history.js';
import { resolveInputs, captureFormSnapshot, capturePageForm } from '../../src/core/tasklog.js';
import { addDocument } from '../../src/core/files.js';
import {
  normalizeStep, normalizeWorkflow, saveWorkflow, listWorkflows, stepFromRecord,
} from '../../src/core/workflows.js';
import { backupName, importAll } from '../../src/core/userdb.js';

describe('history.sanitizeOptions（无损参数 + 敏感键剔除）', () => {
  it('原始值原样保留，嵌套对象/数组结构无损', () => {
    const opts = {
      pages: '1-3',
      dpi: 150,
      nested: { a: 1, list: ['x', 'y'], deep: { ok: true } },
      arr: [{ k: 1 }, 2],
      flag: false,
      empty: null,
    };
    const out = sanitizeOptions(opts);
    expect(out).toEqual(opts); // 结构与值完全一致（不再是 '[对象]' 占位）
    expect(out).not.toBe(opts);
    expect(out.nested).not.toBe(opts.nested);
  });

  it('敏感键（pass/password/pw/secret/token）任意层级整键剔除', () => {
    const out = sanitizeOptions({
      password: 'x', userPw: 'y', apiKeyToken: 'z', MySecret: 's',
      keep: 1,
      inner: { password: 'deep', fine: 2 },
      list: [{ token: 't', v: 3 }],
    });
    expect(out).toEqual({ keep: 1, inner: { fine: 2 }, list: [{ v: 3 }] });
  });

  it('Blob/File 替换为描述串，不可序列化值不炸', () => {
    const blob = new Blob([new Uint8Array(8)], { type: 'application/pdf' });
    const out = sanitizeOptions({ file: blob, n: 1 });
    expect(out.file).toBe('[文件 8 字节]');
    expect(out.n).toBe(1);
  });

  it('循环引用安全', () => {
    const a = { name: 'a' };
    a.self = a;
    const out = sanitizeOptions({ a });
    expect(out.a.name).toBe('a');
    expect(out.a.self).toBe('[循环引用]');
  });
});

describe('tasklog.resolveInputs（输入文件解析）', () => {
  it('显式 docs 直接透传并去重', () => {
    const d1 = { id: 'd1', name: 'a.pdf', size: 3, type: 'application/pdf', file: new Blob(['a']) };
    const out = resolveInputs({ docs: [d1, d1], docNames: ['a.pdf'] });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('a.pdf');
  });

  it('按 docNames 从全局文档注册表补缺（最近添加优先）', () => {
    const f = new Blob(['b']);
    f.name = 'tasklog-missing.pdf';
    const doc = addDocument(new File(['b'], 'tasklog-missing.pdf', { type: 'application/pdf' }));
    const out = resolveInputs({ docs: [], docNames: ['tasklog-missing.pdf'] });
    expect(out.map((d) => d.id)).toContain(doc.id);
    void f;
  });

  it('无命中时返回空数组不抛错', () => {
    expect(resolveInputs({ docs: [], docNames: ['不存在.pdf'] })).toEqual([]);
    expect(resolveInputs({})).toEqual([]);
  });
});

describe('tasklog 表单快照（无 DOM 环境安全降级）', () => {
  it('无 document 时 captureFormSnapshot/capturePageForm 返回空数组', () => {
    expect(captureFormSnapshot(null)).toEqual([]);
    expect(capturePageForm()).toEqual([]);
  });
});

describe('workflows（存储模型清洗）', () => {
  it('normalizeStep：未知工具剔除，已知字段保留清洗', () => {
    expect(normalizeStep({ toolId: 'no-such-tool' })).toBeNull();
    expect(normalizeStep(null)).toBeNull();
    const s = normalizeStep({
      toolId: 'merge', toolName: '合并 PDF', recordId: 'h_x',
      docNames: ['a.pdf'], options: { ranges: '1' }, form: [{ label: '页范围', type: 'text', value: '1' }],
      junk: 'drop',
    });
    expect(s).toMatchObject({ toolId: 'merge', recordId: 'h_x', docNames: ['a.pdf'] });
    expect(s.junk).toBeUndefined();
    expect(s.id).toBeTruthy();
  });

  it('normalizeWorkflow：坏步骤被过滤，全部无效时返回 null', () => {
    const wf = normalizeWorkflow({
      name: 't', steps: [{ toolId: 'merge' }, { toolId: 'ghost' }, 'junk'],
    });
    expect(wf.steps).toHaveLength(1);
    expect(normalizeWorkflow({ name: 'x', steps: 'nope' })).toBeNull();
  });

  it('saveWorkflow → listWorkflows 往返（node 无 localStorage，走内存缓存）', () => {
    const before = listWorkflows().length;
    const wf = saveWorkflow({ name: '单测流水线', steps: [{ toolId: 'merge', toolName: '合并 PDF' }] });
    const again = listWorkflows();
    expect(again.length).toBe(before + 1);
    expect(again.find((w) => w.id === wf.id).name).toBe('单测流水线');
  });

  it('stepFromRecord：未知工具返回 null', () => {
    expect(stepFromRecord({ tool: 'ghost', id: 'h1', form: [] })).toBeNull();
  });
});

describe('userdb（备份包基础）', () => {
  it('backupName 命名格式', () => {
    expect(backupName()).toMatch(/^pdftoolkit-backup-\d{8}-\d{6}\.zip$/);
  });

  it('importAll 拒绝非备份包', async () => {
    const garbage = new Blob([new Uint8Array([1, 2, 3, 4])]);
    await expect(importAll(garbage)).rejects.toThrow();
  });
});
