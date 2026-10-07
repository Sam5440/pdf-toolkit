// 最近使用记录单测：置顶去重/上限截断/单删/清空（node 环境无 localStorage，内存态行为）
import { describe, it, expect, beforeEach } from 'vitest';
import { getRecent, pushRecent, removeRecent, clearRecent, RECENT_MAX } from '../../src/core/recent.js';

beforeEach(() => {
  clearRecent();
});

describe('pushRecent', () => {
  it('新 id 置顶；重复 id 去重并重新置顶', () => {
    pushRecent('a');
    pushRecent('b');
    pushRecent('c');
    expect(getRecent()).toEqual(['c', 'b', 'a']);
    pushRecent('a');
    expect(getRecent()).toEqual(['a', 'c', 'b']);
  });

  it('重复记录已有栈顶不产生变更', () => {
    pushRecent('a');
    expect(pushRecent('a')).toBe(false);
    expect(getRecent()).toEqual(['a']);
  });

  it('超过上限截断到 RECENT_MAX（10）', () => {
    for (let i = 0; i < RECENT_MAX + 5; i++) pushRecent(`t${i}`);
    const list = getRecent();
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toBe(`t${RECENT_MAX + 4}`); // 最新在前
    expect(list).not.toContain('t0');
  });

  it('空 id 忽略', () => {
    expect(pushRecent('')).toBe(false);
    expect(getRecent()).toEqual([]);
  });
});

describe('removeRecent / clearRecent', () => {
  it('删除单条记录，其余保留', () => {
    ['a', 'b', 'c'].forEach(pushRecent);
    expect(removeRecent('b')).toBe(true);
    expect(getRecent()).toEqual(['c', 'a']);
    expect(removeRecent('b')).toBe(false);
  });

  it('清空全部', () => {
    ['a', 'b'].forEach(pushRecent);
    clearRecent();
    expect(getRecent()).toEqual([]);
  });
});
