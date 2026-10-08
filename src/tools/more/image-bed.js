// 图床（更多 · 联网工具）：把图片上传到图床服务，一键生成 URL/Markdown/HTML/BBCode
// 多格式外链。服务预设（2026-10 实测）：带 CORS 且直链稳定的匿名公共图床不存在
// （freeimage 要 key、iili 404、sm.ms 匿名 401、pixhost 400），因此稳定直链路径 = GitHub
// 仓库（api.github.com 官方支持 CORS，raw.githubusercontent.com 稳定直链）；onlyfiles/
// tmpfiles 无 key 可直传但分享链接为预览页（站方直链动态签名，不支持嵌入）；yohuo 稳定
// 直链但无 CORS（中转方案见文件床工具/docs/filebed-proxy.md）。
// 隐私红线：GitHub token 只存本页内存（password 输入框不进表单快照、不落任何持久化），
// 历史记录只记仓库与文件名。上传成功即写入「上传登记册」（uploads.js），可在侧边栏
// 「上传记录」页管理/检测失效/一键重传。
import { registerTool } from '../core.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, passwordInput, button, toast, select } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { fmtBytes } from '../../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';
import { addUpload, formatLinks } from '../../core/uploads.js';
import { SERVICES as FILEBED_SERVICES, uploadOne, parseUploadResponse, uploadUrlOf, WORKER_SRC } from './filebed.js';

const LS_KEY = 'pdftoolkit.imagebed.ghcfg'; // 仅存 owner/repo/branch/path（非敏感）；token 绝不落盘
export const GH_MAX_MB = 40; // Contents API JSON body 现实上限（base64 后 ~54MB）
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'];

export const IMAGE_SERVICES = {
  github: {
    label: 'GitHub 仓库 · 稳定直链可嵌入（推荐，需 token）',
    host: 'github.com', maxMB: GH_MAX_MB, embed: true,
    shareNote: 'raw.githubusercontent.com 稳定直链，可直接嵌入 Markdown / 网页 / 论坛',
  },
  onlyfiles: { ...FILEBED_SERVICES.onlyfiles },
  tmpfiles: { ...FILEBED_SERVICES.tmpfiles },
  yohuo: { ...FILEBED_SERVICES.yohuo },
  custom: { ...FILEBED_SERVICES.custom },
};

/** GitHub token 仅存本页内存：刷新即清，绝不写 localStorage/IndexedDB/历史/URL */
let ghTokenMem = '';

function loadGhCfg() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveGhCfg(cfg) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

/** 上传路径构建：前缀清洗 + 可读原名，冲突时加时间戳（导出供单测） */
export function buildGhPath(name, prefix = 'pdftoolkit', conflict = false) {
  const dir = String(prefix || 'pdftoolkit').replace(/^\/+|\/+$/g, '').replace(/[/\\]+/g, '-');
  const base = String(name || 'image.png').replace(/[/\\]+/g, '_');
  return conflict ? `${dir}/${Date.now().toString(36)}-${base}` : `${dir}/${base}`;
}

/** GitHub 错误码转可读信息（导出供单测） */
export function ghErrMsg(status, bodyMsg = '') {
  if (status === 401) return 'token 无效或已过期（需 repo 内容读写权限）';
  if (status === 403) return 'token 权限不足或触发限流';
  if (status === 404) return '仓库或分支不存在（检查 owner/repo/分支名，token 需有该仓库写权限）';
  if (status === 422) return '同名文件已存在且内容不同';
  return bodyMsg || `GitHub API 返回 HTTP ${status}`;
}

function blobToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/** GitHub Contents API 上传：resolve({url}) 或 reject(Error)；422 同名冲突自动加时间戳重试一次 */
export async function ghUpload(cfg, file, token) {
  if (!token) throw new Error('请先粘贴 GitHub 访问令牌（token 仅保存在本页内存，刷新后需重新粘贴）');
  const doPut = async (path) => {
    const resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ message: `upload ${file.name} via pdftools`, content: await blobToB64(file), branch: cfg.branch || 'main' }),
      },
    );
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body?.content?.download_url) return { url: body.content.download_url };
    if (resp.status === 422) return { conflict: true };
    throw new Error(ghErrMsg(resp.status, body?.message));
  };
  let r = await doPut(buildGhPath(file.name, cfg.path));
  if (r.conflict) r = await doPut(buildGhPath(file.name, cfg.path, true));
  if (r.conflict) throw new Error(ghErrMsg(422));
  return r;
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

