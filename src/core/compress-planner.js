// 压缩规划器（纯逻辑）：候选阶梯生成、精搜邻域、最优挑选。
// 与旧版 pdf_optimizer.py 的阶梯思想一致，参数适配浏览器端三种模式。

export const SMART_LADDER = [
  { scale: 1.0, q: 78 }, { scale: 0.9, q: 72 }, { scale: 0.8, q: 66 },
  { scale: 0.7, q: 60 }, { scale: 0.6, q: 54 }, { scale: 0.5, q: 48 },
  { scale: 0.4, q: 42 },
];
export const RASTER_LADDER = [
  { dpi: 150, q: 85 }, { dpi: 120, q: 80 }, { dpi: 100, q: 76 },
  { dpi: 80, q: 70 }, { dpi: 60, q: 64 },
];

/** 候选 id（用于精搜去重） */
export function candidateId(mode, params) {
  if (mode === 'smart') return `smart:${params.scale.toFixed(2)}:${params.q}`;
  if (mode === 'raster') return `raster:${params.dpi}:${params.q}`;
  return 'structural';
}

export function labelOf(mode, params) {
  if (mode === 'smart') return `图片重压 缩放${Math.round(params.scale * 100)}% · Q${params.q}`;
  if (mode === 'raster') return `栅格化 ${params.dpi}DPI · Q${params.q}`;
  return '结构无损优化';
}

/**
 * 粗搜候选列表
 * @param {{smart?:boolean, raster?:boolean, structural?:boolean}} modes
 * @param {number} srcSize 源字节
 * @param {number|null} targetBytes 目标字节（null=仅质量最优）
 */
export function planCandidates(modes, srcSize, targetBytes) {
  const out = [];
  if (modes.structural) {
    out.push({ mode: 'structural', params: {}, label: labelOf('structural', {}) });
  }
  if (modes.smart) {
    for (const c of SMART_LADDER) {
      out.push({ mode: 'smart', params: { scale: c.scale, q: c.q }, label: labelOf('smart', c) });
    }
  }
  if (modes.raster) {
    for (const c of RASTER_LADDER) {
      out.push({ mode: 'raster', params: { dpi: c.dpi, q: c.q }, label: labelOf('raster', c) });
    }
  }
  // 有目标时按“预计收益从大到小”排序（越小体积候选排前面，尽快达标）
  if (targetBytes) {
    const estimate = (c) => {
      if (c.mode === 'structural') return srcSize * 0.92;
      if (c.mode === 'smart') return srcSize * 0.62 * c.params.scale;
      return srcSize * 0.28 * (c.params.dpi / 150) ** 1.6;
    };
    out.sort((a, b) => estimate(a) - estimate(b));
  }
  return out;
}

/**
 * 精搜：围绕当前最优生成邻域候选（排除已试过）
 * @param {{mode:string, params:object}} best
 * @param {Set<string>} tried candidateId 集合
 */
export function refineCandidates(best, tried) {
  const out = [];
  const push = (mode, params) => {
    const id = candidateId(mode, params);
    if (!tried.has(id)) { tried.add(id); out.push({ mode, params, label: labelOf(mode, params) }); }
  };
  if (best.mode === 'smart') {
    const { scale, q } = best.params;
    for (const ds of [-0.05, 0.05]) {
      const s = Math.min(1, Math.max(0.25, scale + ds));
      push('smart', { scale: +s.toFixed(2), q });
    }
    for (const dq of [-6, 6]) push('smart', { scale, q: Math.min(95, Math.max(30, q + dq)) });
  } else if (best.mode === 'raster') {
    const { dpi, q } = best.params;
    for (const dd of [-15, 15]) push('raster', { dpi: Math.min(300, Math.max(40, dpi + dd)), q });
    for (const dq of [-4, 4]) push('raster', { dpi, q: Math.min(95, Math.max(40, q + dq)) });
  }
  return out.slice(0, 4);
}

/**
 * 挑选推荐方案
 * @param {Array<{id:string, mode:string, label:string, ok:boolean, size:number, ssim:number|null}>} rows
 * @param {{targetBytes?:number|null, minSsim?:number}} opts
 * @returns {{bestId:string|null, minId:string|null, qualityId:string|null}}
 */
export function pickBest(rows, opts = {}) {
  const { targetBytes = null, minSsim = 0 } = opts;
  const okRows = rows.filter((r) => r.ok && r.size > 0);
  if (!okRows.length) return { bestId: null, minId: null, qualityId: null };
  const minId = okRows.reduce((a, b) => (b.size < a.size ? b : a)).id;
  const qualityId = okRows.reduce((a, b) => ((b.ssim ?? 0) > (a.ssim ?? 0) ? b : a)).id;
  let eligible = okRows;
  if (targetBytes) eligible = eligible.filter((r) => r.size <= targetBytes);
  eligible = eligible.filter((r) => r.ssim == null || r.ssim >= minSsim);
  let bestId = null;
  if (eligible.length) {
    // 达标者里选质量最高，质量同分选更小
    bestId = eligible.reduce((a, b) =>
      ((b.ssim ?? 0) > (a.ssim ?? 0) + 1e-9) ? b :
      ((b.ssim ?? 0) < (a.ssim ?? 0) - 1e-9) ? a :
      (b.size < a.size ? b : a)).id;
  }
  return { bestId, minId, qualityId };
}
