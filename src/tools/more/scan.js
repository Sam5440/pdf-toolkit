// 扫描件转 PDF（更多 · 对齐 PDF24 scan-to-pdf）：getUserMedia 拍照 → 多张缩略图管理 → JPEG 合成 PDF
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { button, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'scan',
  name: '扫描件转 PDF',
  group: 'm-topdf',
  desc: '摄像头拍摄多张照片合成 PDF',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { stream: null, shots: [] }; // shots: {canvas, thumb}

    const note = document.createElement('div');
    note.className = 'note';
    note.style.marginBottom = '12px';
    note.textContent = '调用本机摄像头逐页拍摄，图像仅在本地处理、不上传；拍完后合成 PDF。';

    // ---- 摄像头预览卡 ----
    const { card: camCard, body: camBody } = paramsCard();
    const video = document.createElement('video');
    video.setAttribute('data-scan-video', '');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText = 'width:100%;max-width:560px;aspect-ratio:4/3;object-fit:contain;background:#111;border-radius:8px;display:block';
    camBody.appendChild(video);

    const camOps = document.createElement('div');
    camOps.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
    const openBtn = button('打开摄像头', 'btn-primary', () => startCam());
    const closeBtn = button('关闭摄像头', 'btn-outline', () => stopCam());
    closeBtn.disabled = true;
    const captureBtn = button('拍照', 'btn-primary', () => capture());
    captureBtn.setAttribute('data-scan-capture', '');
    captureBtn.disabled = true;
    camOps.append(openBtn, closeBtn, captureBtn);
    camBody.appendChild(camOps);

    // ---- 拍摄结果卡 ----
    const { card, body } = paramsCard();
    const thumbs = document.createElement('div');
    thumbs.setAttribute('data-scan-thumbs', '');
    thumbs.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:4px';
    body.appendChild(thumbs);
    const emptyHint = document.createElement('div');
    emptyHint.className = 'hint';
    emptyHint.textContent = '尚未拍摄';
    thumbs.appendChild(emptyHint);

    const doneBtn = button('合成 PDF', 'btn-primary', () => exec());
    doneBtn.setAttribute('data-scan-done', '');
    doneBtn.style.cssText = 'width:100%;margin-top:14px';
    doneBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(note, camCard, card, doneBtn, resultBox);

    async function startCam() {
      if (!navigator.mediaDevices?.getUserMedia) {
        toast('当前环境不支持摄像头（需 HTTPS 或 localhost）', 'error');
        return;
      }
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1600 }, height: { ideal: 1200 } },
          audio: false,
        });
      } catch (e) {
        toast(`无法打开摄像头：${e.message || e.name}`, 'error', 5000);
        return;
      }
      video.srcObject = state.stream;
      try { await video.play(); } catch { /* 自动播放失败时用户可点击 video */ }
      openBtn.disabled = true;
      closeBtn.disabled = false;
      captureBtn.disabled = false;
    }

    function stopCam() {
      state.stream?.getTracks().forEach((t) => t.stop());
      state.stream = null;
      video.srcObject = null;
      openBtn.disabled = false;
      closeBtn.disabled = true;
      captureBtn.disabled = true;
    }

    function capture() {
      if (!video.videoWidth || !video.videoHeight) {
        toast('摄像头尚未就绪，请稍候', 'error');
        return;
      }
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      state.shots.push({ canvas: c, thumb: c.toDataURL('image/jpeg', 0.7) });
      renderThumbs();
    }

    function renderThumbs() {
      thumbs.innerHTML = '';
      if (!state.shots.length) {
        const h = document.createElement('div');
        h.className = 'hint';
        h.textContent = '尚未拍摄';
        thumbs.appendChild(h);
      }
      state.shots.forEach((s, i) => {
        const item = document.createElement('div');
        item.setAttribute('data-scan-thumb', '');
        item.style.cssText = 'position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden';
        const img = document.createElement('img');
        img.src = s.thumb;
        img.alt = `第 ${i + 1} 张`;
        img.style.cssText = 'width:130px;height:98px;object-fit:cover;display:block';
        const idx = document.createElement('div');
        idx.style.cssText = 'position:absolute;top:4px;left:6px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;padding:1px 7px;border-radius:10px';
        idx.textContent = String(i + 1);
        const del = button('删除', 'btn-danger btn-sm', () => {
          state.shots.splice(i, 1);
          renderThumbs();
        });
        del.style.cssText = 'position:absolute;bottom:4px;right:4px;padding:2px 8px';
        item.append(img, idx, del);
        thumbs.appendChild(item);
      });
      doneBtn.disabled = !state.shots.length;
    }

    const exec = runWithProgress(resultBox, async (setP) => {
      const shots = [...state.shots];
      if (!shots.length) throw new Error('请先拍照');
      const images = [];
      for (let i = 0; i < shots.length; i++) {
        setP((i / shots.length) * 70, `编码第 ${i + 1}/${shots.length} 张…`);
        const blob = await new Promise((r) => shots[i].canvas.toBlob(r, 'image/jpeg', 0.9));
        images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', name: `扫描页${i + 1}.jpg` });
      }
      const res = await run('images.toPdf', {
        images,
        paper: 'auto',
        orientation: 'auto',
        margin: 0,
        fit: 'contain',
      }, {
        onProgress: (p) => setP(p.total ? 70 + (p.done / p.total) * 30 : 85, p.stage),
      }, new Map());
      res.artifacts = res.artifacts.map((a) => ({ ...a, name: '扫描件.pdf' }));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages },
        toolId: 'scan', toolName: '扫描件转 PDF',
        docNames: shots.map((_, i) => `拍照 ${i + 1}`),
        options: { pages: shots.length },
      }));
      return res;
    });
  },
});
