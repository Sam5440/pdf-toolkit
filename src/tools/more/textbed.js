// 文本床（更多 · 联网工具）：把文本/代码/日志一键生成公开分享链接。
// 2026-10 实测（curl 带 Origin 探测，无 CORS 的浏览器读不到响应一律不收）：
//   rentry.co    —— POST /api/new（urlencoded）→ {url, edit_code}；ACAO *；永久；编辑码可再编辑
//   dpaste.com   —— POST /api/v2/（urlencoded，syntax=text）→ 纯文本 URL（+.txt 为 raw）；回显 Origin；约 7 天
//   paste.gg     —— POST /api/v1/pastes（JSON）→ {result:{id, deletion_key}}；ACAO *；匿名 unlisted 7 天
//   GitHub Gist  —— POST /gists（token）→ html_url + raw_url；api.github.com 官方 CORS；永久
//   onlyfiles / tmpfiles —— 把文本包装成 .txt 走文件床 multipart（详见 filebed.js）
// 挂掉/不可用不收：paste.rs 400、sprunge.us 404、dpaste.org 无 ACAO、glot.io origin 白名单、
// paste.debian.net 返回 HTML、pastebin.com 需 key。
// 隐私：Gist token 仅本页内存（优先复用图床已填的 token），绝不落盘；编辑码/删除码随上传
// 记录存本机登记册。文本原件随记录永久保存，可一键重传（除 Gist 需 token）。
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, passwordInput, button, toast, select } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { fmtBytes } from '../../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';
import { addUpload } from '../../core/uploads.js';
import { SERVICES as FILEBED_SERVICES, uploadOne, WORKER_SRC } from './filebed.js';
import { getGhToken } from './image-bed.js';

/** 各服务文本大小上限（KB；官方限制与稳定性取保守值） */
export const TEXT_SERVICES = {
  rentry: {
    label: 'rentry.co · 永久 + 可编辑（推荐）',
    host: 'rentry.co', maxKB: 500, reuploadable: true,
    shareNote: '永久托管；本机登记册保存编辑码，可随时修改内容',
  },
  dpaste: {
    label: 'dpaste.com · 快享（约 7 天）',
    host: 'dpaste.com', maxKB: 250, reuploadable: true,
    shareNote: '免费代码贴；正文链接后加 .txt 可看纯文本 raw',
  },
  pastegg: {
    label: 'paste.gg · 匿名贴（约 7 天）',
    host: 'paste.gg', maxKB: 1024, reuploadable: true,
    shareNote: 'unlisted 匿名贴，约 7 天过期；本机登记册保存删除码',
  },
  gist: {
    label: 'GitHub Gist · 永久（需 token）',
    host: 'gist.github.com', maxKB: 10240, reuploadable: false,
    shareNote: 'GitHub 私密 Gist（secret），永久；token 仅存本页内存',
  },
  onlyfiles: {
    label: 'onlyfiles.com · 文本文件（永久）',
    host: 'onlyfiles.com', maxKB: 100 * 1024, reuploadable: true,
    shareNote: '按 .txt 文件上传的文件床分享页，永久',
  },
  tmpfiles: {
    label: 'tmpfiles.org · 文本文件（60 分钟快传）',
    host: 'tmpfiles.org', maxKB: 100 * 1024, reuploadable: true,
    shareNote: '60 分钟无人访问即删除，仅适合快速分享',
  },
};

// ---------- 响应解析（纯函数，导出供单测） ----------

