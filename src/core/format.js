// 展示格式化与安全渲染工具

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtMB(n) {
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

export function fmtTime(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

/** HTML 转义 — 所有用户内容（文件名/水印文字/错误信息）注入 DOM 前必须经过 */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** 下载文件名安全化：去控制字符/路径分隔/首尾点空格，限长 */
export function sanitizeFilename(name, fallback = '未命名') {
  let s = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (s.startsWith('.')) s = '_' + s.slice(1);
  if (s.length > 120) s = s.slice(0, 120);
  return s || fallback;
}

export function baseName(name) {
  const s = sanitizeFilename(name);
  return s.replace(/\.[^.]+$/, '');
}

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

export function fmtTime2(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowTimeStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
