// 文件床（更多 · 唯一联网工具）：把文件上传到用户选择的第三方文件床并取回分享链接。
// 服务预设（2026-10 实测 CORS）：
//   onlyfiles.com / tmpfiles.org —— 上传 API 带 Access-Control-Allow-Origin: *，
//     浏览器可直传并自动取回分享链接（分享链接为预览页，直链由站方动态签名、无法嵌图）；
//   img.yohuo.eu.org（telegraph 开源实例）—— 稳定直链但未开 CORS：请求发得出、文件会
//     上传成功，但 JS 读不到响应。绕过正解 = 自部署 Cloudflare Worker 中转（WORKER_SRC，
//     步骤见 docs/filebed-proxy.md），部署后把 Worker 地址填「自定义端点」即全自动。
// 自定义端点兼容三种响应格式（telegraph {data:url} / 数组 [{src}] / tmpfiles {data:{url}}）。
// 除此之外本站其它所有工具均本地处理、文件不出浏览器。
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, button, toast, select } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { fmtBytes } from '../../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';

const SERVICE_KEY = 'pdftoolkit.filebed.service';
const ENDPOINT_KEY = 'pdftoolkit.filebed.endpoint';
export const DEFAULT_ENDPOINT = 'https://img.yohuo.eu.org';
// 服务端单文件上限：telegraph 系 30MB（MAX_SIZE_MB，超限 413）；onlyfiles/tmpfiles 100MB
export const YOHUO_MB = 30;
export const PROXY_MB = 100;
// telegraph 系服务端扩展名白名单（其余返回 415）；onlyfiles/tmpfiles 不限类型
export const ALLOWED = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'avi', 'mov', 'webm'];
const FREE_EXTS = [...ALLOWED, 'txt', 'pdf', 'zip', '7z', 'rar', 'mp3', 'wav', 'flac', 'json', 'xml', 'csv', 'docx', 'xlsx', 'pptx', 'md'];

export const SERVICES = {
  onlyfiles: {
    label: 'onlyfiles.com · 直传自动取链（推荐 · 永久）',
    api: 'https://onlyfiles.com/api/v1/upload',
    host: 'onlyfiles.com',
    maxMB: PROXY_MB,
    telegraphWhitelist: false,
    embed: false,
    shareNote: '永久托管；分享链接为预览页，访客打开即可查看或下载',
  },
  tmpfiles: {
    label: 'tmpfiles.org · 直传自动取链（60 分钟快传）',
    api: 'https://tmpfiles.org/api/v1/upload',
    host: 'tmpfiles.org',
    maxMB: PROXY_MB,
    telegraphWhitelist: false,
    embed: false,
    shareNote: '临时托管：60 分钟无人访问即删除，仅适合快速分享',
  },
  yohuo: {
    label: 'img.yohuo.eu.org · 稳定直链（需中转取链）',
    api: 'https://img.yohuo.eu.org/upload',
    host: 'img.yohuo.eu.org',
    maxMB: YOHUO_MB,
    telegraphWhitelist: true,
    embed: true,
    shareNote: '该站未开 CORS：直连时文件会上传成功但取不回链接，见下方说明',
  },
  custom: {
    label: '自定义端点（telegraph / tmpfiles 兼容响应）',
    api: '',
    host: '',
    maxMB: PROXY_MB,
    telegraphWhitelist: true,
    embed: true,
    shareNote: '稳定直链，可直接嵌入网页 / Markdown',
  },
};

/** 服务选择迁移：优先已存 service；老用户按旧 endpoint 归位（默认站→yohuo，改过→custom）；新用户默认 onlyfiles */
export function resolveService(saved, endpoint) {
  if (saved && Object.prototype.hasOwnProperty.call(SERVICES, saved)) return saved;
  if (endpoint === DEFAULT_ENDPOINT) return 'yohuo';
  if (endpoint) return 'custom';
  return 'onlyfiles';
}

/** 统一解析各家上传响应为分享链接；无法识别/服务端报错则 throw（导出供单测） */
export function parseUploadResponse(body) {
  if (Array.isArray(body)) {
    const src = body[0] && body[0].src; // telegraph 老格式 [{src:'/file/…'}]
    if (typeof src === 'string' && src) return /^https?:/i.test(src) ? src : `https://telegra.ph${src}`;
    throw new Error('响应格式无法识别');
  }
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error) throw new Error(body.error);
    const f = body.data && body.data.file && body.data.file.url; // onlyfiles {status,data:{file:{url:{full}}}}
    if (f && typeof f === 'object') {
      const u = typeof f.full === 'string' && f.full ? f.full : f.short;
      if (typeof u === 'string' && u) return u;
    }
    const d = body.data;
    if (typeof d === 'string' && d) return d; // telegraph / yohuo {data:'https://…'}
    if (d && typeof d === 'object' && typeof d.url === 'string' && d.url) return d.url; // tmpfiles {data:{url}}
  }
  throw new Error('响应格式无法识别');
}

