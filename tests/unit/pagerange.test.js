import { describe, it, expect } from 'vitest';
import { parsePageRange, splitGroups } from '../../src/core/pagerange.js';

describe('parsePageRange', () => {
  it('基础与组合', () => {
    expect(parsePageRange('2', 5).pages).toEqual([1]);
    expect(parsePageRange('1-3', 5).pages).toEqual([0, 1, 2]);
    expect(parsePageRange('1-3,5', 5).pages).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('3-1', 5).pages).toEqual([2, 1, 0]);
    expect(parsePageRange('1,1,2', 5).pages).toEqual([0, 1]);
  });
  it('关键词', () => {
    expect(parsePageRange('all', 3).pages).toEqual([0, 1, 2]);
    expect(parsePageRange('odd', 5).pages).toEqual([0, 2, 4]);
    expect(parsePageRange('even', 5).pages).toEqual([1, 3]);
    expect(parsePageRange('last', 4).pages).toEqual([3]);
    expect(parsePageRange('', 3).pages).toEqual([0, 1, 2]);
    expect(parsePageRange('2-n', 4).pages).toEqual([1, 2, 3]);
  });
  it('中文分隔符与空白', () => {
    expect(parsePageRange('1，3', 5).pages).toEqual([0, 2]);
    expect(parsePageRange(' 1 - 3 , 5 ', 5).pages).toEqual([0, 1, 2, 4]);
  });
  it('越界与非法', () => {
    expect(parsePageRange('0', 3).ok).toBe(false);
    expect(parsePageRange('4', 3).ok).toBe(false);
    expect(parsePageRange('1-9', 3).ok).toBe(false);
    expect(parsePageRange('abc', 3).ok).toBe(false);
    expect(parsePageRange('1-x', 3).ok).toBe(false);
  });
});

describe('splitGroups', () => {
  it('each', () => {
    expect(splitGroups(3, { kind: 'each' })).toEqual([[0], [1], [2]]);
  });
  it('every N', () => {
    expect(splitGroups(5, { kind: 'every', n: 2 })).toEqual([[0, 1], [2, 3], [4]]);
  });
  it('ranges', () => {
    expect(splitGroups(5, { kind: 'ranges', groups: ['1-2', '4'] })).toEqual([[0, 1], [3]]);
  });
  it('非法组抛错', () => {
    expect(() => splitGroups(2, { kind: 'ranges', groups: ['9'] })).toThrow();
  });
});
