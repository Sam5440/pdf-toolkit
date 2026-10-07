// 文件床（更多 · 唯一联网工具）：把文件上传到用户指定的 telegraph 兼容文件床
// （默认 https://img.yohuo.eu.org ，开源项目 0-RTT/telegraph），前端直传并取回分享链接。
// ⚠️ 该站当前部署未返回 CORS 头：浏览器跨域请求可发出（文件会上传成功）但 JS 读不到
// 返回的链接。工具支持自定义 endpoint（自部署实例在响应头加一行 CORS 即可全自动），
// 并对跨域失败给出明确指引。除此之外本站其它所有工具均本地处理、文件不出浏览器。
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, button, toast } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { fmtBytes } from '../../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';

const ENDPOINT_KEY = 'pdftoolkit.filebed.endpoint';
export const DEFAULT_ENDPOINT = 'https://img.yohuo.eu.org';
export const MAX_MB = 30; // 该站单文件上限（服务端 MAX_SIZE_MB，超限返回 413）
// 服务端扩展名白名单（telegraph ALLOWED_EXTENSIONS，其余返回 415）
export const ALLOWED = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'avi', 'mov', 'webm'];

function loadEndpoint() {
  try {
    const v = localStorage.getItem(ENDPOINT_KEY);
    if (v) return v;
  } catch { /* 隐私模式 */ }
  return DEFAULT_ENDPOINT;
}

