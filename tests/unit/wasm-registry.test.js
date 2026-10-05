// WASM 引擎状态注册表单元测试（node 环境纯状态机，无 DOM / 无引擎依赖）
import { describe, it, expect, beforeEach } from 'vitest';
import {
  defineEngine,
  setEngineStatus,
  engineList,
  onEngines,
  probeEngine,
} from '../../src/core/wasm-registry.js';

describe('wasm-registry', () => {
  // 每个用例在干净注册表上运行：defineEngine 幂等，可重复定义同名引擎
  const defs = [
    { id: 'pdflib', label: 'pdf-lib', desc: '结构核心', size: '内置', probe: async () => {} },
    { id: 'pdfjs', label: 'pdf.js', desc: '渲染', size: '内置', probe: async () => {} },
  ];

  beforeEach(() => {
    for (const e of engineList()) setEngineStatus(e.id, 'idle');
  });

  it('defineEngine 注册后默认 idle，快照为拷贝（外部修改不影响内部）', () => {
    defineEngine(defs[0]);
    const list = engineList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'pdflib', status: 'idle', detail: '' });
    list[0].status = 'ready';
    expect(engineList()[0].status).toBe('idle');
  });

  it('defineEngine 幂等：重复注册不覆盖运行时状态', () => {
    defineEngine(defs[0]);
    setEngineStatus('pdflib', 'ready', 'ok');
    defineEngine({ id: 'pdflib', label: 'pdf-lib', desc: 'x' });
    expect(engineList()[0].status).toBe('ready');
    expect(engineList()[0].desc).toBe('结构核心');
  });

  it('setEngineStatus 驱动状态机并通知订阅者；未知引擎静默忽略', () => {
    defineEngine(defs[0]);
    const seen = [];
    const un = onEngines(() => seen.push(engineList()[0].status));
    setEngineStatus('pdflib', 'loading', '下载中');
    setEngineStatus('pdflib', 'ready', 'v1');
    setEngineStatus('not-registered', 'ready'); // 不应抛错、不通知
    expect(seen).toEqual(['loading', 'ready']);
    expect(engineList()[0]).toMatchObject({ status: 'ready', detail: 'v1' });
    un();
    setEngineStatus('pdflib', 'error', 'x');
    expect(engineList()[0].status).toBe('error'); // 状态仍更新，只是订阅者不再收到通知
  });

  it('ready → loading 允许（多 worker 真实重载如实展示），error 可覆盖任意状态', () => {
    defineEngine(defs[1]);
    setEngineStatus('pdfjs', 'ready', 'v1');
    setEngineStatus('pdfjs', 'loading', '另一 worker 重载中');
    expect(engineList().find((e) => e.id === 'pdfjs').status).toBe('loading');
    setEngineStatus('pdfjs', 'ready', 'v1');
    setEngineStatus('pdfjs', 'error', 'boom');
    expect(engineList().find((e) => e.id === 'pdfjs').status).toBe('error');
  });

  it('probeEngine：正常路径流转由 probe 内部上报，异常路径兜底 error', async () => {
    let calls = 0;
    defineEngine({ id: 'a', label: 'A', probe: async () => { calls++; setEngineStatus('a', 'ready'); } });
    defineEngine({ id: 'b', label: 'B', probe: async () => { throw new Error('boom'); } });
    defineEngine({ id: 'c', label: 'C', probe: async () => { throw new Error('silent'); } });
    await probeEngine('a');
    expect(calls).toBe(1);
    expect(engineList().find((e) => e.id === 'a').status).toBe('ready');
    await probeEngine('b');
    expect(engineList().find((e) => e.id === 'b').status).toBe('error');
    // loading 中重复 probe 直接跳过
    defineEngine({ id: 'd', label: 'D', probe: async () => { setEngineStatus('d', 'loading'); await new Promise((r) => setTimeout(r, 10)); } });
    const p = probeEngine('d');
    await probeEngine('d');
    await p;
    expect(engineList().find((e) => e.id === 'd').status).toBe('loading');
    // 无 probe 的引擎安全跳过
    defineEngine({ id: 'e', label: 'E' });
    await probeEngine('e');
    expect(engineList().find((e) => e.id === 'e').status).toBe('idle');
  });
});
