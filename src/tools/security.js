// 密码保护 — AES-256 加密（含权限控制）与解密移除，两个子模式
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { progressCard, warningsBox, toast, field, passwordInput, checkbox, row, button } from '../components/ui.js';
import { fmtBytes, esc } from '../core/format.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { downloadArtifact } from '../core/download.js';

const PERMS = [
  ['print', '打印'],
  ['printHq', '高清晰度打印'],
  ['copy', '复制文本与图像'],
  ['modify', '修改内容'],
  ['annotate', '批注与填写表单域'],
  ['forms', '填写表单字段'],
  ['assemble', '组装页面（插入/删除/旋转）'],
];

registerTool({
  id: 'security',
  name: '密码保护',
  group: 'security',
  desc: '设置/移除打开密码与权限（AES-256），错误密码明确提示',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    // ── 子模式 tab ──
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:8px;margin-bottom:14px';
    const tabEnc = button('设置密码 / 权限', 'btn-primary', () => switchTab('enc'));
    const tabDec = button('移除密码 / 解密', 'btn-outline', () => switchTab('dec'));
    tabs.append(tabEnc, tabDec);

    const panelEnc = inputPanel({ multiple: false, accept: 'application/pdf,.pdf', acceptHint: '要加密的 PDF（处理全程本地完成）' });
    const panelDec = inputPanel({ multiple: false, accept: 'application/pdf,.pdf', acceptHint: '已加密的 PDF（处理全程本地完成）' });

    // ── 加密参数卡 ──
    const encCard = document.createElement('div');
    encCard.className = 'card';
    encCard.style.marginTop = '14px';
    const encBody = document.createElement('div');
    encBody.className = 'card-body';
    const warn = document.createElement('div');
    warn.className = 'alert alert-warn';
    warn.style.marginBottom = '12px';
    warn.textContent = '密码不会存储、无法找回；引擎限制：密码不能包含英文逗号（,）和等号（=）。';
    encBody.appendChild(warn);
    const userPw = passwordInput('打开密码（用户密码，可选）');
    const userPw2 = passwordInput('再次输入打开密码');
    const ownerPw = passwordInput('所有者密码（控制权限，可选）');
    encBody.appendChild(field('打开密码', row(userPw, userPw2), '两个输入框必须一致；仅设所有者密码时留空打开密码'));
    encBody.appendChild(field('所有者密码（可选）', ownerPw));
    const permBox = document.createElement('div');
    permBox.className = 'field';
    const pl = document.createElement('label');
    pl.textContent = '允许的权限（AES-256）';
    permBox.appendChild(pl);
    const permChecks = {};
    for (const [k, label] of PERMS) {
      const c = checkbox(label, true);
      permChecks[k] = c._input;
      permBox.appendChild(c);
    }
    encBody.appendChild(permBox);
    const encGo = button('开始加密', 'btn-primary', () => doEncrypt());
    encGo.style.width = '100%';
    encBody.appendChild(encGo);
    const encErr = document.createElement('div');
    encErr.style.marginTop = '10px';
    encBody.appendChild(encErr);
    encCard.appendChild(encBody);

    // ── 解密参数卡 ──
    const decCard = document.createElement('div');
    decCard.className = 'card';
    decCard.style.marginTop = '14px';
    const decBody = document.createElement('div');
    decBody.className = 'card-body';
    decBody.appendChild(field('密码', passwordInput('输入该 PDF 的打开密码')));
    const decGo = button('开始解密（移除密码）', 'btn-primary', () => doDecrypt());
    decGo.style.width = '100%';
    decBody.appendChild(decGo);
    const decErr = document.createElement('div');
    decErr.style.marginTop = '10px';
    decBody.appendChild(decErr);
    decCard.appendChild(decBody);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';
    container.append(tabs, panelEnc.el, encCard, panelDec.el, decCard, resultBox);
    panelDec.el.style.display = 'none';
    decCard.style.display = 'none';

    function switchTab(which) {
      const enc = which === 'enc';
      tabEnc.className = `btn ${enc ? 'btn-primary' : 'btn-outline'}`;
      tabDec.className = `btn ${enc ? 'btn-outline' : 'btn-primary'}`;
      panelEnc.el.style.display = enc ? '' : 'none';
      encCard.style.display = enc ? '' : 'none';
      panelDec.el.style.display = enc ? 'none' : '';
      decCard.style.display = enc ? 'none' : '';
      resultBox.innerHTML = '';
    }

    function inlineError(box, msg) {
      box.innerHTML = '';
      if (!msg) return;
      const d = document.createElement('div');
      d.className = 'alert alert-error';
      d.style.margin = '0';
      d.textContent = msg;
      box.appendChild(d);
    }

    function resultCard(art, doc, extra, options) {
      const card = document.createElement('div');
      card.className = 'card';
      const cb = document.createElement('div');
      cb.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.innerHTML = `${iconSvg('success')} 完成：<b>${esc(art.name)}</b> · ${fmtBytes(art.bytes.byteLength)}${extra ? ` · ${extra}` : ''}`;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
      actions.appendChild(button('下载', 'btn-primary', () => downloadArtifact(art)));
      cb.append(kv, actions);
      recordTaskOrButton({
        tool: 'security', toolName: '密码保护',
        docNames: [doc.name],
        options, // 含 pass/password 的键会被 history.sanitizeOptions 剔除
        docs: [doc],
        outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
        form: capturePageForm(),
      }).then((recBtn) => {
        if (recBtn) actions.appendChild(recBtn);
        else cb.appendChild(recordNote());
      });
      card.appendChild(cb);
      resultBox.appendChild(card);
    }

    async function doEncrypt() {
      inlineError(encErr, '');
      resultBox.innerHTML = '';
      const docs = panelEnc.docs();
      if (!docs.length) { inlineError(encErr, '请先选择要加密的 PDF 文件'); return; }
      const doc = docs[0];
      const up = userPw.value, up2 = userPw2.value, op = ownerPw.value;
      if (!up && !op) { inlineError(encErr, '请至少设置一个密码'); return; }
      if (up !== up2) { inlineError(encErr, '两次输入的打开密码不一致'); return; }
      for (const [label, pw] of [['打开密码', up], ['所有者密码', op]]) {
        if (pw && /[,=]/.test(pw)) { inlineError(encErr, `${label}不能包含英文逗号或等号（引擎限制）`); return; }
      }
      const permissions = {};
      for (const [k, c] of Object.entries(permChecks)) permissions[k] = c.checked;
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(40, 'AES-256 加密中…');
      encGo.disabled = true;
      try {
        const docsMap = new Map([[doc.id, doc]]);
        const res = await run('crypto.encrypt', { docId: doc.id, userPassword: up, ownerPassword: op, permissions }, {}, docsMap);
        pc.done();
        const [art] = res.artifacts;
        const bits = PERMS.filter(([k]) => permissions[k]).map(([, l]) => l).join('、') || '无';
        resultCard(art, doc, `允许权限：${bits}`, { encrypt: true, userPassword: up, ownerPassword: op, permissions });
      } catch (e) {
        pc.el.remove();
        inlineError(encErr, e.message);
      } finally {
        encGo.disabled = false;
      }
    }

    async function doDecrypt() {
      inlineError(decErr, '');
      resultBox.innerHTML = '';
      const docs = panelDec.docs();
      if (!docs.length) { inlineError(decErr, '请先选择要解密的 PDF 文件'); return; }
      const doc = docs[0];
      const pw = decBody.querySelector('input[type=password]').value;
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(40, '解密中…');
      decGo.disabled = true;
      try {
        const docsMap = new Map([[doc.id, doc]]);
        const res = await run('crypto.decrypt', { docId: doc.id, password: pw }, {}, docsMap);
        pc.done();
        const [art] = res.artifacts;
        resultCard(art, doc, '已移除密码', { decrypt: true, password: pw });
      } catch (e) {
        pc.el.remove();
        inlineError(decErr, e.code === 'ERR_WRONG_PASSWORD' || /密码/i.test(e.message)
          ? '密码错误或文件损坏，请确认后重试'
          : e.message);
      } finally {
        decGo.disabled = false;
      }
    }
  },
});
