// 文本加解密（更多 · 常见算法）：AES/DES/3DES/RC4 + Base64/URL 编解码，crypto-js 本地完成。
// 密钥仅在内存使用，绝不写入历史/表单快照之外的持久化（options 只记算法与方向）。
import { registerTool } from '../core.js';
import CryptoJS from 'crypto-js';
import { field, select, passwordInput, button, toast } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';

const CIPHERS = {
  aes: CryptoJS.AES,
  des: CryptoJS.DES,
  tripledes: CryptoJS.TripleDES,
  rc4: CryptoJS.RC4,
};

export function cipherEncrypt(algo, text, key) {
  return CIPHERS[algo].encrypt(text, key).toString();
}

export function cipherDecrypt(algo, text, key) {
  let out = '';
  try {
    out = CIPHERS[algo].decrypt(text, key).toString(CryptoJS.enc.Utf8);
  } catch {
    throw new Error('解密失败：密钥错误或密文格式不正确');
  }
  if (!out) throw new Error('解密失败：密钥错误或密文格式不正确');
  return out;
}

export function b64Encode(text) {
  return CryptoJS.enc.Utf8.parse(text).toString(CryptoJS.enc.Base64);
}

export function b64Decode(text) {
  let out = '';
  try {
    const words = CryptoJS.enc.Base64.parse(text.replace(/\s+/g, ''));
    out = words.toString(CryptoJS.enc.Utf8);
  } catch {
    throw new Error('Base64 解码失败：内容不是有效的 Base64 文本');
  }
  if (!out && text.replace(/\s+/g, '')) throw new Error('Base64 解码失败：内容不是有效的 Base64 文本');
  return out;
}

registerTool({
  id: 'crypt',
  name: '文本加解密',
  group: 'm-util',
  desc: 'AES/DES/3DES/RC4 加解密与 Base64/URL 编解码，密钥不落盘',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const { card, body } = paramsCard();

    const inp = document.createElement('textarea');
    inp.rows = 4;
    inp.placeholder = '输入要加密/解密的文本';
    inp.setAttribute('data-crypt-in', '');
    body.appendChild(field('输入', inp));

    const algoSel = select([
      { value: 'aes', label: 'AES（推荐）' },
      { value: 'des', label: 'DES（经典）' },
      { value: 'tripledes', label: 'Triple DES（3DES）' },
      { value: 'rc4', label: 'RC4（流密码）' },
      { value: 'base64', label: 'Base64 编解码' },
      { value: 'url', label: 'URL 编解码' },
    ], 'aes');
    algoSel.setAttribute('data-crypt-algo', '');
    body.appendChild(field('算法', algoSel));

    const modeSel = select([
      { value: 'enc', label: '加密 / 编码' },
      { value: 'dec', label: '解密 / 解码' },
    ], 'enc');
    modeSel.setAttribute('data-crypt-mode', '');
    body.appendChild(field('方向', modeSel));

    const keyInp = passwordInput('加密/解密密钥');
    keyInp.setAttribute('data-crypt-key', '');
    body.appendChild(field('密钥', keyInp, '口令式密钥，仅用于本次计算，不会被保存或记录'));

    const goBtn = button('执行加解密', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';

    const outBox = document.createElement('div');
    const resultBox = document.createElement('div');
    container.append(card, goBtn, outBox, resultBox);

    function needKey() {
      return algoSel.value !== 'base64' && algoSel.value !== 'url';
    }
    function syncKey() {
      keyInp.parentElement.style.display = needKey() ? '' : 'none';
    }
    algoSel.addEventListener('change', syncKey);
    syncKey();

    function showResult(text, options) {
      outBox.replaceChildren();
      const wrap = document.createElement('div');
      wrap.className = 'card';
      wrap.style.marginTop = '14px';
      const wb = document.createElement('div');
      wb.className = 'card-body';
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.textContent = '输出';
      const meta = document.createElement('div');
      meta.className = 'ra-meta';
      meta.setAttribute('data-crypt-out', '');
      meta.style.cssText = 'word-break:break-all;white-space:pre-wrap;max-height:240px;overflow:auto;color:var(--foreground)';
      meta.textContent = text;
      info.append(nm, meta);
      line.append(info, button('复制', 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
        catch { toast('复制失败', 'error'); }
      }));
      wb.appendChild(line);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      recordTaskOrButton({
        tool: 'crypt', toolName: '文本加解密',
        docNames: [],
        options: { 算法: options.algoLabel, 方向: options.modeLabel, 长度: text.length },
        docs: [],
        outputs: [],
        form: capturePageForm(),
      }).then((btn) => {
        if (btn) actions.appendChild(btn);
        else wb.appendChild(recordNote());
      }).catch(() => { /* 记录失败不阻塞结果展示 */ });
      wb.appendChild(actions);
      wrap.appendChild(wb);
      outBox.appendChild(wrap);
    }

    function exec() {
      resultBox.replaceChildren();
      const text = inp.value;
      if (!text) { toast('请输入内容', 'error'); return; }
      const algo = algoSel.value;
      const mode = modeSel.value;
      const algoLabel = algoSel.selectedOptions[0]?.textContent || algo;
      const modeLabel = modeSel.selectedOptions[0]?.textContent || mode;
      try {
        let out = '';
        if (algo === 'base64') {
          out = mode === 'enc' ? b64Encode(text) : b64Decode(text);
        } else if (algo === 'url') {
          try {
            out = mode === 'enc' ? encodeURIComponent(text) : decodeURIComponent(text.replace(/\+/g, '%20'));
          } catch {
            throw new Error('URL 解码失败：内容不是有效的百分号编码');
          }
        } else {
          const key = keyInp.value;
          if (!key) { toast('请输入密钥', 'error'); return; }
          out = mode === 'enc' ? cipherEncrypt(algo, text, key) : cipherDecrypt(algo, text, key);
        }
        showResult(out, { algoLabel, modeLabel });
      } catch (e) {
        const err = document.createElement('div');
        err.className = 'alert alert-error';
        err.style.marginTop = '14px';
        err.textContent = e.message || '处理失败';
        resultBox.appendChild(err);
      }
    }
  },
});