registerTool({
  id: 'image-bed',
  name: '图床',
  group: 'm-util',
  desc: '上传图片一键生成 Markdown/HTML/BBCode 外链（GitHub 稳定直链 / 免费直传服务），上传记录本地永久保存可检测失效',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const state = { docs: [] };
    const savedGh = loadGhCfg();
    let service = 'github';

    const notice = document.createElement('div');
    notice.className = 'alert alert-warn';
    notice.style.marginTop = '14px';
    function updateNotice() {
      const s = IMAGE_SERVICES[service];
      notice.textContent = `本工具会把图片上传到所选图床服务（${s.host || '自定义服务'}）生成公开外链，请勿上传隐私图片。支持格式：${IMAGE_EXTS.join(' / ')}，单文件 ≤ ${s.maxMB}MB。`;
    }

    const acceptTest = new RegExp(`\\.(${IMAGE_EXTS.join('|')})$`, 'i');
    const panel = inputPanel({
      multiple: true,
      accept: IMAGE_EXTS.map((e) => `.${e}`).join(','),
      acceptTest,
      acceptHint: `可多选图片（${IMAGE_EXTS.join(' / ')}）`,
      onAdd() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
      onRemove() { state.docs = panel.docs(); goBtn.disabled = !state.docs.length; },
    });

    const { card, body } = paramsCard();

    const svcSel = select(
      Object.entries(IMAGE_SERVICES).map(([id, s]) => ({ value: id, label: s.label })),
      service,
    );
    svcSel.setAttribute('aria-label', '图床服务');
    const svcHint = document.createElement('div');
    svcHint.className = 'hint';
    const svcField = field('图床服务', svcSel);
    svcField.appendChild(svcHint);

    // GitHub 专属字段（仅 github 服务显示）
    const ghWrap = document.createElement('div');
    const mkInp = (val, ph, onChange) => {
      const i = textInput(val, ph);
      i.addEventListener('change', () => onChange(i.value.trim()));
      return i;
    };
    const ghCfg = { owner: savedGh.owner || '', repo: savedGh.repo || '', branch: savedGh.branch || 'main', path: savedGh.path || 'pdftoolkit' };
    const ownerInp = mkInp(ghCfg.owner, '用户名或组织', (v) => { ghCfg.owner = v; saveGhCfg(ghCfg); });
    const repoInp = mkInp(ghCfg.repo, '仓库名（需为公开仓库）', (v) => { ghCfg.repo = v; saveGhCfg(ghCfg); });
    const branchInp = mkInp(ghCfg.branch, 'main', (v) => { ghCfg.branch = v || 'main'; saveGhCfg(ghCfg); });
    const pathInp = mkInp(ghCfg.path, 'pdftoolkit', (v) => { ghCfg.path = v || 'pdftoolkit'; saveGhCfg(ghCfg); });
    const tokenInp = passwordInput('ghp_…（仅保存在本页内存，刷新后需重新粘贴）');
    tokenInp.addEventListener('input', () => { ghTokenMem = tokenInp.value.trim(); });
    ghWrap.append(
      field('GitHub 用户 / 组织', ownerInp),
      field('仓库名', repoInp, '公开仓库；建议专门建一个图床仓库（免费 100MB+，图片永久保存）'),
      field('分支', branchInp),
      field('目录前缀', pathInp, '上传到仓库内的子目录'),
      field('访问令牌（token）', tokenInp, 'GitHub → Settings → Developer settings → Personal access tokens（fine-grained，勾选该仓库 Contents 读写）。仅存本页内存，绝不写入本地存储或历史'),
    );

    const epInp = textInput('', 'https://img.example.com');
    epInp.addEventListener('change', () => {
      const v = epInp.value.trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\//i.test(v)) { toast('服务地址需以 http(s):// 开头', 'error'); }
    });
    const epField = field('服务地址', epInp, '仅自定义端点时需要：telegraph / tmpfiles 兼容响应均可自动识别');

    function syncVisible() {
      ghWrap.style.display = service === 'github' ? '' : 'none';
      epField.style.display = service === 'custom' ? '' : 'none';
      const s = IMAGE_SERVICES[service];
      svcHint.textContent = s.shareNote || '填站点根地址，自动 POST {地址}/upload；响应需为 JSON（格式自动识别）';
      updateNotice();
    }
    svcSel.addEventListener('change', () => { service = svcSel.value; syncVisible(); });
    syncVisible();
    body.append(svcField, ghWrap, epField);

    const goBtn = button('上传到图床', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(notice, panel.el, card, goBtn, resultBox);

    function linkRow(url, name, embed, shareNote) {
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
      const L = formatLinks(url, name);
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap';
      const mkCopy = (label, text) => button(label, 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(text); toast(`已复制${label}`); }
        catch { toast('复制失败', 'error'); }
      });
      right.appendChild(mkCopy('链接', L.url));
      right.appendChild(mkCopy('Markdown', L.markdown));
      if (embed) {
        right.appendChild(mkCopy('HTML', L.html));
        right.appendChild(mkCopy('BBCode', L.bbcode));
      }
      right.appendChild(button('打开', 'btn-outline btn-sm', () => window.open(url, '_blank', 'noopener')));
      line.appendChild(right);
      return line;
    }

    function corsHelp() {
      const box = document.createElement('div');
      box.className = 'alert alert-error';
      box.style.marginTop = '10px';
      const head = document.createElement('div');
      head.textContent = '上传请求已发出，但浏览器读不到服务端响应（跨域 CORS 限制）。文件可能已上传成功，但无法自动取回链接。建议改用「GitHub 仓库」服务（官方支持 CORS，全自动取链 + 稳定直链），或按文件床工具内的 Cloudflare Worker 中转方案部署后选「自定义端点」。';
      box.appendChild(head);
      const copyBtn = button('复制 Worker 代码', 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(WORKER_SRC); toast('已复制，去 Cloudflare Dashboard 粘贴部署即可'); }
        catch { toast('复制失败', 'error'); }
      });
      copyBtn.style.marginTop = '8px';
      box.appendChild(copyBtn);
      return box;
    }

    async function exec() {
      const docs = [...state.docs];
      resultBox.replaceChildren();
      if (!docs.length) { toast('请先选择图片', 'error'); return; }
      const s = IMAGE_SERVICES[service];
      if (service === 'github' && (!ghCfg.owner || !ghCfg.repo)) { toast('请先填写 GitHub 用户名与仓库名', 'error'); return; }
      let apiUrl = '';
      if (service === 'custom') {
        const ep = (epInp.value || '').trim();
        if (!/^https?:\/\//i.test(ep)) { toast('请填写正确的服务地址（http(s):// 开头）', 'error'); return; }
        apiUrl = uploadUrlOf(ep);
      }
      for (const d of docs) {
        const ext = extOf(d.name);
        if (!IMAGE_EXTS.includes(ext)) { toast(`不支持的图片类型：${d.name}（支持 ${IMAGE_EXTS.join('/')}）`, 'error', 5000); return; }
        if (d.size > s.maxMB * 1024 * 1024) { toast(`图片 ${d.name} 超过 ${s.maxMB}MB 上限`, 'error'); return; }
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
          const tail = list.querySelectorAll('.ib-head');
          tail.forEach((n) => n.remove());
          head.className += ' ib-head';
          list.appendChild(head);
          try {
            let url;
            if (service === 'github') {
              ({ url } = await ghUpload({ ...ghCfg }, doc.file, ghTokenMem));
            } else {
              ({ url } = await uploadOne(apiUrl, doc.file, (p) => {
                head.textContent = `上传中 ${i + 1}/${docs.length}：${doc.name}（${Math.round(p * 100)}%）`;
              }));
            }
            results.push({ name: doc.name, url });
            list.appendChild(linkRow(url, doc.name, s.embed, s.shareNote || ''));
            addUpload({
              name: doc.name, size: doc.size, type: doc.file.type || '',
              service, host: s.host, url, apiUrl: service === 'github' ? '' : apiUrl, bytes: doc.file,
            }).catch(() => { /* 登记失败不阻塞上传结果 */ });
          } catch (e) {
            if (e.message === 'CORS_OR_NETWORK') { hadCorsError = true; break; }
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
        done.textContent = `成功 ${results.length}/${docs.length} 个；已存入「上传记录」，可复制多格式外链、检测失效或一键重传`;
        list.appendChild(done);
      }
      recordTaskOrButton({
        tool: 'image-bed', toolName: '图床',
        docNames: docs.map((d) => d.name),
        options: { 服务: s.host || '自定义', 仓库: service === 'github' ? `${ghCfg.owner}/${ghCfg.repo}` : undefined, 成功: results.length },
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
