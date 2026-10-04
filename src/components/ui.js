// 轻量 UI 基础组件：toast / modal / confirmDialog / 参数表单 helpers
import { esc } from '../core/format.js';
import { isFavorite, toggleFavorite } from '../core/favorites.js';

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.85 5.85 6.45.85-4.73 4.5 1.18 6.4L12 17.4l-5.75 3l1.18-6.4l-4.73-4.5l6.45-.85z"/></svg>';

const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const OK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const ERR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>';
const INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

/** 工具卡片右上角收藏星标：未收藏=白色（灰描边），已收藏=黄色。
 *  onChange(on) 由调用方决定是否重渲染（首页需要即时增删卡片，专项页原位更新）。 */
export function favStar(toolId, { onChange } = {}) {
  const on = isFavorite(toolId);
  const el = document.createElement('span');
  el.className = 'fav-star' + (on ? ' on' : '');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('data-star', toolId);
  el.setAttribute('aria-pressed', String(on));
  el.setAttribute('aria-label', on ? `取消收藏 ${toolId}` : `收藏 ${toolId} 到首页`);
  el.title = on ? '取消收藏' : '收藏到首页';
  el.innerHTML = STAR_SVG;
  const flip = () => {
    toggleFavorite(toolId);
    const now = isFavorite(toolId);
    el.classList.toggle('on', now);
    el.setAttribute('aria-pressed', String(now));
    el.setAttribute('aria-label', now ? `取消收藏 ${toolId}` : `收藏 ${toolId} 到首页`);
    el.title = now ? '取消收藏' : '收藏到首页';
    onChange?.(now);
  };
  el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); flip(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
  });
  return el;
}

let toastWrap = null;
export function toast(msg, type = 'ok', ms = 2600) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = type === 'error' ? ERR_SVG : type === 'info' ? INFO_SVG : OK_SVG;
  const text = document.createElement('span');
  text.textContent = msg; // textContent 安全渲染
  t.append(icon, text);
  toastWrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** 打开模态框：返回 {close, box} */
export function openModal(title, contentEl) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('div');
  h.textContent = title;
  const x = document.createElement('button');
  x.className = 'btn btn-ghost btn-sm btn-icon';
  x.innerHTML = X_SVG;
  x.setAttribute('aria-label', '关闭');
  head.append(h, x);
  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof contentEl === 'string') body.innerHTML = contentEl;
  else body.appendChild(contentEl);
  box.append(head, body);
  mask.appendChild(box);
  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  let onClose = null;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  x.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(mask);
  return { close, box, body, setOnClose: (fn) => { onClose = fn; } };
}

/** 确认对话框（shadcn AlertDialog 风格，替代原生 confirm()）：Promise<boolean> */
export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  destructive = false,
} = {}) {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    if (message) {
      const p = document.createElement('p');
      p.style.cssText = 'margin:0;font-size:13.5px;color:var(--text-soft);line-height:1.6';
      p.textContent = message;
      body.appendChild(p);
    }
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline';
    cancelBtn.textContent = cancelText;
    cancelBtn.setAttribute('data-cd-cancel', '');
    const okBtn = document.createElement('button');
    okBtn.className = `btn ${destructive ? 'btn-danger' : 'btn-primary'}`;
    okBtn.textContent = confirmText;
    okBtn.setAttribute('data-cd-confirm', '');
    foot.append(cancelBtn, okBtn);
    body.appendChild(foot);

    const m = openModal(title, body);
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    okBtn.onclick = () => { settle(true); m.close(); };
    cancelBtn.onclick = () => { settle(false); m.close(); };
    m.setOnClose(() => settle(false));
    cancelBtn.focus();
  });
}

/** 表单字段构建 helpers（全部安全 DOM 构建） */
export function field(labelText, inputEl, hint) {
  const w = document.createElement('div');
  w.className = 'field';
  const l = document.createElement('label');
  l.textContent = labelText;
  w.append(l, inputEl);
  if (hint) {
    const hh = document.createElement('div');
    hh.className = 'hint';
    hh.textContent = hint;
    w.appendChild(hh);
  }
  inputEl.id = inputEl.id || `f_${Math.random().toString(36).slice(2, 8)}`;
  l.setAttribute('for', inputEl.id);
  return w;
}

export function select(options, value) {
  const s = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  if (value != null) s.value = value;
  return s;
}

export function numberInput(value, { min, max, step } = {}) {
  const i = document.createElement('input');
  i.type = 'number';
  if (value != null) i.value = value;
  if (min != null) i.min = min;
  if (max != null) i.max = max;
  if (step != null) i.step = step;
  return i;
}

export function textInput(value = '', placeholder = '') {
  const i = document.createElement('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

export function passwordInput(placeholder = '') {
  const i = document.createElement('input');
  i.type = 'password';
  i.placeholder = placeholder;
  i.autocomplete = 'new-password';
  return i;
}

export function checkbox(labelText, checked = false) {
  const l = document.createElement('label');
  l.className = 'checkbox-row';
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = checked;
  const s = document.createElement('span');
  s.textContent = labelText;
  l.append(c, s);
  l._input = c;
  return l;
}

export function row(...els) {
  const d = document.createElement('div');
  d.className = 'field-row';
  els.forEach((e) => d.appendChild(e));
  return d;
}

export function button(label, cls = 'btn-outline', onClick) {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.type = 'button';
  b.textContent = label;
  if (onClick) b.onclick = onClick;
  return b;
}

/** 进度卡：返回 {el, set(pct, stageText), error(msg), done()} */
export function progressCard() {
  const el = document.createElement('div');
  el.className = 'card';
  el.style.marginTop = '14px';
  el.innerHTML = `
    <div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:13.5px" data-pc-stage>处理中…</b>
        <span class="muted-sm" data-pc-pct>0%</span>
      </div>
      <div class="progress-bar"><div data-pc-bar style="width:0%"></div></div>
      <div data-pc-err style="display:none;margin-top:10px"></div>
    </div>`;
  const stage = el.querySelector('[data-pc-stage]');
  const pct = el.querySelector('[data-pc-pct]');
  const bar = el.querySelector('[data-pc-bar]');
  const errBox = el.querySelector('[data-pc-err]');
  return {
    el,
    set(p, text) {
      const v = Math.max(0, Math.min(100, Math.round(p || 0)));
      bar.style.width = `${v}%`;
      pct.textContent = `${v}%`;
      if (text) stage.textContent = text;
    },
    indeterminate(text) {
      bar.style.width = '100%';
      bar.style.background = 'repeating-linear-gradient(45deg,var(--primary),var(--primary) 8px,var(--primary-hover) 8px,var(--primary-hover) 16px)';
      pct.textContent = '…';
      if (text) stage.textContent = text;
    },
    error(msg) {
      errBox.style.display = 'block';
      errBox.innerHTML = `<div class="alert alert-error" style="margin:0">${esc(msg)}</div>`;
    },
    done() { this.set(100, '完成'); },
  };
}

/** 渲染警告列表 */
export function warningsBox(warnings) {
  if (!warnings?.length) return null;
  const d = document.createElement('div');
  d.className = 'alert alert-warn';
  d.innerHTML = `<b>提示（${warnings.length}）</b><pre>${esc(warnings.join('\n'))}</pre>`;
  return d;
}
