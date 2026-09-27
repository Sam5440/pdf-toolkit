#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF 体积寻优工具（单文件 · 网页面板 · 多进程并发）

一键输入任意 PDF 与目标体积，自动在多套压缩方案（模式）中以多进程并发搜索
"满足体积约束下质量最优"的解，并给出各模式最优解供用户对比研判。

模式：
  lossless 无损优化      仅结构清理/流压缩/去冗余，画质零损失
  smart    智能图片重压   xref 级重编码图片（降采样 + JPEG 重压，透明通道同步缩放），
                          文字/矢量/字体原样保留 —— 通常质量/体积比最优
  gs       Ghostscript    gs pdfwrite 全文档降采样重打包（检测到 gs 才可用）
  raster   整页栅格化     每页渲染为位图重建 PDF，任何文件都能压小（文字不可选中，兜底）

用法：
  python3 pdf_optimizer.py                 # 启动网页面板（自动开浏览器）
  python3 pdf_optimizer.py --port 8800 --no-browser
  python3 pdf_optimizer.py --cli 输入.pdf --target 20   # 命令行一键模式

依赖：pip install PyMuPDF Pillow numpy      （scikit-image 可选，SSIM 更标准；Ghostscript 可选）
"""

import argparse
import base64
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

SCRIPT_PATH = os.path.abspath(__file__)
JOBS_ROOT = os.path.join(tempfile.gettempdir(), "pdf_optimizer_jobs")
MAX_KEEP_JOBS = 6          # 启动时仅保留最近 N 个任务目录
HISTORY_ROOT = os.path.join(os.path.dirname(SCRIPT_PATH),
                            "pdf_optimizer_history")
MAX_HISTORY_JOBS = 20      # 历史记录最多保留条数（超出自动清理最旧）
MAX_HISTORY_DISK_GB = 2.0  # 历史压缩文件磁盘总占用上限
WORKER_TIMEOUT = 1800      # 单候选硬超时（秒）
EVAL_DPI = 96              # 质量评估渲染 DPI
PREVIEW_DPI = 62           # 预览图渲染 DPI

SMART_LADDER = [           # (缩放, 彩色JPEG质量, 透明通道JPEG质量)，由高质量到低质量
    (1.00, 88, 82), (0.90, 85, 78), (0.80, 82, 75), (0.70, 80, 72),
    (0.62, 76, 66), (0.55, 72, 60), (0.48, 68, 54), (0.40, 62, 46),
    (0.32, 56, 40),
]
SMART_UP_EXTRA = [(1.00, 92, 86), (1.00, 95, 90)]
SMART_BOTTOM_EXTRA = [(0.25, 50, 35), (0.20, 45, 30)]
REFINE_ROUNDS = 2          # 精搜轮数（智能/GS/栅格化通用）
REFINE_N = 3               # 每轮插值点数

GS_LADDER = [150, 132, 116, 100, 88, 76]          # 彩色/灰度图目标 DPI
RASTER_LADDER = [(120, 80), (100, 78), (84, 75), (72, 70)]  # (DPI, JPEG质量)

MODE_NAMES = {
    "lossless": "无损优化",
    "smart": "智能图片重压",
    "gs": "Ghostscript 降采样",
    "raster": "整页栅格化",
}
MODE_NOTES = {
    "lossless": "零画质损失：仅清理冗余对象、压缩交叉引用流与字体。若文件本身已高度优化，减容有限。",
    "smart": "文字/矢量/字体原样保留，仅对图片做降采样 + JPEG 重编码，256 级透明通道同步缩放；"
             "同体积档位下通常保真度最高（本工具的推荐引擎）。",
    "gs": "Ghostscript 全文档重打包，对扫描件/复杂页面稳健，文字仍可选中；缺点是参数粒度粗、"
          "文档结构被重写，个别非常规特性可能变化。",
    "raster": "整页渲染为位图后重建 PDF，任何文件都能压到目标以内；代价是文字不可选中、放大发糊，"
              "仅作兜底方案，请按用途研判。",
}


# ---------------------------------------------------------------------------
# 依赖探测
# ---------------------------------------------------------------------------

def probe_deps():
    d = {"fitz": None, "PIL": None, "numpy": None, "skimage": None, "gs": None}
    try:
        import fitz
        d["fitz"] = fitz.__doc__ or fitz.VersionBind
    except Exception:
        pass
    try:
        import PIL
        d["PIL"] = PIL.__version__
    except Exception:
        pass
    try:
        import numpy
        d["numpy"] = numpy.__version__
    except Exception:
        pass
    try:
        import skimage
        d["skimage"] = skimage.__version__
    except Exception:
        pass
    d["gs"] = shutil.which("gs")
    d["cpu"] = os.cpu_count() or 4
    return d


def require_core_deps():
    d = probe_deps()
    missing = [k for k in ("fitz", "PIL", "numpy") if not d[k]]
    if missing:
        raise RuntimeError("缺少依赖: %s，请先执行 pip install PyMuPDF Pillow numpy"
                           % ", ".join(missing))


# ---------------------------------------------------------------------------
# 质量评估：SSIM（优先 scikit-image，否则 numpy 高斯窗实现）
# ---------------------------------------------------------------------------

def ssim_score(img_a, img_b):
    """img_a/img_b: 2D uint8 ndarray"""
    try:
        from skimage.metrics import structural_similarity
        return float(structural_similarity(
            img_a, img_b, gaussian_weights=True, sigma=1.5,
            use_sample_covariance=False, data_range=255))
    except Exception:
        pass
    import numpy as np
    a = img_a.astype(np.float64)
    b = img_b.astype(np.float64)
    h, w = a.shape
    win = 11
    if min(h, w) < win:
        return 1.0 if h == img_a.shape[0] else 1.0
    # 11x11 高斯窗（sigma=1.5），分离卷积
    x = np.arange(win) - win // 2
    k1 = np.exp(-(x ** 2) / (2 * 1.5 ** 2))
    k1 /= k1.sum()

    def sep_filt(m):
        from numpy.lib.stride_tricks import sliding_window_view
        m = m.astype(np.float64)
        m = np.einsum('ijk,k->ij', sliding_window_view(m, win, axis=0), k1)
        m = np.einsum('ijk,k->ij', sliding_window_view(m, win, axis=1), k1)
        return m

    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    mua, mub = sep_filt(a), sep_filt(b)
    saa, sbb = sep_filt(a * a), sep_filt(b * b)
    sab = sep_filt(a * b)
    va = saa - mua * mua
    vb = sbb - mub * mub
    vab = sab - mua * mub
    smap = ((2 * mua * mub + c1) * (2 * vab + c2)) / \
           ((mua * mua + mub * mub + c1) * (va + vb + c2))
    return float(smap.mean())


# ---------------------------------------------------------------------------
# 图片工具
# ---------------------------------------------------------------------------

def _pil():
    from PIL import Image
    try:
        res = Image.Resampling.LANCZOS
    except AttributeError:
        res = Image.LANCZOS
    return Image, res


def jpeg_bytes(im, q, subsampling):
    from PIL import Image
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=int(q), optimize=True,
            progressive=False, subsampling=int(subsampling))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 四种压缩器（均在子进程内运行）
# ---------------------------------------------------------------------------

def _xref_get(doc, x, key):
    try:
        v = doc.xref_get_key(x, key)
        return v[1] if v else None
    except Exception:
        return None


def _open_pdf(path):
    import fitz
    doc = fitz.open(path)
    if doc.needs_pass:
        if not doc.authenticate(""):
            raise RuntimeError("PDF 已加密（非空密码），请先解密后再压缩")
    return doc


def _is_image_xref(doc, x):
    try:
        return _xref_get(doc, x, "Subtype") == "/Image"
    except Exception:
        return False


def smart_compress(src, out, scale, qc, qa):
    """xref 级图片重压缩（会话验证过的核心算法的泛化版）。"""
    import fitz
    Image, RESAMPLE = _pil()
    doc = _open_pdf(src)
    n = doc.xref_length()
    imgs = [x for x in range(1, n) if _is_image_xref(doc, x)]

    smask_of = {}
    for x in imgs:
        v = _xref_get(doc, x, "SMask")
        if v and v not in ("null",):
            try:
                smask_of[x] = int(v.split()[0])
            except Exception:
                pass
    smask_set = set(smask_of.values())

    stats = {"rgb": 0, "gray": 0, "alpha": 0, "skipped": 0}
    saved = {"rgb": 0, "gray": 0, "alpha": 0}
    done_smask = {}

    def classify_colorspace(x):
        cs = (_xref_get(doc, x, "ColorSpace") or "").strip()
        # 间接引用：解析指向的对象（/DeviceRGB 或 /ICCBased N 0 R）
        m = re.match(r"^(\d+)\s+0\s+R$", cs)
        if m:
            try:
                obj = doc.xref_object(int(m.group(1)))
                if "/DeviceRGB" in obj:
                    return "rgb"
                if "/DeviceGray" in obj:
                    return "gray"
                m2 = re.search(r"/ICCBased\s+(\d+)\s+0\s+R", obj)
                if m2:
                    ncomp = int(_xref_get(doc, int(m2.group(1)), "N") or 0)
                    if ncomp == 3:
                        return "rgb"
                    if ncomp == 1:
                        return "gray"
            except Exception:
                pass
            return None
        if cs == "/DeviceRGB":
            return "rgb"
        if cs == "/DeviceGray":
            return "gray"
        if "ICCBased" in cs:
            try:
                icc = int(cs.split()[1])
                ncomp = int(_xref_get(doc, icc, "N") or 0)
                if ncomp == 3:
                    return "rgb"
                if ncomp == 1:
                    return "gray"
            except Exception:
                pass
        return None

    for x in imgs:
        try:
            if not doc.xref_is_stream(x):
                continue
            if (_xref_get(doc, x, "ImageMask") or "").lower() == "true":
                continue
            if _xref_get(doc, x, "Mask") not in (None, "null"):
                stats["skipped"] += 1
                continue
            kind = classify_colorspace(x)
            if kind is None and x not in smask_set:
                stats["skipped"] += 1
                continue
            raw_len = len(doc.xref_stream_raw(x))
            d = doc.extract_image(x)
            im = Image.open(io.BytesIO(d["image"]))
            im.load()
        except Exception:
            stats["skipped"] += 1
            continue

        try:
            if kind in ("rgb", "gray"):
                want_mode = "RGB" if kind == "rgb" else "L"
                if im.mode != want_mode:
                    im = im.convert(want_mode)
                w0, h0 = im.size
                nw, nh = max(1, round(w0 * scale)), max(1, round(h0 * scale))
                sx = smask_of.get(x)
                if sx is not None:
                    prev = done_smask.get(sx)
                    if prev is not None and prev != (nw, nh):
                        stats["skipped"] += 1
                        continue  # 该 smask 被不同尺寸的图共享，跳过以避免损坏
                if (nw, nh) != (w0, h0):
                    im = im.resize((nw, nh), RESAMPLE)
                data = jpeg_bytes(im, qc, 0 if qc >= 90 else 1)
                doc.update_stream(x, data, compress=0)
                for k, v in (("Filter", "/DCTDecode"),
                             ("DecodeParms", "null"),
                             ("Decode", "null"),
                             ("Width", str(nw)), ("Height", str(nh)),
                             ("ColorSpace", "/DeviceRGB" if kind == "rgb" else "/DeviceGray"),
                             ("BitsPerComponent", "8")):
                    doc.xref_set_key(x, k, v)
                stats[kind] += 1
                saved[kind] += raw_len - len(data)

                if sx is not None:
                    try:
                        sd = doc.extract_image(sx)
                        aim = Image.open(io.BytesIO(sd["image"]))
                        aim.load()
                        if aim.mode != "L":
                            aim = aim.convert("L")
                        if aim.size != (nw, nh):
                            aim = aim.resize((nw, nh), RESAMPLE)
                        adata = jpeg_bytes(aim, qa, 1)
                        doc.update_stream(sx, adata, compress=0)
                        for k, v in (("Filter", "/DCTDecode"),
                                     ("DecodeParms", "null"),
                                     ("Decode", "null"),
                                     ("Width", str(nw)), ("Height", str(nh)),
                                     ("ColorSpace", "/DeviceGray"),
                                     ("BitsPerComponent", "8")):
                            doc.xref_set_key(sx, k, v)
                        stats["alpha"] += 1
                        saved["alpha"] += 0
                        done_smask[sx] = (nw, nh)
                    except Exception:
                        pass
            elif x in smask_set and kind is None:
                # 独立 smask（其宿主图被跳过时）：不动，尺寸必须与宿主一致
                stats["skipped"] += 1
        except Exception:
            stats["skipped"] += 1

    doc.save(out, garbage=4, deflate=True, clean=True)
    doc.close()
    return {"stats": stats, "src_image_mb": round(sum(saved.values()) / 1e6, 2)}


def gs_compress(src, out, dpi):
    gs = shutil.which("gs")
    if not gs:
        raise RuntimeError("未找到 Ghostscript (gs)")
    cmd = [gs, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.7",
           "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER",
           "-dDownsampleColorImages=true", "-dColorImageDownsampleType=/Bicubic",
           "-dColorImageResolution=%d" % dpi,
           "-dDownsampleGrayImages=true", "-dGrayImageDownsampleType=/Bicubic",
           "-dGrayImageResolution=%d" % dpi,
           "-dDownsampleMonoImages=true", "-dMonoImageResolution=300",
           "-dAutoFilterColorImages=false", "-dColorImageFilter=/DCTEncode",
           "-dAutoFilterGrayImages=false", "-dGrayImageFilter=/DCTEncode",
           "-dEmbedAllFonts=true", "-dSubsetFonts=true",
           "-sOutputFile=%s" % out, src]
    p = subprocess.run(cmd, capture_output=True, timeout=WORKER_TIMEOUT - 60)
    if p.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        raise RuntimeError("gs 失败: %s" % p.stderr.decode("utf-8", "ignore")[-300:])
    return {"dpi": dpi}


def raster_compress(src, out, dpi, q):
    import fitz
    Image, _ = _pil()
    sdoc = _open_pdf(src)
    odoc = fitz.open()
    for page in sdoc:
        pix = page.get_pixmap(dpi=dpi)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=q, optimize=True)
        np_ = odoc.new_page(width=page.rect.width, height=page.rect.height)
        np_.insert_image(page.rect, stream=buf.getvalue())
    odoc.set_metadata({})
    odoc.save(out, garbage=4, deflate=True)
    odoc.close()
    sdoc.close()
    return {"dpi": dpi, "jpeg_q": q}


def lossless_compress(src, out, deep):
    import fitz
    doc = _open_pdf(src)
    if deep:
        try:
            doc.del_xml_metadata()
        except Exception:
            pass
        try:
            doc.set_metadata({})
        except Exception:
            pass
    kw = dict(garbage=4, deflate=True, clean=True,
              deflate_images=True, deflate_fonts=True)
    try:
        doc.save(out, use_objstms=1, **kw)
    except TypeError:
        doc.save(out, **kw)
    doc.close()
    return {"variant": "深度（清元数据+对象流）" if deep else "保守（保留元数据）"}


# ---------------------------------------------------------------------------
# Worker 子进程入口： python3 pdf_optimizer.py --worker spec.json
# ---------------------------------------------------------------------------

def run_worker(spec_path):
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    result = {"ok": False, "error": ""}
    t0 = time.time()
    try:
        src, out, mode = spec["src"], spec["out"], spec["mode"]
        p = spec.get("params", {})
        if mode == "smart":
            extra = smart_compress(src, out, p["scale"], p["qc"], p["qa"])
        elif mode == "gs":
            extra = gs_compress(src, out, p["dpi"])
        elif mode == "raster":
            extra = raster_compress(src, out, p["dpi"], p["q"])
        elif mode == "lossless":
            extra = lossless_compress(src, out, p.get("deep", False))
        else:
            raise RuntimeError("未知模式 %s" % mode)
        result.update(ok=True, size=os.path.getsize(out), stats=extra,
                      ssim=None, ssim_min=None)
        if spec.get("eval") and os.path.exists(out):
            import fitz
            import numpy as np
            vals = []
            for i, ref in enumerate(spec["refs"]):
                refa = np.load(ref)
                doc = fitz.open(out)
                pm = doc[spec["ref_pages"][i]].get_pixmap(
                    dpi=EVAL_DPI, colorspace=fitz.csGRAY)
                cur = np.frombuffer(pm.samples, dtype=np.uint8).reshape(
                    pm.height, pm.width)
                doc.close()
                if cur.shape != refa.shape:
                    vals.append(0.0)
                    continue
                vals.append(ssim_score(refa, cur))
            result["ssim"] = round(float(np.mean(vals)), 4)
            result["ssim_min"] = round(float(np.min(vals)), 4)
    except Exception as e:
        result["error"] = "%s: %s" % (type(e).__name__, e)
    result["elapsed"] = round(time.time() - t0, 1)
    with open(spec["result"], "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    sys.exit(0 if result["ok"] else 3)


# ---------------------------------------------------------------------------
# 引擎：任务编排（网页线程与 --cli 共用）
# ---------------------------------------------------------------------------

def build_tasks(modes):
    """返回 [(mode, params, label), ...]"""
    tasks = []
    if "lossless" in modes:
        tasks.append(("lossless", {"deep": False}, "保守无损（保留元数据）"))
        tasks.append(("lossless", {"deep": True}, "深度无损（清元数据+对象流）"))
    if "smart" in modes:
        for s, qc, qa in SMART_LADDER:
            tasks.append(("smart", {"scale": s, "qc": qc, "qa": qa},
                          "缩放 %.0f%% · 彩色Q%d · 透明Q%d" % (s * 100, qc, qa)))
    if "gs" in modes:
        if shutil.which("gs"):
            for dpi in GS_LADDER:
                tasks.append(("gs", {"dpi": dpi}, "%d DPI 降采样" % dpi))
    if "raster" in modes:
        for dpi, q in RASTER_LADDER:
            tasks.append(("raster", {"dpi": dpi, "q": q},
                          "%d DPI · JPEG Q%d" % (dpi, q)))
    return tasks


def label_of(mode, params):
    if mode == "smart":
        return "缩放 %.0f%% · 彩色Q%d · 透明Q%d" % (
            params["scale"] * 100, params["qc"], params["qa"])
    if mode == "gs":
        return "%d DPI 降采样" % params["dpi"]
    if mode == "raster":
        return "%d DPI · JPEG Q%d" % (params["dpi"], params["q"])
    return "深度无损" if params.get("deep") else "保守无损"


class Engine:
    """一次寻优任务的完整编排。log(event, data) 用于进度回调。"""

    def __init__(self, src, cfg, log):
        require_core_deps()
        self.src = src
        self.cfg = cfg
        self.log = log
        os.makedirs(JOBS_ROOT, exist_ok=True)
        self.tmp = tempfile.mkdtemp(prefix="job_", dir=JOBS_ROOT)
        self.rows = {}            # row_id -> row dict
        self.order = []
        self.cancelled = False
        self.results = {}         # row_id -> result dict

    # ---- 子进程池 ----
    def _spawn(self, task_id, mode, params):
        spec = {"src": self.src,
                "out": os.path.join(self.tmp, "%s.pdf" % task_id),
                "mode": mode, "params": params,
                "eval": bool(self.cfg.get("eval")) and self.refs is not None,
                "refs": self.refs or [],
                "ref_pages": self.ref_pages or [],
                "result": os.path.join(self.tmp, "%s.json" % task_id)}
        sp = os.path.join(self.tmp, "%s.spec.json" % task_id)
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False)
        return subprocess.Popen(
            [sys.executable, SCRIPT_PATH, "--worker", sp],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _pool(self, jobs):
        """jobs: [(task_id, mode, params, label)] 并发执行直到全部结束/取消。"""
        workers = max(1, int(self.cfg.get("workers") or 4))
        running = {}
        queue = deque(jobs)
        while (queue or running) and not self.cancelled:
            while queue and len(running) < workers:
                tid, mode, params, label = queue.popleft()
                row = self.rows[tid]
                row["status"] = "running"
                row["_t0"] = time.time()
                try:
                    running[self._spawn(tid, mode, params)] = tid
                except Exception as e:
                    self.results[tid] = {"ok": False, "error": str(e)}
                    row["status"] = "failed"
                    row["error"] = str(e)
                    self.log("row", row)
            time.sleep(0.25)
            for p in list(running):
                tid = running[p]
                row = self.rows[tid]
                if p.poll() is None:
                    if time.time() - row.get("_t0", time.time()) > WORKER_TIMEOUT:
                        p.kill()
                        self.results[tid] = {"ok": False, "error": "超时"}
                        row["status"] = "timeout"
                        self.log("row", row)
                        del running[p]
                    continue
                del running[p]
                try:
                    with open(self.rows[tid]["_result_path"], "r",
                              encoding="utf-8") as f:
                        res = json.load(f)
                except Exception as e:
                    res = {"ok": False, "error": "worker 无输出: %s" % e}
                res.setdefault("elapsed", round(time.time() - row["_t0"], 1))
                self.results[tid] = res
                self._fill_row(tid, res)
                self.log("row", self.rows[tid])
        if self.cancelled:
            for p in running:
                p.kill()
                self.rows[running[p]]["status"] = "cancelled"
                self.log("row", self.rows[running[p]])

    def _fill_row(self, tid, res):
        row = self.rows[tid]
        if res.get("ok"):
            size = res["size"]
            row.update(size=size,
                       ratio=round(size / self.orig_size * 100, 1) if self.orig_size else None,
                       under=(size <= self.target_bytes),
                       ssim=res.get("ssim"), ssim_min=res.get("ssim_min"),
                       elapsed=res.get("elapsed"), status="done",
                       file=os.path.join(self.tmp, "%s.pdf" % tid))
        else:
            row["status"] = "failed"
            row["error"] = res.get("error", "未知错误")[:200]
            row["elapsed"] = res.get("elapsed")

    # ---- 主流程 ----
    def run(self):
        cfg = self.cfg
        self.target_bytes = int(cfg["target"] * (1048576 if cfg.get("unit") == "MiB" else 1e6))
        self.refs = None
        self.ref_pages = []

        import fitz
        doc = fitz.open(self.src)
        if doc.needs_pass and not doc.authenticate(""):
            raise RuntimeError("PDF 已加密（非空密码），请先解密")
        self.page_count = doc.page_count
        self.orig_size = os.path.getsize(self.src)
        doc.close()

        self.log("stage", "准备参考页")
        if cfg.get("eval"):
            self._render_refs()

        self.log("stage", "并发粗搜")
        tasks = build_tasks(cfg["modes"])
        jobs = []
        for mode, params, label in tasks:
            tid = uuid.uuid4().hex[:10]
            self.rows[tid] = {"id": tid, "mode": mode,
                              "mode_name": MODE_NAMES[mode], "label": label,
                              "params": params, "status": "queued",
                              "_t0": time.time(),
                              "_result_path": os.path.join(self.tmp, "%s.json" % tid)}
            self.order.append(tid)
            self.log("row", self.rows[tid])
            jobs.append((tid, mode, params, label))
        self.log("total", len(self.order))
        self._pool(jobs)
        if self.cancelled:
            return self._summary("已取消")

        # 精搜：智能/GS/栅格化围绕粗搜的最优边界插值或上下外推
        for _ in range(REFINE_ROUNDS):
            extra = self._refine_jobs()
            if not extra or self.cancelled:
                break
            self.log("stage", "精搜 +%d" % len(extra))
            jobs = []
            for mode, params, label in extra:
                tid = uuid.uuid4().hex[:10]
                self.rows[tid] = {"id": tid, "mode": mode,
                                  "mode_name": MODE_NAMES[mode],
                                  "label": label, "params": params,
                                  "status": "queued",
                                  "_t0": time.time(),
                                  "_result_path": os.path.join(
                                      self.tmp, "%s.json" % tid)}
                self.order.append(tid)
                self.log("row", self.rows[tid])
                jobs.append((tid, mode, params, label))
            self.log("total", len(self.order))
            self._pool(jobs)
            if self.cancelled:
                return self._summary("已取消")

        self.log("stage", "生成结论与预览")
        return self._summary(None)

    def _render_refs(self):
        import fitz
        import numpy as np
        n = self.page_count
        k = max(1, int(self.cfg.get("sample") or 5))
        idx = sorted(set(min(n - 1, round(i * (n - 1) / max(1, k - 1)))
                         for i in range(k))) if k > 1 else [0]
        self.ref_pages = idx
        self.refs = []
        refdir = os.path.join(self.tmp, "ref")
        os.makedirs(refdir, exist_ok=True)
        doc = fitz.open(self.src)
        for i in idx:
            pm = doc[i].get_pixmap(dpi=EVAL_DPI, colorspace=fitz.csGRAY)
            arr = np.frombuffer(pm.samples, dtype=np.uint8).reshape(
                pm.height, pm.width).copy()
            p = os.path.join(refdir, "p%d.npy" % i)
            np.save(p, arr)
            self.refs.append(p)
        doc.close()

    # ---- 精搜 ----
    def _mode_cands(self, mode):
        out = []
        for tid in self.order:
            r = self.results.get(tid)
            row = self.rows[tid]
            if r and r.get("ok") and row["mode"] == mode:
                out.append((row["params"], r["size"]))
        return out

    def _refine_jobs(self):
        new = []

        def push(mode, params):
            new.append((mode, params, label_of(mode, params)))

        # smart：(缩放, 彩色Q, 透明Q) 线性插值
        cands = self._mode_cands("smart")
        if cands:
            key = lambda cp: (cp[0]["scale"], cp[0]["qc"])  # noqa: E731
            done = {(c["scale"], c["qc"], c["qa"]) for c, _ in cands}
            unders = sorted([c for c in cands if c[1] <= self.target_bytes],
                            key=key, reverse=True)
            overs = sorted([c for c in cands if c[1] > self.target_bytes],
                           key=key)
            if unders and overs:
                u, o = unders[0][0], overs[0][0]
                for i in range(1, REFINE_N + 1):
                    t = i / (REFINE_N + 1)
                    s = round(u["scale"] + (o["scale"] - u["scale"]) * t, 3)
                    qc = round(u["qc"] + (o["qc"] - u["qc"]) * t)
                    qa = round(u["qa"] + (o["qa"] - u["qa"]) * t)
                    if (s, qc, qa) not in done:
                        done.add((s, qc, qa))
                        push("smart", {"scale": s, "qc": qc, "qa": qa})
            elif not unders:
                s0 = min(c["scale"] for c, _ in cands)
                for s, qc, qa in SMART_BOTTOM_EXTRA:
                    if s < s0 and (s, qc, qa) not in done:
                        done.add((s, qc, qa))
                        push("smart", {"scale": s, "qc": qc, "qa": qa})
            else:
                for s, qc, qa in SMART_UP_EXTRA:
                    if (s, qc, qa) not in done:
                        done.add((s, qc, qa))
                        push("smart", {"scale": s, "qc": qc, "qa": qa})

        # gs：DPI 插值；全达标/全超标时向上/向下外推
        cands = self._mode_cands("gs")
        if cands:
            key = lambda cp: cp[0]["dpi"]  # noqa: E731
            done = {c["dpi"] for c, _ in cands}

            def add_gs(dpi):
                dpi = int(round(dpi))
                if 40 <= dpi <= 400 and dpi not in done:
                    done.add(dpi)
                    push("gs", {"dpi": dpi})
            unders = sorted([c for c in cands if c[1] <= self.target_bytes],
                            key=key, reverse=True)
            overs = sorted([c for c in cands if c[1] > self.target_bytes],
                           key=key)
            if unders and overs:
                u, o = unders[0][0]["dpi"], overs[0][0]["dpi"]
                for i in range(1, REFINE_N + 1):
                    add_gs(u + (o - u) * i / (REFINE_N + 1))
            elif not unders:
                d0 = min(c["dpi"] for c, _ in cands)
                add_gs(d0 - 12)
                add_gs(d0 - 24)
            else:
                d9 = max(c["dpi"] for c, _ in cands)
                add_gs(d9 + 12)
                add_gs(d9 + 24)

        # raster：(DPI, JPEG Q) 插值；全达标/全超标时向上/向下外推
        cands = self._mode_cands("raster")
        if cands:
            key = lambda cp: (cp[0]["dpi"], cp[0]["q"])  # noqa: E731
            done = {(c["dpi"], c["q"]) for c, _ in cands}

            def add_ra(dpi, q):
                dpi = int(round(dpi))
                if 40 <= dpi <= 300 and (dpi, q) not in done:
                    done.add((dpi, q))
                    push("raster", {"dpi": dpi, "q": int(q)})
            unders = sorted([c for c in cands if c[1] <= self.target_bytes],
                            key=key, reverse=True)
            overs = sorted([c for c in cands if c[1] > self.target_bytes],
                           key=key)
            if unders and overs:
                u, o = unders[0][0], overs[0][0]
                for i in range(1, REFINE_N + 1):
                    t = i / (REFINE_N + 1)
                    add_ra(u["dpi"] + (o["dpi"] - u["dpi"]) * t,
                           u["q"] + (o["q"] - u["q"]) * t)
            elif not unders:
                d0 = min(c["dpi"] for c, _ in cands)
                q0 = min(c["q"] for c, _ in cands)
                add_ra(d0 - 16, max(40, q0 - 8))
                add_ra(d0 - 32, max(40, q0 - 14))
            else:
                d9 = max(c["dpi"] for c, _ in cands)
                q9 = max(c["q"] for c, _ in cands)
                add_ra(d9 + 30, q9)
                add_ra(d9 + 60, q9)
        return new

    # ---- 结论 ----
    def eligible_rows(self):
        margin = float(self.cfg.get("margin") or 0) / 100.0
        ok = [t for t in self.order
              if self.rows[t].get("status") == "done"]
        under = [t for t in ok if self.rows[t]["size"] <= self.target_bytes]
        pref = [t for t in under
                if self.rows[t]["size"] <= self.target_bytes * (1 - margin)]
        return ok, (pref or under)

    def _pick(self, tids):
        if not tids:
            return None
        use_ssim = bool(self.cfg.get("eval"))
        def key(t):
            r = self.rows[t]
            return ((-r["ssim"] if r.get("ssim") is not None else 0),
                    -r["size"]) if use_ssim else (-r["size"],)
        return sorted(tids, key=key)[0]

    def _summary(self, msg):
        ok, elig = self.eligible_rows()
        best = self._pick(elig)
        min_row = None
        if ok:
            min_row = min(ok, key=lambda t: self.rows[t]["size"])
        mode_best = {}
        use_ssim = bool(self.cfg.get("eval"))
        for t in ok:
            m = self.rows[t]["mode"]
            cur = mode_best.get(m)
            if cur is None:
                mode_best[m] = t
                continue
            a, b = self.rows[t], self.rows[cur]
            if bool(a.get("under")) != bool(b.get("under")):
                if a.get("under"):
                    mode_best[m] = t
            elif use_ssim and a.get("ssim") is not None \
                    and b.get("ssim") is not None:
                if a["ssim"] > b["ssim"]:
                    mode_best[m] = t
            elif a.get("under"):
                if a["size"] > b["size"]:
                    mode_best[m] = t
            else:
                if a["size"] < b["size"]:
                    mode_best[m] = t
        previews = {}
        if self.cfg.get("previews", True):
            for t in sorted(set(([best] if best else []) + list(mode_best.values()))):
                try:
                    previews[t] = self._preview(t)
                except Exception:
                    pass
        return {"msg": msg, "orig_size": self.orig_size,
                "pages": self.page_count,
                "target_bytes": self.target_bytes,
                "best": best, "min_row": min_row,
                "mode_best": mode_best, "previews": previews,
                "tmp": self.tmp}

    def _preview(self, tid):
        """原 PDF 与候选 PDF 两页并排对比图（dataURI）。"""
        import fitz
        from PIL import Image
        cand = os.path.join(self.tmp, "%s.pdf" % tid)
        pages = self.ref_pages or [0]
        use = pages[:2] if len(pages) >= 2 else [pages[0]]
        tiles = []
        for srcp in (self.src, cand):
            doc = fitz.open(srcp)
            ims = []
            for i in use:
                pm = doc[i].get_pixmap(dpi=PREVIEW_DPI)
                ims.append(Image.frombytes("RGB", (pm.width, pm.height),
                                           pm.samples))
            doc.close()
            w = sum(i.width for i in ims) + 6 * (len(ims) - 1)
            h = max(i.height for i in ims)
            strip = Image.new("RGB", (w, h), (255, 255, 255))
            x = 0
            for im in ims:
                strip.paste(im, (x, 0))
                x += im.width + 6
            tiles.append(strip)
        w = sum(t.width for t in tiles) + 14
        h = max(t.height for t in tiles) + 26
        canvas = Image.new("RGB", (w, h), (226, 232, 240))
        x = 0
        for t in tiles:
            canvas.paste(t, (x, 22))
            x += t.width + 14
        buf = io.BytesIO()
        canvas.save(buf, "JPEG", quality=72)
        return "data:image/jpeg;base64," + base64.b64encode(
            buf.getvalue()).decode()


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

HTML = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF 体积寻优工具</title>
<script>try{if((localStorage.getItem('pdfopt-theme')||'light')==='dark')document.documentElement.classList.add('dark')}catch(e){}</script>
<style>
:root{
  --background:#ffffff;--foreground:#09090b;--card:#ffffff;
  --muted:#f4f4f5;--muted-fg:#71717a;--border:#e4e4e7;--input:#e4e4e7;
  --primary:#18181b;--primary-fg:#fafafa;--secondary:#f4f4f5;--secondary-fg:#18181b;
  --accent:#f4f4f5;--accent-fg:#18181b;--destructive:#dc2626;--destructive-fg:#fafafa;
  --ring:#a1a1aa;--radius:10px;
  --ok:#15803d;--ok-bg:#f0fdf4;--ok-border:#bbf7d0;
  --bad:#dc2626;--bad-bg:#fef2f2;--bad-border:#fecaca;
}
.dark{
  --background:#09090b;--foreground:#fafafa;--card:#0c0c0e;
  --muted:#27272a;--muted-fg:#a1a1aa;--border:#27272a;--input:#27272a;
  --primary:#fafafa;--primary-fg:#18181b;--secondary:#27272a;--secondary-fg:#fafafa;
  --accent:#27272a;--accent-fg:#fafafa;--destructive:#ef4444;--destructive-fg:#fafafa;
  --ring:#52525b;
  --ok:#4ade80;--ok-bg:rgba(34,197,94,.12);--ok-border:rgba(74,222,128,.35);
  --bad:#f87171;--bad-bg:rgba(220,38,38,.12);--bad-border:rgba(248,113,113,.35);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--background);color:var(--foreground);
  font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,
  "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:32px 20px 90px}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;
  margin-bottom:22px;flex-wrap:wrap}
h1{font-size:20px;font-weight:700;margin:0;display:flex;align-items:center;gap:8px;
  letter-spacing:-.01em}
.sub{color:var(--muted-fg);margin:4px 0 0;font-size:13px}
.topbar-actions{display:flex;gap:8px;align-items:center}

.card{background:var(--card);border:1px solid var(--border);border-radius:14px;
  padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgb(0 0 0/.05)}
.card-head{display:flex;justify-content:space-between;align-items:center;gap:10px;
  flex-wrap:wrap;margin-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
label.f{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
input[type=text],input[type=number],select{width:100%;height:36px;background:var(--background);
  border:1px solid var(--input);color:var(--foreground);border-radius:8px;padding:0 12px;
  font-size:14px;outline:none;transition:border-color .15s, box-shadow .15s}
input:focus-visible,select:focus-visible{border-color:var(--ring);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 25%,transparent)}
.row{display:flex;gap:8px;align-items:center}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;
  padding:0 16px;border-radius:8px;border:1px solid transparent;font-size:13.5px;
  font-weight:500;cursor:pointer;text-decoration:none;color:inherit;
  transition:background .15s,opacity .15s,border-color .15s;user-select:none;
  font-family:inherit;line-height:1;white-space:nowrap}
.btn:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 35%,transparent);
  outline:none}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:var(--primary);color:var(--primary-fg)}
.btn-primary:hover:not(:disabled){opacity:.88}
.btn-outline{background:var(--background);border-color:var(--input)}
.btn-outline:hover:not(:disabled){background:var(--accent)}
.btn-ghost{background:transparent}
.btn-ghost:hover:not(:disabled){background:var(--accent)}
.btn-destructive{background:var(--destructive);color:var(--destructive-fg)}
.btn-destructive:hover:not(:disabled){opacity:.88}
.danger-text{color:var(--destructive)}
.btn-sm{height:31px;padding:0 12px;font-size:12.5px}
.btn-xs{height:25px;padding:0 9px;font-size:12px}
.icon{width:36px;padding:0;font-size:15px}

.badge{display:inline-flex;align-items:center;height:21px;padding:0 9px;
  border-radius:9999px;font-size:11.5px;font-weight:600;border:1px solid transparent;
  white-space:nowrap}
.badge-ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-border)}
.badge-no{color:var(--bad);background:var(--bad-bg);border-color:var(--bad-border)}
.badge-muted{color:var(--muted-fg);background:var(--muted);border-color:var(--border)}
.badge-outline{color:var(--muted-fg);border-color:var(--border)}

.drop{border:1.5px dashed var(--border);border-radius:12px;padding:34px;text-align:center;
  cursor:pointer;transition:.15s;color:var(--muted-fg)}
.drop:hover,.drop.over{border-color:var(--ring);background:var(--accent)}
.drop b{color:var(--foreground);font-size:14.5px;font-weight:600}
.fileinfo{margin-top:10px;font-size:13px;color:var(--muted-fg);word-break:break-all}

.bar{height:8px;background:var(--muted);border-radius:9999px;overflow:hidden;margin:12px 0 8px}
.bar i{display:block;height:100%;width:0;background:var(--primary);transition:width .4s}
.stat{font-size:12.5px;color:var(--muted-fg)}
.muted-sm{color:var(--muted-fg);font-size:12.5px}

table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;
  font-variant-numeric:tabular-nums}
th{color:var(--muted-fg);text-align:left;font-weight:500;padding:8px 8px;
  border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:8px;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:middle}
tbody tr:hover{background:var(--accent)}
tr.best td{background:color-mix(in srgb,var(--primary) 5%,transparent)}

.alert{padding:10px 14px;border-radius:10px;background:var(--bad-bg);
  border:1px solid var(--bad-border);color:var(--bad);font-size:13px;
  margin-top:12px;display:none}
.empty{padding:34px;text-align:center;color:var(--muted-fg);font-size:13px;
  border:1px dashed var(--border);border-radius:12px;margin-top:10px}

.modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:10px;
  margin-top:8px}
.mode{border:1px solid var(--border);border-radius:10px;padding:12px 14px;cursor:pointer;
  background:var(--background);transition:.15s}
.mode:hover{background:var(--accent)}
.mode.on{border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}
.mode b{display:block;font-size:13.5px;font-weight:600}
.mode span{font-size:12px;color:var(--muted-fg);line-height:1.5}

h4.sec{margin:24px 0 10px;font-size:14.5px;font-weight:600}
.hero{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
.hero .info{flex:1;min-width:250px}
.hero h2{margin:0 0 8px;font-size:17px;font-weight:650}
.hero img,.mcard img{max-width:100%;border-radius:8px;border:1px solid var(--border)}
.kv{font-size:13px;color:var(--muted-fg);margin:3px 0}
.kv b{color:var(--foreground);font-weight:600;font-variant-numeric:tabular-nums}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px;
  margin-top:4px}
.mcard{border:1px solid var(--border);border-radius:12px;padding:14px;
  background:var(--card);box-shadow:0 1px 2px rgb(0 0 0/.05)}
.mcard h3{margin:0;font-size:14px;font-weight:650;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap}
.note{font-size:12px;color:var(--muted-fg);margin-top:8px;line-height:1.55}

.hist-item{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:12px 4px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.hist-item:last-child{border-bottom:0}
.hist-meta{display:flex;flex-direction:column;gap:2px;min-width:0}
.hist-meta b{font-size:13.5px;font-weight:600;word-break:break-all}
.hist-actions{display:flex;gap:8px;align-items:center}

#modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
  background:rgb(0 0 0/.55);z-index:60;padding:22px}
.modal-panel{background:var(--background);border:1px solid var(--border);
  border-radius:14px;width:min(1080px,96vw);height:min(88vh,920px);display:flex;
  flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgb(0 0 0/.35)}
.modal-head{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.modal-head b{font-size:13.5px;word-break:break-all}
.modal-actions{display:flex;gap:8px}
#pvFrame{flex:1;width:100%;border:0;background:var(--muted)}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  background:var(--primary);color:var(--primary-fg);padding:9px 18px;border-radius:9px;
  display:none;font-size:13px;box-shadow:0 10px 30px rgb(0 0 0/.25);z-index:70}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div>
      <h1>PDF 体积寻优工具 <span class="badge badge-outline">shadcn</span></h1>
      <p class="sub">输入任意 PDF 与目标体积 → 多进程并发搜索多套方案 → 体积约束下质量最优解 · 全部方案支持在线预览</p>
    </div>
    <div class="topbar-actions">
      <button id="btnTheme" class="btn btn-ghost icon" title="切换明暗主题">🌙</button>
      <button id="btnShutdown" class="btn btn-outline btn-sm">关闭服务</button>
    </div>
  </div>

  <div class="card">
    <div class="card-head" style="margin-bottom:14px">
      <div class="badge badge-outline" id="deps">依赖检测中…</div>
      <div class="badge badge-outline">CPU <b id="cpu">-</b> 核</div>
    </div>
    <div class="drop" id="drop">
      <b>点击选择或拖入 PDF 文件</b><br>原文件不会被修改，结果另存
      <input type="file" id="file" accept="application/pdf" hidden>
    </div>
    <div class="fileinfo" id="fileinfo"></div>

    <div class="grid" style="margin-top:16px">
      <div><label class="f">目标体积</label>
        <div class="row">
          <input type="number" id="target" value="20" min="0.1" step="0.5" style="flex:1">
          <select id="unit" style="width:82px"><option value="MB">MB</option><option value="MiB">MiB</option></select>
        </div></div>
      <div><label class="f">安全边际 %</label>
        <input type="number" id="margin" value="1" min="0" max="30" step="0.5"></div>
      <div><label class="f">并发进程数（0=自动）</label>
        <input type="number" id="workers" value="0" min="0"></div>
      <div><label class="f">质量采样页数</label>
        <input type="number" id="sample" value="5" min="1" max="12"></div>
      <div><label class="f">质量评估（SSIM）</label>
        <select id="eval"><option value="1" selected>开启（推荐）</option><option value="0">关闭（更快）</option></select></div>
    </div>

    <label class="f" style="margin-top:16px">压缩模式（可多选，将并发搜索全部方案）</label>
    <div class="modes" id="modes">
      <div class="mode on" data-m="smart"><b>智能图片重压</b><span>xref 级图片重编码：降采样 + JPEG 重压，文字/矢量原样保留，透明通道同步缩放。通常最优。</span></div>
      <div class="mode on" data-m="lossless"><b>无损优化</b><span>仅结构清理与流压缩，画质零损失；若原文件已高度优化则减容有限。</span></div>
      <div class="mode on" data-m="gs"><b>Ghostscript 降采样</b><span>gs 全文档重打包，稳健、文字可选中；需本机安装 gs。</span></div>
      <div class="mode on" data-m="raster"><b>整页栅格化</b><span>每页转位图重建，任何文件都能压小；文字不可选中，兜底用。</span></div>
    </div>

    <div class="row" style="margin-top:18px">
      <button id="btnGo" class="btn btn-primary" disabled>开始寻优</button>
      <button id="btnCancel" class="btn btn-destructive" disabled style="display:none">取消任务</button>
      <span class="stat" id="hint">请先选择 PDF</span>
    </div>
    <div class="alert" id="errmsg"></div>
  </div>

  <div class="card" id="progCard" style="display:none">
    <div class="card-head">
      <b id="stage" style="font-size:14px">准备中…</b>
      <span class="stat" id="progStat"></span>
    </div>
    <div class="bar"><i id="bar"></i></div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>模式</th><th>参数</th><th>体积</th><th>占原文件</th><th>达标</th><th>质量 SSIM</th><th>用时</th><th>状态</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
  </div>

  <div id="result"></div>

  <div class="card">
    <div class="card-head">
      <div style="display:flex;gap:8px;align-items:center">
        <b style="font-size:14px">历史记录</b>
        <span class="badge badge-outline" id="histCount"></span>
      </div>
      <div style="display:flex;gap:8px">
        <button id="histRefresh" class="btn btn-ghost btn-sm">刷新</button>
        <button id="histClear" class="btn btn-ghost btn-sm danger-text">清空</button>
      </div>
    </div>
    <div class="muted-sm" id="histTotal"></div>
    <div id="histList"></div>
  </div>
</div>

<div id="modal">
  <div class="modal-panel">
    <div class="modal-head">
      <b id="pvTitle">PDF 在线预览</b>
      <div class="modal-actions">
        <a id="pvNew" class="btn btn-outline btn-sm" target="_blank" rel="noopener">新窗口打开</a>
        <a id="pvDl" class="btn btn-outline btn-sm">下载</a>
        <button class="btn btn-primary btn-sm" onclick="closeModal()">关闭</button>
      </div>
    </div>
    <iframe id="pvFrame" title="PDF 在线预览" src="about:blank"></iframe>
  </div>
</div>
<div id="toast"></div>

<script>
const $=s=>document.querySelector(s);
let jobId=null,pollTimer=null,chosenFile=null,rowsMap={},total=0,doneCnt=0,ctx='job';
const fmtMB=b=>(b/1e6).toFixed(2)+' MB';
const esc=s=>(s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.style.display='block';
  clearTimeout(e._t);e._t=setTimeout(()=>e.style.display='none',3200);}
function showErr(t){const e=$('#errmsg');if(t){e.textContent=t;e.style.display='block';}
  else e.style.display='none';}

/* 主题 */
const themeBtn=$('#btnTheme');
function applyTheme(t){document.documentElement.classList.toggle('dark',t==='dark');
  themeBtn.textContent=t==='dark'?'☀️':'🌙';
  try{localStorage.setItem('pdfopt-theme',t);}catch(e){}}
themeBtn.onclick=()=>applyTheme(document.documentElement.classList.contains('dark')?'light':'dark');
applyTheme(document.documentElement.classList.contains('dark')?'dark':'light');

fetch('/api/info').then(r=>r.json()).then(d=>{
  const ok=k=>d[k]?'✓':'✗';
  $('#deps').textContent=`PyMuPDF ${ok('fitz')} · Pillow ${ok('PIL')} · numpy ${ok('numpy')} · skimage ${ok('skimage')} · Ghostscript ${d.gs?'✓':'✗'}`;
  $('#cpu').textContent=d.cpu;
  if(!d.fitz||!d.PIL||!d.numpy){showErr('缺少核心依赖，请先：pip install PyMuPDF Pillow numpy');}
});

/* 文件选择 */
const drop=$('#drop'),fileInput=$('#file');
drop.onclick=()=>fileInput.click();
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};
drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');
  if(e.dataTransfer.files[0])pickFile(e.dataTransfer.files[0]);};
fileInput.onchange=()=>{if(fileInput.files[0])pickFile(fileInput.files[0]);};
function pickFile(f){
  if(!/\.pdf$/i.test(f.name)&&f.type!=='application/pdf'){toast('请选择 PDF 文件');return;}
  chosenFile=f;$('#fileinfo').textContent=`已选择：${f.name}（${fmtMB(f.size)}）`;
  $('#btnGo').disabled=false;$('#hint').textContent='点击"开始寻优"';
}

/* 模式多选 */
document.querySelectorAll('.mode').forEach(el=>el.onclick=()=>el.classList.toggle('on'));

/* 开始 / 取消 / 关闭 */
$('#btnGo').onclick=async()=>{
  if(!chosenFile)return;showErr('');
  const modes=[...document.querySelectorAll('.mode.on')].map(e=>e.dataset.m);
  if(!modes.length){showErr('请至少选择一个压缩模式');return;}
  const q=new URLSearchParams({name:chosenFile.name,target:$('#target').value,
    unit:$('#unit').value,margin:$('#margin').value,workers:$('#workers').value||0,
    sample:$('#sample').value,eval:$('#eval').value,modes:modes.join(',')});
  $('#btnGo').disabled=true;$('#hint').textContent='上传中…';ctx='job';
  try{
    const r=await fetch('/api/optimize?'+q,{method:'POST',body:chosenFile});
    const d=await r.json();
    if(!d.ok){showErr(d.error||'提交失败');$('#btnGo').disabled=false;
      $('#hint').textContent='请重新开始';return;}
    jobId=d.job_id;rowsMap={};total=0;doneCnt=0;
    $('#rows').innerHTML='';$('#result').innerHTML='';
    $('#progCard').style.display='block';$('#stage').textContent='排队中…';
    $('#btnCancel').style.display='';$('#btnCancel').disabled=false;
    poll();
  }catch(e){showErr('上传失败：'+e);$('#btnGo').disabled=false;}
};
$('#btnCancel').onclick=async()=>{
  if(!jobId)return;
  await fetch('/api/cancel?id='+jobId,{method:'POST'});
  toast('已请求取消');
};
$('#btnShutdown').onclick=async()=>{
  if(!confirm('确定关闭本地服务？'))return;
  await fetch('/api/shutdown',{method:'POST'});
};

/* 进度渲染 */
function renderRows(rows){
  const tb=$('#rows');
  for(const r of rows){
    let e=rowsMap[r.id];
    if(!e){const tr=document.createElement('tr');tb.appendChild(tr);e=rowsMap[r.id]={el:tr};}
    let badge='<span class="badge badge-muted">'+({queued:'排队',running:'运行中'}[r.status]||r.status)+'</span>';
    if(r.status==='done')badge=r.under?'<span class="badge badge-ok">达标 ✓</span>':'<span class="badge badge-no">超标</span>';
    if(r.status==='failed')badge='<span class="badge badge-no">失败</span>';
    if(r.status==='timeout')badge='<span class="badge badge-no">超时</span>';
    const ssim=(r.ssim!=null)?`<b>${r.ssim.toFixed(4)}</b> <span class="muted-sm">min ${r.ssim_min}</span>`:'—';
    const size=r.size!=null?`<b>${fmtMB(r.size)}</b>`:'—';
    const ratio=r.ratio!=null?r.ratio+'%':'—';
    const pv=r.status==='done'?`<button class="btn btn-ghost btn-xs" data-pv="job|${r.id}|${esc(r.mode_name+' · '+r.label)}">预览</button>`:'';
    e.el.innerHTML=`<td>${r.mode_name}</td><td>${r.label}</td><td>${size}</td><td>${ratio}</td>
      <td>${badge}</td><td>${ssim}</td><td>${r.elapsed!=null?r.elapsed+'s':'—'}</td>
      <td>${r.error?'<span class="badge badge-no" title="'+esc(r.error)+'">!</span>':''}</td>
      <td>${pv}</td>`;
  }
}
function poll(){
  if(!jobId)return;
  fetch('/api/job?id='+jobId).then(r=>r.json()).then(d=>{
    if(d.error){showErr(d.error);stop();
      $('#btnGo').disabled=false;$('#hint').textContent='可重新开始';
      return;}
    total=d.total||total;
    const rows=d.rows||[];
    doneCnt=rows.filter(r=>['done','failed','timeout','cancelled'].includes(r.status)).length;
    $('#bar').style.width=(total?100*doneCnt/total:0)+'%';
    $('#progStat').textContent=`${doneCnt}/${total||'?'} 个候选 · 已用时 ${d.elapsed||0}s`;
    $('#stage').textContent=d.stage||'';
    renderRows(rows);
    if(d.state==='done'||d.state==='error'||d.state==='cancelled'){
      stop();
      if(d.state==='error')showErr(d.error||'任务失败');
      if(d.summary)renderSummary(d.summary,'job');
      loadHistory();
      $('#btnGo').disabled=false;$('#hint').textContent='可重新开始';
      $('#btnCancel').style.display='none';
    }else{pollTimer=setTimeout(poll,800);}
  }).catch(()=>{pollTimer=setTimeout(poll,1500);});
}
function stop(){clearTimeout(pollTimer);pollTimer=null;$('#btnCancel').style.display='none';}

/* 在线预览 */
function fileUrl(c,rowId,dl){
  if(c==='job')return '/api/download?id='+jobId+'&row='+rowId+(dl?'&dl=1':'');
  return '/api/history/file?id='+c.slice(5)+'&row='+rowId+(dl?'&dl=1':'');
}
function pvBtn(c,row,title){
  return `<button class="btn btn-primary btn-sm" data-pv="${c}|${row}|${esc(title)}">在线预览</button>`;
}
function openPreview(c,row,title){
  $('#pvTitle').textContent=title||'PDF 在线预览';
  $('#pvFrame').src=fileUrl(c,row,false);
  $('#pvNew').href=fileUrl(c,row,false);
  $('#pvDl').href=fileUrl(c,row,true);
  $('#modal').style.display='flex';
}
function closeModal(){$('#modal').style.display='none';$('#pvFrame').src='about:blank';}
$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-pv]');
  if(b){const parts=b.dataset.pv.split('|');
    openPreview(parts[0],parts[1],parts.slice(2).join('|'));}
});

/* 结果渲染 */
function badgeOk(u){return u?'<span class="badge badge-ok">达标</span>'
                           :'<span class="badge badge-no">超标</span>';}
function cardHtml(title,r,star){
  const pre=s.previews&&s.previews[r.id];
  return `<div class="mcard">
    <h3>${star?'⭐ ':''}${title} ${badgeOk(r.under)}</h3>
    <div class="kv">参数：<b>${r.label}</b></div>
    <div class="kv">体积：<b>${fmtMB(r.size)}</b>（原 ${fmtMB(s.orig_size)} 的 ${r.ratio}%）</div>
    ${r.ssim!=null?`<div class="kv">质量：SSIM <b>${r.ssim.toFixed(4)}</b>（最差页 ${r.ssim_min}）· 用时 ${r.elapsed}s</div>`:''}
    ${pre?`<img src="${pre}" alt="对比预览"><div class="note">缩略对比：左侧为原 PDF，右侧为压缩后（同样页面）</div>`:''}
    <div class="actions">${pvBtn(ctx,r.id,r.mode_name+' · '+r.label)}
      <a class="btn btn-outline btn-sm" href="${fileUrl(ctx,r.id,true)}">下载</a></div>
  </div>`;
}
let s=null;
function renderSummary(sum,c){
  ctx=c||'job';s=sum;
  const el=$('#result');
  let h='<div class="card"><div class="card-head"><b style="font-size:14px">寻优结果</b>'+
    `<span class="badge badge-outline">原文件 ${fmtMB(s.orig_size)} · ${s.pages} 页 · 目标 ≤ ${fmtMB(s.target_bytes)}</span></div>`;
  if(s.best){
    const b=s.rows[s.best];
    h+=`<h4 class="sec" style="margin-top:8px">⭐ 推荐方案（体积约束下质量最优）</h4>
      <div class="hero">
        <div class="info">
          <h2>${b.mode_name} ${badgeOk(b.under)}</h2>
          <div class="kv">参数：<b>${b.label}</b></div>
          <div class="kv">体积：<b>${fmtMB(b.size)}</b>（原 ${fmtMB(s.orig_size)} 的 ${b.ratio}%）</div>
          ${b.ssim!=null?`<div class="kv">质量：SSIM <b>${b.ssim.toFixed(4)}</b>（最差页 ${b.ssim_min}）· 用时 ${b.elapsed}s</div>`:''}
          <div class="actions">${pvBtn(ctx,b.id,b.mode_name+' · '+b.label)}
            <a class="btn btn-outline btn-sm" href="${fileUrl(ctx,b.id,true)}">下载</a></div>
        </div>
        ${s.previews&&s.previews[b.id]?`<img style="flex:1;min-width:300px" src="${s.previews[b.id]}" alt="对比预览">`:''}
      </div>
      <div class="note">缩略对比：左侧为原 PDF，右侧为压缩后；点"在线预览"可翻阅整份压缩文档</div>`;
  }else{
    h+='<div class="empty" style="margin-top:12px">没有候选完成或达标，请检查文件或调整目标体积。</div>';
  }
  const others=Object.entries(s.mode_best||{}).filter(([m,t])=>t!==s.best);
  if(others.length){
    h+='<h4 class="sec">各模式最优解（供对比研判）</h4><div class="cards">';
    for(const[m,t]of others)h+=cardHtml(s.rows[t].mode_name,s.rows[t],false);
    h+='</div><div class="note">研判提示：优先看 SSIM（越高越接近原图）与体积余量；如需可选中文字请避免栅格化方案。</div>';
  }
  if(s.min_row&&s.min_row!==s.best){
    h+='<h4 class="sec">体积最小方案</h4><div class="cards">'+
      cardHtml(s.rows[s.min_row].mode_name,s.rows[s.min_row],false)+'</div>';
  }
  h+='<h4 class="sec">全部候选明细</h4><div style="overflow-x:auto"><table><thead><tr>'+
    '<th>模式</th><th>参数</th><th>体积</th><th>占原文件</th><th>达标</th><th>SSIM</th><th style="width:150px">操作</th></tr></thead><tbody>';
  for(const r of Object.values(s.rows||{})){
    if(!r.size)continue;
    h+=`<tr${r.id===s.best?' class="best"':''}><td>${r.mode_name}</td><td>${r.label}</td>
      <td><b>${fmtMB(r.size)}</b>${r.id===s.best?' ⭐':''}</td>
      <td>${r.ratio!=null?r.ratio+'%':'—'}</td>
      <td>${r.under?'<span class="badge badge-ok">✓</span>':'<span class="badge badge-no">✗</span>'}</td>
      <td>${r.ssim!=null?r.ssim.toFixed(4):'—'}</td>
      <td>${pvBtn(ctx,r.id,r.mode_name+' · '+r.label)}
        <a class="btn btn-ghost btn-xs" href="${fileUrl(ctx,r.id,true)}">下载</a></td></tr>`;
  }
  h+='</tbody></table></div></div>';
  el.innerHTML=h;
  el.scrollIntoView({behavior:'smooth'});
}

/* 历史记录 */
async function loadHistory(){
  try{
    const d=await fetch('/api/history').then(r=>r.json());
    const list=d.items||[];
    $('#histCount').textContent=list.length?list.length+' 条':'暂无';
    $('#histTotal').textContent=d.items&&d.items.length?
      `磁盘占用 ${d.total_mb} MB · 自动保留最近 ${d.max_jobs} 条 / ${d.max_disk_gb} GB`:'';
    if(!list.length){
      $('#histList').innerHTML='<div class="empty">暂无历史记录——完成一次寻优后会自动存档，可随时回看与预览。</div>';
      return;
    }
    $('#histList').innerHTML=list.map(it=>{
      const t=new Date(it.time*1000).toLocaleString();
      const okB=it.best_under?'<span class="badge badge-ok">达标</span>':'<span class="badge badge-no">未达标</span>';
      return '<div class="hist-item"><div class="hist-meta">'+
        '<b>'+esc(it.name)+'</b>'+
        '<span class="muted-sm">'+t+' · 原 '+fmtMB(it.orig_size)+' · '+it.pages+' 页 · 目标 ≤ '+fmtMB(it.target_bytes)+' · '+it.n_ok+'/'+it.n_total+' 候选达标'+(it.files?(' · 磁盘 '+it.disk_mb+' MB'):' · 文件已清理')+'</span>'+
        '<span class="muted-sm">最优：'+esc(it.best_label||'—')+
        (it.best_size?(' · '+fmtMB(it.best_size)):'')+
        (it.best_ssim!=null?(' · SSIM '+it.best_ssim):'')+' '+okB+'</span></div>'+
        '<div class="hist-actions">'+
        (it.files?'<button class="btn btn-outline btn-sm" data-hview="'+it.id+'">查看结果</button>'
                 :'<span class="badge badge-muted">仅记录</span>')+
        '<button class="btn btn-ghost btn-sm danger-text" data-hdel="'+it.id+'">删除</button>'+
        '</div></div>';
    }).join('');
  }catch(e){/* ignore */}
}
document.addEventListener('click',async e=>{
  const v=e.target.closest('[data-hview]');
  if(v){const id=v.dataset.hview;
    try{const s=await fetch('/api/history/detail?id='+id).then(r=>r.json());
      renderSummary(s,'hist:'+id);}catch(err){toast('读取历史失败');}
    return;}
  const dl=e.target.closest('[data-hdel]');
  if(dl){if(!confirm('删除该条历史记录及其压缩文件？'))return;
    await fetch('/api/history/delete?id='+dl.dataset.hdel,{method:'POST'});
    loadHistory();toast('已删除');}
});
$('#histRefresh').onclick=loadHistory;
$('#histClear').onclick=async()=>{
  if(!confirm('确定清空全部历史记录？此操作不可恢复。'))return;
  await fetch('/api/history/clear',{method:'POST'});
  loadHistory();toast('已清空');
};
loadHistory();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "PDFOpt/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---- helpers ----
    def _send(self, code, body, ctype="application/json; charset=utf-8",
              extra=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    # ---- routes ----
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/":
            self._send(200, HTML, "text/html; charset=utf-8")
        elif u.path == "/api/info":
            d = probe_deps()
            self._json({"fitz": bool(d["fitz"]), "PIL": bool(d["PIL"]),
                        "numpy": bool(d["numpy"]), "skimage": bool(d["skimage"]),
                        "gs": d["gs"], "cpu": d["cpu"]})
        elif u.path == "/api/job":
            job = SERVER.job
            if not job or q.get("id", [""])[0] != job["id"]:
                self._json({"error": "任务不存在"}, 404)
                return
            self._json(job_snapshot(job))
        elif u.path == "/api/download":
            self._download(q)
        elif u.path == "/api/history":
            self._json({"items": history_list(),
                        "total_mb": history_disk_mb(),
                        "max_jobs": MAX_HISTORY_JOBS,
                        "max_disk_gb": MAX_HISTORY_DISK_GB})
        elif u.path == "/api/history/detail":
            rec = history_record(q.get("id", [""])[0])
            if rec is None:
                self._json({"error": "记录不存在"}, 404)
            else:
                self._json(rec)
        elif u.path == "/api/history/file":
            self._hist_file(q)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/optimize":
            self._optimize(q)
        elif u.path == "/api/history/delete":
            delete_history(q.get("id", [""])[0])
            self._json({"ok": True})
        elif u.path == "/api/history/clear":
            clear_history()
            self._json({"ok": True})
        elif u.path == "/api/cancel":
            job = SERVER.job
            if job and q.get("id", [""])[0] == job["id"]:
                job["cancel"] = True
                eng = ENGINE_HOLDER.get("engine")
                if eng is not None:
                    eng.cancelled = True
            self._json({"ok": True})
        elif u.path == "/api/shutdown":
            self._json({"ok": True})
            threading.Thread(target=SERVER.httpd.shutdown, daemon=True).start()
        else:
            self._json({"error": "not found"}, 404)

    # ---- upload & start ----
    def _optimize(self, q):
        if SERVER.job and SERVER.job["state"] == "running":
            self._json({"ok": False, "error": "已有任务在运行，请等待完成或取消"}, 409)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 100:
                raise ValueError("请上传 PDF 内容")
            name = (q.get("name", ["upload.pdf"])[0])[:180]
            cfg = {
                "target": max(0.1, float(q.get("target", ["20"])[0])),
                "unit": q.get("unit", ["MB"])[0],
                "margin": float(q.get("margin", ["1"])[0]),
                "workers": int(q.get("workers", ["0"])[0]) or (os.cpu_count() or 4),
                "sample": int(q.get("sample", ["5"])[0]),
                "eval": q.get("eval", ["1"])[0] == "1",
                "modes": [m for m in q.get("modes", ["smart"])[0].split(",")
                          if m in MODE_NAMES],
            }
            if not cfg["modes"]:
                raise ValueError("未选择任何模式")
        except Exception as e:
            self._json({"ok": False, "error": "参数错误: %s" % e}, 400)
            return

        job = new_job(name, cfg)
        tmp_pdf = os.path.join(job["tmp"], "src.pdf")
        try:
            remain = length
            with open(tmp_pdf, "wb") as f:
                while remain > 0:
                    chunk = self.rfile.read(min(1 << 20, remain))
                    if not chunk:
                        break
                    f.write(chunk)
                    remain -= len(chunk)
        except Exception as e:
            self._json({"ok": False, "error": "接收文件失败: %s" % e}, 500)
            return
        if os.path.getsize(tmp_pdf) < 100:
            self._json({"ok": False, "error": "文件为空或不是 PDF"}, 400)
            return

        SERVER.job = job
        threading.Thread(target=job_thread, args=(job, tmp_pdf),
                         daemon=True).start()
        self._json({"ok": True, "job_id": job["id"]})

    def _serve_pdf(self, path, filename, attach):
        """以 application/pdf 输出；attach=False 时内联（浏览器原生预览）"""
        try:
            with open(path, "rb") as f:
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length",
                                 str(os.path.getsize(path)))
                disp = "attachment" if attach else "inline"
                self.send_header("Content-Disposition",
                                 "%s; filename*=UTF-8''%s"
                                 % (disp, quote(filename)))
                self.end_headers()
                shutil.copyfileobj(f, self.wfile)
        except Exception:
            pass

    def _download(self, q):
        job = SERVER.job
        if not job or q.get("id", [""])[0] != job["id"]:
            self._json({"error": "任务不存在"}, 404)
            return
        row = job["rows"].get(q.get("row", [""])[0])
        path = row.get("file") if row else None
        if not path or not os.path.exists(path):
            self._json({"error": "文件不存在"}, 404)
            return
        self._serve_pdf(path, download_name(job, row), "dl" in q)

    def _hist_file(self, q):
        jid = os.path.basename(q.get("id", [""])[0])
        if not _valid_history_id(jid):
            self._json({"error": "文件不存在（可能已被清理）"}, 404)
            return
        rec = history_record(jid)
        row = (rec or {}).get("rows", {}).get(q.get("row", [""])[0])
        fn = row.get("file") if row else None
        path = os.path.join(HISTORY_ROOT, jid, fn) if fn else None
        if not fn or not os.path.isfile(path):
            self._json({"error": "文件不存在（可能已被清理）"}, 404)
            return
        stem = os.path.splitext(os.path.basename(rec.get("name") or "历史"))[0]
        tag = {"smart": "智能重压", "gs": "GS", "raster": "栅格化",
               "lossless": "无损"}.get(row.get("mode"), "方案")
        out = "%s_%s_%s.pdf" % (stem, tag,
                                row.get("label", "").replace(" ", "")
                                .replace("/", ""))
        self._serve_pdf(path, out, "dl" in q)


# ---------------------------------------------------------------------------
# 任务管理
# ---------------------------------------------------------------------------

SERVER = type("S", (), {"job": None})
ENGINE_HOLDER = {"engine": None}


def new_job(name, cfg):
    tmp = tempfile.mkdtemp(prefix="up_", dir=JOBS_ROOT)
    return {"id": uuid.uuid4().hex[:12], "name": name, "cfg": cfg,
            "tmp": tmp, "state": "running", "stage": "排队中",
            "rows": {}, "order": [], "total": 0,
            "t0": time.time(), "summary": None, "error": None,
            "cancel": False}


def job_snapshot(job):
    rows = []
    for t in job["order"]:
        r = {k: v for k, v in job["rows"].get(t, {}).items()
             if not k.startswith("_")}
        rows.append(r)
    return {"state": job["state"], "stage": job["stage"],
            "total": job["total"], "elapsed": round(time.time() - job["t0"]),
            "rows": rows,
            "summary": job["summary"], "error": job["error"]}


def download_name(job, row):
    stem = os.path.splitext(os.path.basename(job["name"]))[0]
    tag = {"smart": "智能重压", "gs": "GS", "raster": "栅格化",
           "lossless": "无损"}[row["mode"]]
    return "%s_%s_%s.pdf" % (stem, tag,
                             row["label"].replace(" ", "").replace("/", ""))


# ---------------------------------------------------------------------------
# 历史记录（本地持久化：pdf_optimizer_history/<job_id>/）
# ---------------------------------------------------------------------------

def archive_job(job, eng):
    """任务结束后把候选 PDF 与结果记录归档到历史目录，并清理临时目录。"""
    try:
        summary = job.get("summary") or {}
        hdir = os.path.join(HISTORY_ROOT, job["id"])
        os.makedirs(hdir, exist_ok=True)
        rows_view = summary.get("rows") or {}
        for tid, r in rows_view.items():
            f = r.get("file")
            if not f or not os.path.exists(f):
                continue
            dest = os.path.join(hdir, "%s.pdf" % tid)
            try:
                shutil.move(f, dest)
            except Exception:
                continue
            r["file"] = "%s.pdf" % tid          # 历史记录存相对名
            live = eng.rows.get(tid)            # 当前会话下载链接保持可用
            if live is not None:
                live["file"] = dest
        record = {"id": job["id"], "time": time.time(), "name": job["name"],
                  "cfg": job["cfg"],
                  "orig_size": summary.get("orig_size"),
                  "pages": summary.get("pages"),
                  "target_bytes": summary.get("target_bytes"),
                  "best": summary.get("best"), "min_row": summary.get("min_row"),
                  "mode_best": summary.get("mode_best"),
                  "previews": summary.get("previews") or {},
                  "rows": rows_view}
        with open(os.path.join(hdir, "record.json"), "w",
                  encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False)
        shutil.rmtree(job["tmp"], ignore_errors=True)
        prune_history()
    except Exception:
        pass


def _history_dirs():
    if not os.path.isdir(HISTORY_ROOT):
        return []
    out = []
    for d in os.listdir(HISTORY_ROOT):
        p = os.path.join(HISTORY_ROOT, d)
        if os.path.isdir(p) and os.path.isfile(os.path.join(p, "record.json")):
            out.append(p)
    return out


def history_record(jid):
    if not _valid_history_id(jid):
        return None
    p = os.path.join(HISTORY_ROOT, jid, "record.json")
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def history_list():
    items = []
    for p in _history_dirs():
        rec = history_record(os.path.basename(p))
        if not rec:
            continue
        rows = rec.get("rows") or {}
        n_ok = sum(1 for r in rows.values() if r.get("size"))
        best = rows.get(rec.get("best") or "", {})
        disk = 0
        files_ok = False
        for tid in rows:
            fp = os.path.join(p, "%s.pdf" % tid)
            if os.path.isfile(fp):
                files_ok = True
                try:
                    disk += os.path.getsize(fp)
                except OSError:
                    pass
        items.append({"id": rec["id"], "time": rec.get("time"),
                      "name": rec.get("name"),
                      "orig_size": rec.get("orig_size"),
                      "pages": rec.get("pages"),
                      "target_bytes": rec.get("target_bytes"),
                      "best_label": best.get("label"),
                      "best_size": best.get("size"),
                      "best_ssim": best.get("ssim"),
                      "best_under": best.get("under"),
                      "n_total": len(rows), "n_ok": n_ok,
                      "files": files_ok, "disk_mb": round(disk / 1e6, 1)})
    items.sort(key=lambda x: x.get("time") or 0, reverse=True)
    return items


def history_disk_mb():
    total = 0
    for p in _history_dirs():
        for f in os.listdir(p):
            fp = os.path.join(p, f)
            if os.path.isfile(fp):
                try:
                    total += os.path.getsize(fp)
                except OSError:
                    pass
    return round(total / 1e6, 1)


def _valid_history_id(jid):
    """历史 ID 只允许 12 位十六进制（uuid4 截断），杜绝路径注入。"""
    return bool(re.fullmatch(r"[0-9a-f]{12}", str(jid or "")))


def delete_history(jid):
    if not _valid_history_id(jid):
        return
    target = os.path.join(HISTORY_ROOT, jid)
    # 双重保险：解析真实路径必须位于历史根目录内
    try:
        real = os.path.realpath(target)
        if os.path.commonpath([real, os.path.realpath(HISTORY_ROOT)]) != os.path.realpath(HISTORY_ROOT):
            return
        if os.path.isdir(real):
            shutil.rmtree(real, ignore_errors=True)
    except Exception:
        pass


def clear_history():
    shutil.rmtree(HISTORY_ROOT, ignore_errors=True)
    os.makedirs(HISTORY_ROOT, exist_ok=True)


def prune_history():
    stats = []
    for p in _history_dirs():
        size = 0
        for f in os.listdir(p):
            fp = os.path.join(p, f)
            if os.path.isfile(fp):
                try:
                    size += os.path.getsize(fp)
                except OSError:
                    pass
        stats.append((os.path.getmtime(p), p, size))
    stats.sort(reverse=True)          # 新 → 旧
    total = sum(s for _, _, s in stats)
    count = len(stats)
    for mt, p, size in reversed(stats):   # 从最旧开始删
        if count <= MAX_HISTORY_JOBS and total <= MAX_HISTORY_DISK_GB * 1e9:
            break
        shutil.rmtree(p, ignore_errors=True)
        count -= 1
        total -= size


def job_thread(job, tmp_pdf):
    def log(ev, data):
        if ev == "row":
            job["rows"][data["id"]] = data
            if data["id"] not in job["order"]:
                job["order"].append(data["id"])
        elif ev == "total":
            job["total"] = data
        elif ev == "stage":
            job["stage"] = data

    eng = None
    try:
        eng = Engine(tmp_pdf, job["cfg"], log)
        ENGINE_HOLDER["engine"] = eng
        summary = eng.run()
        clean = dict(summary)
        # 将行数据并入 summary 供前端渲染
        rows_view = {}
        for t in eng.order:
            r = dict(eng.rows[t])
            r.pop("_t0", None)
            r.pop("_result_path", None)
            rows_view[t] = r
        clean["rows"] = rows_view
        job["summary"] = clean
        job["state"] = "cancelled" if eng.cancelled else "done"
        job["stage"] = "已取消" if eng.cancelled else "完成"
        archive_job(job, eng)   # 归档到历史记录（含候选 PDF）
    except Exception as e:
        job["state"] = "error"
        job["error"] = str(e)
        job["stage"] = "失败"
    finally:
        ENGINE_HOLDER["engine"] = None


def cleanup_jobs():
    os.makedirs(JOBS_ROOT, exist_ok=True)
    dirs = sorted((os.path.join(JOBS_ROOT, d) for d in os.listdir(JOBS_ROOT)),
                  key=lambda p: os.path.getmtime(p), reverse=True)
    for p in dirs[MAX_KEEP_JOBS:]:
        shutil.rmtree(p, ignore_errors=True)


# ---------------------------------------------------------------------------
# CLI 一键模式（不开网页）
# ---------------------------------------------------------------------------

def run_cli(args):
    src = args.cli
    if not os.path.exists(src):
        print("文件不存在:", src)
        return 2
    modes = [m for m in (args.modes or "smart,lossless,gs,raster").split(",")
             if m in MODE_NAMES]
    cfg = {"target": args.target, "unit": args.unit, "margin": args.margin,
           "workers": args.workers or (os.cpu_count() or 4),
           "sample": args.sample, "eval": not args.no_eval,
           "modes": modes, "previews": False}
    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)

    def log(ev, data):
        if ev == "row" and data.get("status") in ("done", "failed", "timeout"):
            if data["status"] == "done":
                ss = ("SSIM %.4f" % data["ssim"]) if data.get("ssim") is not None else "-"
                print("  ✓ %-14s %-34s %8.2f MB  %s  (%ss)"
                      % (data["mode_name"], data["label"],
                         data["size"] / 1e6, ss, data.get("elapsed")))
            else:
                print("  ✗ %-14s %-34s 失败: %s"
                      % (data["mode_name"], data["label"],
                         data.get("error", "")[:80]))
        elif ev == "stage":
            print("—", data)
        elif ev == "total":
            pass

    print("输入:", src, "(%.2f MB)" % (os.path.getsize(src) / 1e6))
    eng = Engine(src, cfg, log)
    summary = eng.run()
    ok, elig = eng.eligible_rows()
    best = eng._pick(elig)
    print()
    if best:
        r = eng.rows[best]
        out = os.path.join(outdir, "%s_优化_%s.pdf"
                           % (os.path.splitext(os.path.basename(src))[0],
                              r["label"].replace(" ", "")))
        shutil.copyfile(os.path.join(eng.tmp, "%s.pdf" % best), out)
        print("推荐方案:", r["mode_name"], "·", r["label"])
        print("  体积 %.2f MB（目标 ≤ %s %s）%s" % (
            r["size"] / 1e6, args.target, args.unit,
            ("  SSIM %.4f" % r["ssim"]) if r.get("ssim") is not None else ""))
        print("  已保存:", out)
    else:
        print("未找到达标方案，请提高目标体积或减少模式限制。")
    print("全部候选已存于:", eng.tmp)
    return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def find_free_port(host):
    s = socket.socket()
    s.bind((host, 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--worker":
        run_worker(argv[1])
        return
    ap = argparse.ArgumentParser(description="PDF 体积寻优工具")
    ap.add_argument("--port", type=int, default=0, help="网页端口（默认自动）")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cli", metavar="PDF", help="命令行一键模式（不开网页）")
    ap.add_argument("--target", type=float, default=20)
    ap.add_argument("--unit", default="MB", choices=["MB", "MiB"])
    ap.add_argument("--margin", type=float, default=1.0)
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--sample", type=int, default=5)
    ap.add_argument("--modes", default="smart,lossless,gs,raster")
    ap.add_argument("--no-eval", action="store_true")
    ap.add_argument("--outdir", default="pdf_opt_out")
    args = ap.parse_args(argv)

    if args.cli:
        sys.exit(run_cli(args))

    cleanup_jobs()
    os.makedirs(HISTORY_ROOT, exist_ok=True)
    prune_history()
    port = args.port or find_free_port(args.host)
    httpd = ThreadingHTTPServer((args.host, port), Handler)
    httpd.daemon_threads = True
    SERVER.httpd = httpd
    url = "http://%s:%d/" % (args.host, port)
    print("PDF 体积寻优工具 已启动:", url)
    print("依赖:", {k: v for k, v in probe_deps().items()})
    print("按 Ctrl+C 退出")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