/** rentry /api/new → {url, editCode} */
export function parseRentry(body) {
  const u = body && typeof body.url === 'string' ? body.url : '';
  if (body && String(body.status) === '200' && /^https?:\/\//.test(u)) return { url: u, editCode: body.edit_code || '' };
  throw new Error((body && body.error) || 'rentry 响应无法识别');
}

/** dpaste.com /api/v2/ → 纯文本 URL */
export function parseDpaste(text) {
  const u = String(text || '').trim();
  if (/^https:\/\/dpaste\.com\/\w+/.test(u)) return { url: u, rawUrl: `${u.replace(/\.txt$/, '')}.txt` };
  throw new Error('dpaste 响应无法识别');
}

/** paste.gg /v1/pastes → 分享页 URL + 删除码 */
export function parsePasteGG(body) {
  const r = body && body.status === 'success' && body.result;
  if (r && typeof r.id === 'string') {
    return { url: `https://paste.gg/p/anonymous/${r.id}`, deletionKey: r.deletion_key || '' };
  }
  throw new Error((body && body.errors && JSON.stringify(body.errors).slice(0, 120)) || 'paste.gg 响应无法识别');
}

/** GitHub Gist → html_url + raw 直链 */
export function parseGist(body, fileName) {
  const f = body && body.files && body.files[fileName];
  if (body && typeof body.html_url === 'string' && f && typeof f.raw_url === 'string') {
    return { url: body.html_url, rawUrl: f.raw_url };
  }
  if (body && body.message) throw new Error(body.message);
  throw new Error('Gist 响应无法识别');
}

/** Gist 文件名安全化（导出供单测） */
export function gistFileName(name) {
  const base = String(name || 'notes.txt').replace(/[/\\]+/g, '_').trim() || 'notes.txt';
  return /\.txt$/i.test(base) ? base : `${base}.txt`;
}

// ---------- 上传（XHR；跨域失败统一抛 CORS_OR_NETWORK） ----------

function xhrText(url, { method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = 'text';
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error(`服务端返回 HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('CORS_OR_NETWORK')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));
    xhr.timeout = 60_000;
    xhr.send(body);
  });
}

function xhrJson(url, { method = 'POST', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = 'json';
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.addEventListener('load', () => {
      let body2 = xhr.response;
      if (body2 == null) { try { body2 = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ } }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body2);
      else {
        const msg = body2 && body2.message ? body2.message : `服务端返回 HTTP ${xhr.status}`;
        reject(new Error(msg));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('CORS_OR_NETWORK')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));
    xhr.timeout = 60_000;
    xhr.send(body == null ? null : JSON.stringify(body));
  });
}

/**
 * 文本上传统一入口。resolve({url, meta?, apiUrl?}) 或 reject(Error)。
 * @param {string} service TEXT_SERVICES 键
 * @param {string} text 待分享文本
 * @param {string} name 文件名（gist/paste.gg 用）
 * @param {string} token GitHub token（仅 gist 用；可空串则自动复用图床已填 token）
 */
export async function textUpload(service, text, name, token = '') {
  if (service === 'rentry') {
    const body = new URLSearchParams({ text, edit_code: '' }).toString();
    const r = parseRentry(JSON.parse(await xhrText('https://rentry.co/api/new', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
    })));
    return { url: r.url, meta: { editCode: r.editCode } };
  }
  if (service === 'dpaste') {
    const body = new URLSearchParams({ content: text, syntax: 'text', expiry_days: '7' }).toString();
    const r = parseDpaste(await xhrText('https://dpaste.com/api/v2/', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
    }));
    return { url: r.url, meta: { rawUrl: r.rawUrl } };
  }
  if (service === 'pastegg') {
    const r = parsePasteGG(await xhrJson('https://api.paste.gg/v1/pastes', {
      headers: { 'Content-Type': 'application/json' },
      body: { name: null, visibility: 'unlisted', files: [{ name: name || null, content: { format: 'text', value: text } }] },
    }));
    return { url: r.url, meta: { deletionKey: r.deletionKey } };
  }
  if (service === 'gist') {
    const tk = token || getGhToken();
    if (!tk) throw new Error('请先粘贴 GitHub 访问令牌（token 仅保存在本页内存）');
    const fname = gistFileName(name);
    const r = parseGist(await xhrJson('https://api.github.com/gists', {
      headers: {
        Authorization: `Bearer ${tk}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: { description: name || 'shared via pdftools', public: false, files: { [fname]: { content: text } } },
    }), fname);
    return { url: r.url, meta: { rawUrl: r.rawUrl } };
  }
  if (service === 'onlyfiles' || service === 'tmpfiles') {
    const apiUrl = FILEBED_SERVICES[service].api;
    const file = new File([text], gistFileName(name), { type: 'text/plain' });
    const { url } = await uploadOne(apiUrl, file);
    return { url, apiUrl };
  }
  throw new Error('未知文本床服务');
}