/** Cloudflare Worker 中转模板：反代 yohuo 并补 CORS 头（导出供 corsHelp 展示/复制与文档同步） */
export const WORKER_SRC = `// Cloudflare Worker：文件床 CORS 中转（部署步骤见 docs/filebed-proxy.md）
// 部署后把 Worker 地址（如 https://filebed-proxy.你的子域.workers.dev）填入工具的「自定义端点」
const UPSTREAM = 'https://img.yohuo.eu.org';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const resp = await fetch(UPSTREAM + url.pathname + url.search, request);
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  },
};`;

function load(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function save(k, v) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 自定义端点归一：以 /upload 结尾原样使用，否则拼 /upload（telegraph 习惯） */
export function uploadUrlOf(endpoint) {
  const root = (endpoint || '').trim().replace(/\/+$/, '');
  return /\/upload$/i.test(root) ? root : `${root}/upload`;
}

/** 上传单个文件：XHR（可读上传进度）。resolve({url}) 或 reject(Error) */
function uploadOne(apiUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let body = xhr.response;
      if (body == null) { try { body = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ } }
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve({ url: parseUploadResponse(body) }); }
        catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      } else {
        const msg = body && typeof body === 'object' && body.error ? body.error : `服务端返回 HTTP ${xhr.status}`;
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
  desc: '上传文件到图床/文件床并生成分享链接（唯一联网工具，内置可直传服务，支持自定义端点）',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const state = { docs: [] };
    let service = resolveService(load(SERVICE_KEY), load(ENDPOINT_KEY));
    const svc = () => SERVICES[service];

    // 醒目声明：这是全站唯一的联网工具（文案随服务动态更新）
    const notice = document.createElement('div');
    notice.className = 'alert alert-warn';
    notice.style.marginTop = '14px';
    function updateNotice() {
      const s = svc();
      const fmt = s.telegraphWhitelist ? `支持格式：${ALLOWED.join(' / ')}` : `支持格式（不限类型，常用）：${FREE_EXTS.slice(0, 12).join(' / ')} 等`;
      notice.textContent = `与其它工具不同：本工具会把所选文件上传到第三方文件床服务（${s.host || '自定义服务'}）以生成公开分享链接，请勿上传敏感文件。${fmt}，单文件 ≤ ${s.maxMB}MB。`;
    }

    const acceptSet = [...new Set([...ALLOWED, ...FREE_EXTS])];
    const panel = inputPanel({
      multiple: true,
      accept: acceptSet.map((e) => `.${e}`).join(','),
      acceptTest: /\.[a-z0-9]+$/i,
      acceptHint: '可多选；类型与大小上限以上传服务为准（见下方说明）',
      onAdd() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
      onRemove() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
    });

    const { card, body } = paramsCard();

    const svcSel = select(
      Object.entries(SERVICES).map(([id, s]) => ({ value: id, label: s.label })),
      service,
    );
    svcSel.setAttribute('aria-label', '上传服务');
    const svcHint = document.createElement('div');
    svcHint.className = 'hint';
    const svcField = field('上传服务', svcSel);
    svcField.appendChild(svcHint);
    function updateSvcHint() {
      svcHint.textContent = svc().shareNote || '填站点根地址，自动 POST {地址}/upload；响应需为 JSON（格式自动识别）';
    }

    const epInp = textInput(load(ENDPOINT_KEY) || DEFAULT_ENDPOINT, 'https://img.yohuo.eu.org');
    epInp.addEventListener('change', () => {
      const v = epInp.value.trim().replace(/\/+$/, '');
      if (v && /^https?:\/\//i.test(v)) save(ENDPOINT_KEY, v);
      else if (v) { toast('服务地址需以 http(s):// 开头，已还原', 'error'); epInp.value = load(ENDPOINT_KEY) || DEFAULT_ENDPOINT; }
    });
    const epField = field('服务地址', epInp, '仅自定义端点时需要：telegraph 实例或自部署的 CORS 中转 Worker 地址');
    function syncEpVisible() { epField.style.display = service === 'custom' ? '' : 'none'; }

    svcSel.addEventListener('change', () => {
      service = svcSel.value;
      save(SERVICE_KEY, service);
      syncEpVisible();
      updateSvcHint();
      updateNotice();
    });
    syncEpVisible();
    updateSvcHint();
    updateNotice();
    body.append(svcField, epField);

    const goBtn = button('上传到文件床', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(notice, panel.el, card, goBtn, resultBox);

    function linkRow(url, embed, shareNote) {
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.style.wordBreak = 'break-all';
      nm.textContent = url;
      info.appendChild(nm);
      if (shareNote) {
        const sn = document.createElement('div');
        sn.className = 'hint';
        sn.textContent = shareNote;
        info.appendChild(sn);
      }
      line.appendChild(info);
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap';
      const mkCopy = (label, text) => button(label, 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
        catch { toast('复制失败', 'error'); }
      });
      right.appendChild(mkCopy('复制链接', url));
      if (embed) {
        right.appendChild(mkCopy('Markdown', `![文件](${url})`));
        right.appendChild(mkCopy('HTML', `<img src="${url}" alt="文件">`));
      }
      right.appendChild(button('打开', 'btn-outline btn-sm', () => window.open(url, '_blank', 'noopener')));
      line.appendChild(right);
      return line;
    }

    function workerCodeBox() {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:6px 0 0';
      const copyBtn = button('复制 Worker 代码', 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(WORKER_SRC); toast('已复制，去 Cloudflare Dashboard 粘贴部署即可'); }
        catch { toast('复制失败', 'error'); }
      });
      const docLink = document.createElement('a');
      docLink.href = 'https://developers.cloudflare.com/workers/get-started/dashboard/';
      docLink.target = '_blank';
      docLink.rel = 'noopener noreferrer';
      docLink.textContent = 'Cloudflare Workers 部署入口 ↗（完整图文步骤见仓库 docs/filebed-proxy.md）';
      docLink.style.cssText = 'font-size:13px;margin-left:10px;color:var(--foreground);text-decoration:underline';
      const pre = document.createElement('pre');
      // 注意：本项目旧令牌 --muted 是"弱化文字色"而非弱化背景色，这里用半透明灰保证对比
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.14);color:var(--foreground);padding:10px;border-radius:8px;margin:8px 0 0;font-size:12px;max-height:280px;overflow:auto';
      pre.textContent = WORKER_SRC;
      wrap.append(copyBtn, docLink, pre);
      return wrap;
    }

    function corsHelp() {
      const box = document.createElement('div');
      box.className = 'alert alert-error';
      box.style.marginTop = '10px';
      const head = document.createElement('div');
      head.textContent = '上传请求已发出，但浏览器读不到服务端响应（跨域 CORS 限制）。文件可能已上传成功，但无法自动取回链接。';
      box.appendChild(head);
      const tips = document.createElement('ol');
      tips.style.cssText = 'margin:6px 0 0 18px;font-size:13px;line-height:1.9';
      tips.innerHTML = [
        '<b>推荐：把「上传服务」切换为 onlyfiles.com 或 tmpfiles.org</b>——两者已开启 CORS，本页可全自动直传取链（onlyfiles 永久、tmpfiles 60 分钟快传）。',
        '想继续用 yohuo 的稳定直链：用下面的 Cloudflare Worker 中转模板（免费，约 10 分钟），部署后把 Worker 地址填入「自定义端点」即可全自动。',
        '自部署 telegraph 实例：在 Worker 的 jsonResponse 响应头加 <code>Access-Control-Allow-Origin: *</code>。',
      ].map((h) => `<li>${h}</li>`).join('');
      box.appendChild(tips);
      box.appendChild(workerCodeBox());
      return box;
    }

    async function exec() {
      const docs = [...state.docs];
      resultBox.replaceChildren();
      if (!docs.length) { toast('请先选择文件', 'error'); return; }
      const s = svc();
      let apiUrl = s.api;
      if (!apiUrl) {
        const ep = (epInp.value || '').trim();
        if (!/^https?:\/\//i.test(ep)) { toast('请填写正确的服务地址（http(s):// 开头）', 'error'); return; }
        apiUrl = uploadUrlOf(ep);
      }
      for (const d of docs) {
        const ext = extOf(d.name);
        if (s.telegraphWhitelist && !ALLOWED.includes(ext)) { toast(`该服务不支持的文件类型：${d.name}（仅允许 ${ALLOWED.join('/')}）`, 'error', 5000); return; }
        if (d.size > s.maxMB * 1024 * 1024) { toast(`文件 ${d.name} 超过 ${s.maxMB}MB 上限`, 'error'); return; }
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
            const { url } = await uploadOne(apiUrl, doc.file, (p) => {
              head.textContent = `上传中 ${i + 1}/${docs.length}：${doc.name}（${Math.round(p * 100)}%）`;
            });
            results.push({ name: doc.name, url });
            list.appendChild(linkRow(url, s.embed, s.shareNote || ''));
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
        done.textContent = `成功 ${results.length}/${docs.length} 个；${s.embed ? '链接为公开直链，任何人都可访问' : '链接为公开分享页，任何人都可访问'}`;
        list.appendChild(done);
      }
      recordTaskOrButton({
        tool: 'filebed', toolName: '文件床',
        docNames: docs.map((d) => d.name),
        options: { 服务: s.host || (() => { try { return new URL(apiUrl).host; } catch { return apiUrl; } })(), 成功: results.length },
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
