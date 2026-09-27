// 轻量 UI 基础组件：toast / modal / 参数表单 helpers
import { esc } from '../core/format.js';

let toastWrap = null;
export function toast(msg, type = 'ok', ms = 2600) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg; // textContent 安全渲染
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
  x.className = 'btn btn-ghost btn-sm';
  x.textContent = '✕';
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
