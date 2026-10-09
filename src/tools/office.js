// Word/PPT 转 PDF — 浏览器端近似转换：
// docx-preview / pptx-preview 渲染 DOM → 每页 SVG foreignObject 栅格化 → JPEG → images.toPdf 合成。
// 诚实定位：近似转换，复杂版式（页眉页脚/复杂表格/图表/艺术字）保真度有限；产物为页面图像、文字不可选中。
import { iconSvg } from '../components/icons.js';
import { registerTool } from './core.js';
import { run } from '../core/engine.js';
import { inputPanel } from '../components/input.js';
import { progressCard, warningsBox, toast, button } from '../components/ui.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../core/tasklog.js';
import { isCJKText } from '../core/fonts.js';
import { parseFontFamilyList, getCNFontFaceRules } from '../core/cnfonts.js';

const OLD_FORMAT_RE = /\.(doc|ppt)$/i;

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取图片数据失败'));
    r.readAsDataURL(blob);
  });
}

/** 将节点内的 blob: 图片引用改写为 data URL（foreignObject 内无法加载 blob/网络资源） */
async function inlineImages(root) {
  const jobs = [];
  for (const img of root.querySelectorAll('img')) {
    if (/^blob:/i.test(img.getAttribute('src') || '')) {
      jobs.push((async () => {
        const b = await (await fetch(img.src)).blob();
        img.src = await blobToDataURL(b);
      })());
    }
  }
  for (const el of root.querySelectorAll('[style*="url("]')) {
    const style = el.getAttribute('style') || '';
    const m = /url\((['"]?)(blob:[^)'"]+)\1\)/.exec(style);
    if (m) {
      jobs.push((async () => {
        const b = await (await fetch(m[2])).blob();
        const data = await blobToDataURL(b);
        el.setAttribute('style', style.replace(m[2], data));
      })());
    }
  }
  await Promise.all(jobs);
}

/**
 * 收集节点内联样式引用的中文字体名，生成 @font-face 规则（内置中文字体 data-URI）。
 * SVG-as-image 不读取 document 网页字体，系统缺字体时中文会整体糊掉；
 * 把规则注入 SVG 内部的 <style> 才能在栅格化时生效（docx/pptx 预览库均为内联样式）。
 */
async function collectCNFontCss(node) {
  const names = new Set(parseFontFamilyList(node.getAttribute && node.getAttribute('style')));
  for (const el of node.querySelectorAll('[style]')) {
    for (const n of parseFontFamilyList(el.getAttribute('style'))) names.add(n);
  }
  let css = await getCNFontFaceRules([...names]).catch(() => '');
  // 字体名未命中内置别名但内容含中文（如方正/汉仪等商业字体）：兜底注入黑体，
  // 避免栅格化时逐字缺字。样式层面给外层容器追加兜底字体族。
  if (!css && isCJKText(node.textContent)) {
    css = await getCNFontFaceRules(['Microsoft YaHei']).catch(() => '');
  }
  return css;
}

/** DOM 节点 → JPEG bytes（SVG foreignObject 栅格化，白底，2x 采样） */
async function nodeToJpeg(node, scale = 2) {
  const rect = node.getBoundingClientRect();
  const w = Math.max(64, Math.ceil(rect.width));
  const h = Math.max(64, Math.ceil(rect.height));
  const clone = node.cloneNode(true);
  clone.style.margin = '0';
  clone.style.boxShadow = 'none';
  await inlineImages(clone);
  const fontCss = await collectCNFontCss(clone).catch(() => '');

  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden${fontCss ? `;font-family:'Microsoft YaHei','SimHei',sans-serif` : ''}">`
    + `${fontCss ? `<style>${fontCss}</style>` : ''}${xhtml}</div>`
    + `</foreignObject></svg>`;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('页面栅格化失败（DOM 含 SVG 无法内联的资源）'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

async function convertDocx(bytes, onPage, warnings) {
  const mod = await import('docx-preview');
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.appendChild(holder);
  try {
    await mod.renderAsync(bytes, holder, undefined, {
      inWrapper: true, ignoreWidth: false, ignoreHeight: false, useBase64URL: true,
    });
    const sections = holder.querySelectorAll('.docx-wrapper > section.docx');
    if (!sections.length) throw new Error('未能解析出文档页面（文件可能损坏或不是标准 .docx）');
    const out = [];
    for (let i = 0; i < sections.length; i++) {
      try {
        const jpeg = await nodeToJpeg(sections[i]);
        out.push({ name: `page_${i + 1}.jpg`, bytes: jpeg, mime: 'image/jpeg' });
      } catch (e) {
        warnings.push(`第 ${i + 1} 页栅格化失败已跳过（${e.message}）`);
      }
      onPage(i + 1, sections.length);
      await new Promise((r) => setTimeout(r, 0)); // 主线程让步
    }
    return out;
  } finally {
    holder.remove();
  }
}

async function convertPptx(bytes, onPage, warnings) {
  const mod = await import('pptx-preview');
  const init = mod.init || mod.default?.init;
  if (!init) throw new Error('pptx-preview 库不可用');
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.appendChild(holder);
  try {
    // 渲染视口宽 1280（高度按幻灯片比例自适应）；list 模式一次性渲染全部页
    const previewer = init(holder, { width: 1280, mode: 'list' });
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await previewer.preview(buf); // 不 await 会吞掉真实解析错误
    const slides = holder.querySelectorAll('.pptx-preview-slide-wrapper');
    if (!slides.length) throw new Error('未能解析出幻灯片（文件可能损坏或不是标准 .pptx）');
    const out = [];
    for (let i = 0; i < slides.length; i++) {
      try {
        const jpeg = await nodeToJpeg(slides[i]);
        out.push({ name: `slide_${i + 1}.jpg`, bytes: jpeg, mime: 'image/jpeg' });
      } catch (e) {
        warnings.push(`第 ${i + 1} 页栅格化失败已跳过（${e.message}）`);
      }
      onPage(i + 1, slides.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  } finally {
    holder.remove();
  }
}

registerTool({
  id: 'office',
  name: 'Word/PPT 转 PDF',
  group: 'convert',
  desc: '浏览器端近似转换 .docx/.pptx（复杂版式可能有偏差）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const panel = inputPanel({
      multiple: false,
      accept: '.docx,.pptx,.doc,.ppt',
      acceptHint: '支持 .docx / .pptx；旧版 .doc / .ppt 浏览器无法解析，请先另存为新格式',
      acceptTest: /\.(docx|pptx|doc|ppt)$/i,
      onAdd: (added) => {
        for (const d of added) {
          if (OLD_FORMAT_RE.test(d.name)) {
            toast(
              `「${d.name}」是旧版二进制格式，浏览器无法解析。请先用 Office/WPS 打开并另存为 .docx / .pptx`,
              'error', 5000,
            );
          }
        }
      },
    });

    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';
    const warn = document.createElement('div');
    warn.className = 'alert alert-warn';
    warn.style.marginBottom = '12px';
    warn.textContent = '浏览器端近似转换：复杂排版（页眉页脚/复杂表格/艺术字/图表）保真度有限，仅适合快速预览与简单文档；产物为页面图像、文字不可选中。需要高保真请用 Office/WPS 直接导出 PDF。';
    body.appendChild(warn);
    const goBtn = button('开始转换', 'btn-primary', () => doConvert());
    goBtn.style.width = '100%';
    body.appendChild(goBtn);
    controls.appendChild(body);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';
    container.append(panel.el, controls, resultBox);

    async function doConvert() {
      const docs = panel.docs();
      resultBox.innerHTML = '';
      if (!docs.length) { toast('请先选择 .docx 或 .pptx 文件', 'error'); return; }
      const doc = docs[0];
      if (OLD_FORMAT_RE.test(doc.name)) {
        toast('旧版 .doc/.ppt 浏览器无法解析，请先另存为 .docx/.pptx', 'error', 5000);
        return;
      }
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      goBtn.disabled = true;
      const warnings = [];
      const t0 = Date.now();
      try {
        const bytes = new Uint8Array(await doc.file.arrayBuffer());
        const isDocx = /\.docx$/i.test(doc.name);
        const pages = isDocx
          ? await convertDocx(bytes, (i, n) => pc.set((i / n) * 80, `转换第 ${i}/${n} 页`), warnings)
          : await convertPptx(bytes, (i, n) => pc.set((i / n) * 80, `转换第 ${i}/${n} 页`), warnings);
        if (!pages.length) throw new Error('没有可转换的页面');
        pc.set(85, '合成 PDF…');
        const docsMap = new Map([[doc.id, doc]]);
        const res = await run('images.toPdf', {
          images: pages.map((p) => ({ name: p.name, bytes: p.bytes, mime: p.mime })),
          paper: 'auto', orientation: 'auto', margin: 0, fit: 'contain',
        }, {}, docsMap);
        pc.done();
        renderResult(res, doc, Date.now() - t0, warnings, pages.length);
      } catch (e) {
        pc.error(e.message);
        toast(e.message, 'error', 5000);
      } finally {
        goBtn.disabled = false;
      }
    }

    function renderResult(res, doc, ms, warnings, nPages) {
      const [art] = res.artifacts;
      const card = document.createElement('div');
      card.className = 'card';
      const cb = document.createElement('div');
      cb.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.innerHTML = `${iconSvg('success')} 转换完成：<b>${nPages}</b> 页 · ${art.name} · ${art.bytes.byteLength.toLocaleString()} 字节 · 用时 ${Math.round(ms / 100) / 10}s（近似转换）`;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
      actions.appendChild(button('下载 PDF', 'btn-primary', () => {
        const url = URL.createObjectURL(new Blob([art.bytes], { type: art.mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = art.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }));
      cb.append(kv, actions);
      recordTaskOrButton({
        tool: 'office', toolName: 'Word/PPT 转 PDF',
        docNames: [doc.name],
        options: { approximate: true, pages: nPages },
        docs: [doc],
        outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
        form: capturePageForm(),
      }).then((recBtn) => {
        if (recBtn) actions.appendChild(recBtn);
        else cb.appendChild(recordNote());
      });
      const w = warningsBox(warnings);
      if (w) { w.style.marginTop = '10px'; cb.appendChild(w); }
      card.appendChild(cb);
      resultBox.appendChild(card);
    }
  },
});
