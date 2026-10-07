// 更新日志生成器单测：git log 输出解析（含 subject 内 | 与空输出降级）
import { describe, it, expect } from 'vitest';
import { parseGitLog, buildChangelog } from '../../scripts/gen-changelog.mjs';

describe('parseGitLog', () => {
  it('按 hash|date|subject 切分，最近在前保持原序', () => {
    const out = [
      'c3cc09f|2026-10-05 17:56|docs(readme): 首页加在线使用入口',
      'd10d63f|2026-10-05 16:11|feat(ui): 全站交互动画',
    ].join('\n');
    expect(parseGitLog(out)).toEqual([
      { hash: 'c3cc09f', date: '2026-10-05 17:56', subject: 'docs(readme): 首页加在线使用入口' },
      { hash: 'd10d63f', date: '2026-10-05 16:11', subject: 'feat(ui): 全站交互动画' },
    ]);
  });

  it('subject 内含 | 时不切断', () => {
    const out = 'abc1234|2026-10-05 16:11|feat: 支持 a|b 两种模式';
    const rows = parseGitLog(out);
    expect(rows[0].subject).toBe('feat: 支持 a|b 两种模式');
  });

  it('空输出/损坏行降级为空数组', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('noseparator\n|nodate|')).toEqual([]);
    expect(parseGitLog(null)).toEqual([]);
  });
});

describe('buildChangelog', () => {
  it('组合元数据与提交列表（注入 fake run 不依赖真实 git）', () => {
    const data = buildChangelog({
      version: '1.1.0', commit: 'deadbee', buildDate: '2026-10-07',
      run: () => 'deadbee|2026-10-07 10:00|feat: x',
    });
    expect(data.version).toBe('1.1.0');
    expect(data.commit).toBe('deadbee');
    expect(data.buildDate).toBe('2026-10-07');
    expect(data.generatedAt).toBeTruthy();
    expect(data.commits).toHaveLength(1);
    expect(data.commits[0]).toMatchObject({ hash: 'deadbee', subject: 'feat: x' });
  });

  it('git 不可用时优雅降级：commits 为空数组不抛错', () => {
    const data = buildChangelog({ run: () => { throw new Error('not a repo'); } });
    expect(data.commits).toEqual([]);
  });
});