function saveEndpoint(v) {
  try { localStorage.setItem(ENDPOINT_KEY, v); } catch { /* ignore */ }
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 上传单个文件：XHR（可读上传进度）。resolve({url}) 或 reject(Error) */
function uploadOne(endpoint, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${endpoint.replace(/\/+$/, '')}/upload`);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300 && body && body.data) {
        resolve({ url: body.data });
      } else {
        const msg = body && body.error ? body.error : `服务端返回 HTTP ${xhr.status}`;
        reject(new Error(msg));
      }
    });
    xhr.addEventListener('error', () => {
      const err = new Error('CORS_OR_NETWORK');
      reject(err);
    });
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

registerTool({
  id: 'filebed',
  name: '文件床',
  group: 'm-util',
  desc: '上传文件到图床/文件床并生成分享链接（唯一联网工具，可自定义服务地址）',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const state = { docs: [] };

    // 醒目声明：这是全站唯一的联网工具
    const notice = document.createElement('div');
    notice.className = 'alert alert-warn';
    notice.style.marginTop = '14px';
    notice.textContent = '与其它工具不同：本工具会把所选文件上传到第三方文件床服务（默认 img.yohuo.eu.org，开源项目 telegraph）以生成公开分享链接，请勿上传敏感文件。支持格式：' + ALLOWED.join(' / ') + '，单文件 ≤ 30MB。';

    const panel = inputPanel({
      multiple: true,
      accept: ALLOWED.map((e) => `.${e}`).join(','),
      acceptTest: new RegExp(`\\.(${ALLOWED.join('|')})$`, 'i'),
      acceptHint: `可多选（图片/视频），单文件 ≤ 30MB：${ALLOWED.join(' / ')}`,
      onAdd() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
      onRemove() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
    });

    const { card, body } = paramsCard();
    const epInp = textInput(loadEndpoint(), 'https://img.yohuo.eu.org');
    epInp.addEventListener('change', () => {
      const v = epInp.value.trim().replace(/\/+$/, '');
      if (v && /^https?:\/\//i.test(v)) saveEndpoint(v);
      else if (v) { toast('服务地址需以 http(s):// 开头，已还原', 'error'); epInp.value = loadEndpoint(); }
    });
    body.appendChild(field('文件床服务地址', epInp, '默认为 img.yohuo.eu.org；可填自部署的 telegraph 实例（需开启 CORS 跨域响应头）'));

    const goBtn = button('上传到文件床', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(notice, panel.el, card, goBtn, resultBox);

    function linkRow(url) {
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.style.wordBreak = 'break-all';
      nm.textContent = url;
      info.appendChild(nm);
      line.appendChild(info);
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap';
      const mkCopy = (label, text) => button(label, 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
        catch { toast('复制失败', 'error'); }
      });
      right.appendChild(mkCopy('复制链接', url));
      right.appendChild(mkCopy('Markdown', `![文件](${url})`));
      right.appendChild(mkCopy('HTML', `<img src="${url}" alt="文件">`));
      right.appendChild(button('打开', 'btn-outline btn-sm', () => window.open(url, '_blank', 'noopener')));
      line.appendChild(right);
      return line;
    }

    function corsHelp() {
      const box = document.createElement('div');
      box.className = 'alert alert-error';
      box.style.marginTop = '10px';
      const head = document.createElement('div');
      head.textContent = '上传请求已发出，但浏览器读不到服务端响应（跨域 CORS 限制）。';
      box.appendChild(head);
      const tips = document.createElement('ol');
      tips.style.cssText = 'margin:6px 0 0 18px;font-size:13px;line-height:1.9';
      tips.innerHTML = [
        '<li>文件<b>可能已上传成功</b>，但无法自动取回链接；可到文件床站点手动查看。</li>',
        '<li>默认服务 img.yohuo.eu.org 当前未开启 CORS（这是服务端配置，非本页问题）。</li>',
        '<li>自部署 telegraph 实例时，在 Worker 的 jsonResponse 响应头加 <code>Access-Control-Allow-Origin: *</code> 即可全自动上传取链。</li>',
      ].map((h) => `<li>${h}</li>`).join('');
      box.appendChild(tips);
      return box;
    }

    async function exec() {
      const docs = [...state.docs];
      resultBox.replaceChildren();
      if (!docs.length) { toast('请先选择文件', 'error'); return; }
      const endpoint = (epInp.value || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(endpoint)) { toast('请填写正确的服务地址（http(s):// 开头）', 'error'); return; }
      for (const d of docs) {
        const ext = extOf(d.name);
        if (!ALLOWED.includes(ext)) { toast(`不支持的文件类型：${d.name}（服务端仅允许 ${ALLOWED.join('/')}）`, 'error', 5000); return; }
        if (d.size > MAX_MB * 1024 * 1024) { toast(`文件 ${d.name} 超过 30MB 上限`, 'error'); return; }
      }

      const results = [];
      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      const bodyEl = document.createElement('div');
      bodyEl.className = 'card-body';
      const list = document.createElement('div');
      list.style.marginTop = '4px';
      bodyEl.appendChild(list);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      cardEl.appendChild(bodyEl);
      resultBox.appendChild(cardEl);
      goBtn.disabled = true;

      let hadCorsError = false;
      try {
        for (let i = 0; i < docs.length; i++) {
          const doc = docs[i];
          const head = document.createElement('div');
          head.className = 'hint';
          head.style.marginTop = i ? '10px' : '2px';
          head.textContent = `上传中 ${i + 1}/${docs.length}：${doc.name}（${fmtBytes(doc.size)}）`;
          const tail = list.querySelectorAll('.fb-head');
          tail.forEach((n) => n.remove());
          head.className += ' fb-head';
          list.appendChild(head);
          try {
            const { url } = await uploadOne(endpoint, doc.file, (p) => {
              head.textContent = `上传中 ${i + 1}/${docs.length}：${doc.name}（${Math.round(p * 100)}%）`;
            });
            results.push({ name: doc.name, url });
            list.appendChild(linkRow(url));
          } catch (e) {
            if (e.message === 'CORS_OR_NETWORK') {
              hadCorsError = true;
              break;
            }
            const err = document.createElement('div');
            err.className = 'alert alert-error';
            err.style.marginTop = '4px';
            err.textContent = `${doc.name} 上传失败：${e.message}`;
            list.appendChild(err);
          }
        }
      } finally {
        goBtn.disabled = false;
      }
      if (hadCorsError) cardEl.insertBefore(corsHelp(), bodyEl);
      if (results.length) {
        const done = document.createElement('div');
        done.className = 'hint';
        done.style.marginTop = '10px';
        done.textContent = `成功 ${results.length}/${docs.length} 个，链接为公开直链，任何人都可访问`;
        list.appendChild(done);
      }
      recordTaskOrButton({
        tool: 'filebed', toolName: '文件床',
        docNames: docs.map((d) => d.name),
        options: { 服务: (() => { try { return new URL(endpoint).host; } catch { return endpoint; } })(), 成功: results.length },
        docs,
        outputs: [],
        form: capturePageForm(),
      }).then((btn) => {
        if (btn) actions.appendChild(btn);
        else bodyEl.appendChild(recordNote());
      }).catch(() => { /* 记录失败不阻塞结果展示 */ });
      bodyEl.appendChild(actions);
    }
  },
});
