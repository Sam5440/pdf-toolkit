// 文本行级 diff（比较工具用）
import { diffLines } from 'diff';

function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n');
}

/**
 * 行级差异。返回 [{type:'same'|'add'|'del', count, lines:string[]}]
 * @param {string} a @param {string} b @param {{ignoreWhitespace?:boolean}} opts
 */
export function lineDiff(a, b, opts = {}) {
  const ta = opts.ignoreWhitespace === false ? String(a ?? '') : normalize(a);
  const tb = opts.ignoreWhitespace === false ? String(b ?? '') : normalize(b);
  const parts = diffLines(ta, tb);
  const out = [];
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n').filter((l, i, arr) => !(l === '' && i === arr.length - 1 && part.value.endsWith('\n')));
    if (!lines.length) continue;
    const type = part.added ? 'add' : part.removed ? 'del' : 'same';
    // 合并相邻同类型
    const last = out[out.length - 1];
    if (last && last.type === type) { last.lines.push(...lines); last.count += lines.length; }
    else out.push({ type, count: lines.length, lines });
  }
  return out;
}

/** 每页文本的批量对比：[{pageA,pageB,textA,textB}] → 摘要 */
export function pageTextDiffs(pairs, opts = {}) {
  return pairs.map((p) => {
    const d = lineDiff(p.textA, p.textB, opts);
    const adds = d.filter((x) => x.type === 'add').reduce((s, x) => s + x.count, 0);
    const dels = d.filter((x) => x.type === 'del').reduce((s, x) => s + x.count, 0);
    return {
      pageA: p.pageA, pageB: p.pageB,
      added: adds, removed: dels,
      same: adds === 0 && dels === 0,
      diff: d.filter((x) => x.type !== 'same'),
    };
  });
}
