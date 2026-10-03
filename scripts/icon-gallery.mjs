// 生成图标验收画廊：docs/report-assets/icon-gallery.html
// 全部图标 × 明/暗主题 × 20/32/48px 三档尺寸，供截图目检。
// 用法: node scripts/icon-gallery.mjs [--dir=src/assets/icons-color] [图标id,逗号分隔]
import fs from 'node:fs';
import path from 'node:path';

let DIR = 'src/assets/icons';
const rest = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--dir=')) DIR = a.slice(6);
  else rest.push(a);
}
const OUT = DIR === 'src/assets/icons-color'
  ? 'docs/report-assets/icon-gallery-color.html'
  : 'docs/report-assets/icon-gallery.html';
const IDS = rest.length && rest[0]
  ? rest[0].split(',').filter(Boolean)
  : fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')).map((f) => f.replace('.svg', '')).sort();

const cards = IDS.map((id) => {
  const svg = fs.readFileSync(path.join(DIR, `${id}.svg`), 'utf8');
  const cells = [20, 32, 48].map((s) => `<div class="cell" data-size="${s}"><span style="width:${s}px;height:${s}px">${svg}</span><label>${s}px</label></div>`).join('');
  return `<div class="card" data-id="${id}"><h3>${id}</h3><div class="row">${cells}</div></div>`;
}).join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; font-family: -apple-system, sans-serif; }
  .theme { padding: 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  .light { background:#ffffff; color:#0f172a; }
  .dark  { background:#0b1220; color:#e2e8f0; }
  .card { border:1px solid rgba(128,128,128,.35); border-radius:10px; padding:10px 12px; }
  .card h3 { margin:0 0 8px; font-size:13px; font-weight:600; }
  .row { display:flex; gap:18px; align-items:flex-end; }
  .cell { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .cell span { display:inline-flex; }
  .cell span svg { width:100%; height:100%; }
  .cell label { font-size:10px; opacity:.6; }
</style></head><body>
<div class="theme light">${cards}</div>
<div class="theme dark">${cards}</div>
</body></html>`);
console.log(`gallery: ${OUT} (${IDS.length} icons)`);
