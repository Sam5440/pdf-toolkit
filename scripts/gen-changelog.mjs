// 构建期更新日志生成：读 git log（含每次提交的本地时间），输出 changelog.json 到 dist/。
// 设置面板「关于」运行时 fetch 该文件展示；无 git 环境下优雅降级为空提交列表。
// 也可手动运行：node scripts/gen-changelog.mjs <输出路径>
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 解析 git log --pretty=format:%h|%ad|%s 输出（subject 内可含 |，按前两个分隔符切分）。
 * @param {string} out
 * @returns {Array<{hash:string, date:string, subject:string}>}
 */
export function parseGitLog(out) {
  return String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i1 = line.indexOf('|');
      const i2 = line.indexOf('|', i1 + 1);
      if (i1 <= 0 || i2 < 0) return null;
      const hash = line.slice(0, i1);
      const date = line.slice(i1 + 1, i2);
      const subject = line.slice(i2 + 1);
      if (!hash || !date || !subject) return null;
      return { hash, date, subject };
    })
    .filter(Boolean);
}

/**
 * 生成更新日志数据（最近提交在前）。
 * @param {{maxCommits?:number, version?:string, commit?:string, buildDate?:string, run?:Function}} opts
 */
export function buildChangelog(opts = {}) {
  const { maxCommits = 300, version = '', commit = '', buildDate = '' } = opts;
  let out = '';
  try {
    const run = opts.run || ((args) => execFileSync('git', args, { encoding: 'utf-8' }));
    out = run([
      'log', `--max-count=${maxCommits}`,
      '--date=format-local:%Y-%m-%d %H:%M',
      '--pretty=format:%h|%ad|%s',
    ]);
  } catch {
    out = '';
  }
  return {
    version,
    commit,
    buildDate,
    generatedAt: new Date().toISOString(),
    commits: parseGitLog(out),
  };
}

// CLI：node scripts/gen-changelog.mjs dist/changelog.json
if (process.argv[1] && resolve(process.argv[1]) === import.meta.url.replace('file://', '').split('?')[0]) {
  const dest = resolve(process.argv[2] || 'dist/changelog.json');
  const data = buildChangelog({
    version: process.env.npm_package_version || '',
  });
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(data));
  console.log(`changelog: ${data.commits.length} commits → ${dest}`);
}
