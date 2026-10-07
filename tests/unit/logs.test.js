// 运行日志单测：记录/级别过滤/环形上限/持久化/订阅/文本导出
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { log, getLogs, clearLogs, onLogChange, logsToText } from '../../src/core/logs.js';

beforeEach(() => {
  clearLogs();
});

describe('log / getLogs', () => {
  it('记录基础字段，默认 info 级别', () => {
    log('engine', 'op 完成');
    const list = getLogs();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tag: 'engine', msg: 'op 完成', level: 'info' });
    expect(list[0].t).toBeGreaterThan(0);
  });

  it('级别过滤：warn 及以上', () => {
    log('a', 'info1');
    log('a', 'warn1', { level: 'warn' });
    log('a', 'err1', { level: 'error' });
    expect(getLogs({ minLevel: 'warn' }).map((e) => e.msg)).toEqual(['warn1', 'err1']);
    expect(getLogs({ minLevel: 'error' }).map((e) => e.msg)).toEqual(['err1']);
  });

  it('detail 截断到 500 字符', () => {
    log('t', 'm', { detail: 'x'.repeat(2000) });
    expect(getLogs()[0].detail.length).toBe(500);
  });

  it('环形缓冲：超过 500 条丢弃最旧', () => {
    for (let i = 0; i < 520; i++) log('t', `msg-${i}`);
    const list = getLogs();
    expect(list.length).toBe(500);
    expect(list[0].msg).toBe('msg-20');
    expect(list.at(-1).msg).toBe('msg-519');
  });
});

describe('订阅与导出', () => {
  it('每条日志触发订阅回调，取消后不再触发', () => {
    const fn = vi.fn();
    const off = onLogChange(fn);
    log('t', 'one');
    off();
    log('t', 'two');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].msg).toBe('one');
  });

  it('订阅回调抛错不影响日志记录', () => {
    const off = onLogChange(() => { throw new Error('boom'); });
    expect(() => log('t', 'safe')).not.toThrow();
    off();
    expect(getLogs().at(-1).msg).toBe('safe');
  });

  it('clearLogs 清空并触发回调（null 通知）', () => {
    const fn = vi.fn();
    onLogChange(fn);
    log('t', 'x');
    clearLogs();
    expect(getLogs()).toHaveLength(0);
    expect(fn).toHaveBeenLastCalledWith(null);
  });

  it('logsToText 含级别/标签/文案', () => {
    log('engine', 'op 完成', { level: 'warn', detail: '细节' });
    const text = logsToText();
    expect(text).toContain('[WARN]');
    expect(text).toContain('[engine]');
    expect(text).toContain('op 完成 — 细节');
  });
});