registerTool({
  id: 'textbed',
  name: '文本床',
  group: 'm-util',
  desc: '把文本/代码/日志一键生成公开分享链接（rentry/dpaste/paste.gg/Gist 等 6 个服务），记录本地永久保存可检测失效与重传',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    let service = 'rentry';

    const notice = document.createElement('div');
    notice.className = 'alert alert-warn';
    notice.style.marginTop = '14px';
    function updateNotice() {
      const s = TEXT_SERVICES[service];
      notice.textContent = `本工具会把文本上传到第三方文本床（${s.host}）生成公开分享链接，请勿分享敏感内容。单次 ≤ ${s.maxKB}KB。`;
    }

    const { card, body } = paramsCard();

    const ta = document.createElement('textarea');
    ta.rows = 8;
    ta.style.cssText = 'width:100%;min-height:180px;resize:vertical;font-family:var(--mono);font-size:13px';
    ta.placeholder = '粘贴要分享的文本、代码、日志、配置…';
    ta.setAttribute('aria-label', '分享文本内容');
    ta.setAttribute('data-no-snapshot', ''); // 全文已存上传登记册，任务历史表单快照不再重复存
    const countHint = document.createElement('div');
    countHint.className = 'hint';
    function updateCount() {
      const bytes = new TextEncoder().encode(ta.value).length;
      const s = TEXT_SERVICES[service];
      countHint.textContent = ta.value ? `${ta.value.length} 字符 · ${fmtBytes(bytes)}${bytes > s.maxKB * 1024 ? `（超出 ${s.host} 的 ${s.maxKB}KB 上限）` : ''}` : '支持任意文本 / 代码 / 日志；内容将公开，请勿包含密码或隐私信息';
    }
    ta.addEventListener('input', updateCount);

    const nameInp = textInput('notes.txt', 'notes.txt（gist/paste.gg 的文件名）');

    const svcSel = select(
      Object.entries(TEXT_SERVICES).map(([id, s]) => ({ value: id, label: s.label })),
      service,
    );
    svcSel.setAttribute('aria-label', '文本床服务');
    const svcHint = document.createElement('div');
    svcHint.className = 'hint';
    const svcField = field('分享服务', svcSel);
    svcField.appendChild(svcHint);

    const tokenInp = passwordInput('ghp_…（仅保存在本页内存；图床工具已填过则可留空自动复用）');
    tokenInp.setAttribute('aria-label', 'GitHub 访问令牌（文本床）');
    const tokenField = field('访问令牌（token）', tokenInp, 'GitHub → Settings → Developer settings → Personal access tokens（勾选 gists 创建权限）');

    function syncVisible() {
      const s = TEXT_SERVICES[service];
      svcHint.textContent = s.shareNote;
      tokenField.style.display = service === 'gist' ? '' : 'none';
      updateNotice();
      updateCount();
    }
    svcSel.addEventListener('change', () => { service = svcSel.value; syncVisible(); });
    syncVisible();
    body.append(
      field('分享内容', ta),
      field('文件名', nameInp, '作为分享标题与 gist/paste.gg 的文件名'),
      svcField,
      tokenField,
      countHint,
    );

    const goBtn = button('生成分享链接', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;
    ta.addEventListener('input', () => { goBtn.disabled = !ta.value.trim(); });

    const resultBox = document.createElement('div');
    container.append(notice, card, goBtn, resultBox);

    function linkRow(url, meta) {
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.style.wordBreak = 'break-all';
      nm.textContent = url;
      info.appendChild(nm);
      if (meta && meta.rawUrl) {
        const sn = document.createElement('div');
        sn.className = 'hint';
        sn.style.wordBreak = 'break-all';
        sn.textContent = `raw 直链：${meta.rawUrl}`;
        info.appendChild(sn);
      }
      if (meta && meta.editCode) {
        const sn = document.createElement('div');
        sn.className = 'hint';
        sn.textContent = `编辑码已保存在「上传记录」（edit_code：${meta.editCode}），凭它可修改该贴内容`;
        info.appendChild(sn);
      }
      line.appendChild(info);
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap';
      const mkCopy = (label, text) => button(label, 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(text); toast(`已复制${label}`); }
        catch { toast('复制失败', 'error'); }
      });
      right.appendChild(mkCopy('链接', url));
      if (meta && meta.rawUrl) right.appendChild(mkCopy('raw 直链', meta.rawUrl));
      right.appendChild(button('打开', 'btn-outline btn-sm', () => window.open(url, '_blank', 'noopener')));
      line.appendChild(right);
      return line;
    }

    function corsHelp() {
      const box = document.createElement('div');
      box.className = 'alert alert-error';
      box.style.marginTop = '10px';
      const head = document.createElement('div');
      head.textContent = '上传请求已发出，但浏览器读不到服务端响应（跨域 CORS 限制）。请改用其它分享服务（下拉切换），或检查网络。';
      box.appendChild(head);
      return box;
    }

    async function exec() {
      resultBox.replaceChildren();
      const text = ta.value;
      if (!text.trim()) { toast('请先粘贴要分享的文本', 'error'); return; }
      const s = TEXT_SERVICES[service];
      const name = (nameInp.value || '').trim() || 'notes.txt';
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > s.maxKB * 1024) { toast(`内容 ${fmtBytes(bytes)} 超出 ${s.host} 的 ${s.maxKB}KB 上限`, 'error'); return; }

      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      const bodyEl = document.createElement('div');
      bodyEl.className = 'card-body';
      const head = document.createElement('div');
      head.className = 'hint';
      head.textContent = `上传中：${name}（${fmtBytes(bytes)}）`;
      bodyEl.appendChild(head);
      cardEl.appendChild(bodyEl);
      resultBox.appendChild(cardEl);
      goBtn.disabled = true;
      try {
        const { url, meta, apiUrl } = await textUpload(service, text, name, tokenInp.value.trim());
        head.remove();
        bodyEl.appendChild(linkRow(url, meta || {}));
        const done = document.createElement('div');
        done.className = 'hint';
        done.style.marginTop = '8px';
        done.textContent = '已存入「上传记录」，可检测失效或重传';
        bodyEl.appendChild(done);
        addUpload({
          name, size: bytes, type: 'text/plain',
          service, host: s.host, url, apiUrl: apiUrl || '', meta: meta || null,
          bytes: new Blob([text], { type: 'text/plain' }),
        }).catch(() => { /* 登记失败不阻塞结果 */ });
        recordTaskOrButton({
          tool: 'textbed', toolName: '文本床',
          docNames: [], // 纯文本分享无输入文件，避免 resolveInputs 按名误抓全局文档
          options: { 服务: s.host, 成功: 1 },
          docs: [],
          outputs: [],
          form: capturePageForm(),
        }).then((btn) => {
          if (btn) bodyEl.appendChild(btn);
          else bodyEl.appendChild(recordNote());
        }).catch(() => { /* 记录失败不阻塞结果展示 */ });
      } catch (e) {
        head.remove();
        if (e.message === 'CORS_OR_NETWORK') {
          cardEl.insertBefore(corsHelp(), bodyEl);
        } else {
          const err = document.createElement('div');
          err.className = 'alert alert-error';
          err.textContent = `分享失败：${e.message}`;
          bodyEl.appendChild(err);
        }
      } finally {
        goBtn.disabled = !ta.value.trim();
      }
    }
  },
});
