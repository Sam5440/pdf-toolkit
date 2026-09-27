// 页码范围解析："1-3,5,8-10" / "odd" / "even" / "all" / "last"
// 返回 0 基页序数组（保持书写顺序，可升降序，去重）。

/**
 * @param {string} input 用户输入
 * @param {number} pageCount 总页数（≥1）
 * @returns {{ok:true, pages:number[]}|{ok:false, error:string}}
 */
export function parsePageRange(input, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { ok: false, error: '文档页数无效' };
  }
  const s = String(input ?? '').trim().toLowerCase();
  if (s === '' || s === 'all' || s === '全部' || s === '所有页') {
    return { ok: true, pages: seq(0, pageCount - 1) };
  }
  if (s === 'odd' || s === '奇数页' || s === '奇数') {
    return { ok: true, pages: seq(0, pageCount - 1, 2) };
  }
  if (s === 'even' || s === '偶数页' || s === '偶数') {
    return { ok: true, pages: seq(1, pageCount - 1, 2) };
  }
  if (s === 'last' || s === '末页') {
    return { ok: true, pages: [pageCount - 1] };
  }
  const seen = new Set();
  const out = [];
  // 先归一化连字符周围空白（"1 - 3" → "1-3"），再按分隔符切分
  const normalized = s.replace(/\s*[-–]\s*/g, '-');
  for (const raw of normalized.split(/[,，;；\s]+/)) {
    if (!raw) continue;
    let m = /^(\d+)-(\d+)$/.exec(raw);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
        return { ok: false, error: `范围 ${raw} 超出页数（1-${pageCount}）` };
      }
      const step = a <= b ? 1 : -1;
      for (let i = a; i !== b + step; i += step) push(out, seen, i - 1);
      continue;
    }
    m = /^(\d+)-n$/.exec(raw) || /^(\d+)-last$/.exec(raw) || /^(\d+)-末页$/.exec(raw);
    if (m) {
      const a = parseInt(m[1], 10);
      if (a < 1 || a > pageCount) return { ok: false, error: `范围 ${raw} 超出页数（1-${pageCount}）` };
      for (let i = a; i <= pageCount; i++) push(out, seen, i - 1);
      continue;
    }
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      if (n < 1 || n > pageCount) return { ok: false, error: `页码 ${n} 超出页数（1-${pageCount}）` };
      push(out, seen, n - 1);
      continue;
    }
    return { ok: false, error: `无法识别「${raw}」，支持示例：1-3,5,8-n、odd、even` };
  }
  if (!out.length) return { ok: false, error: '页范围为空' };
  return { ok: true, pages: out };
}

/** 每组 N 页拆分：返回 0 基页组的数组 */
export function splitGroups(pageCount, mode) {
  if (mode.kind === 'each') return seq(0, pageCount - 1, 1).map((p) => [p]);
  if (mode.kind === 'every') {
    const n = Math.max(1, Math.floor(mode.n));
    const out = [];
    for (let i = 0; i < pageCount; i += n) out.push(seq(i, Math.min(i + n, pageCount) - 1, 1));
    return out;
  }
  if (mode.kind === 'ranges') {
    return mode.groups.map((g) => {
      const r = parsePageRange(g, pageCount);
      if (!r.ok) throw new Error(r.error);
      return r.pages;
    });
  }
  throw new Error('未知拆分模式');
}

function push(arr, seen, p) {
  if (!seen.has(p)) { seen.add(p); arr.push(p); }
}

function seq(a, b, step = 1) {
  const out = [];
  for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i);
  return out;
}
