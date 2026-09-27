# 测试架构说明

本项目测试分三层，各层职责独立、互不替代：

| 层 | 位置 | 运行器 | 职责 |
|---|---|---|---|
| 单元测试 | `tests/unit/` | vitest | 纯逻辑模块：页范围解析、几何坐标、水印规格、SSIM、diff、压缩规划器、历史配额 |
| e2e 测试 | `tests/e2e/` | Playwright（真实 Chromium） | 真实上传文件 → 浏览器 WASM 处理 → 捕获真实下载产物到 `tests/e2e/.artifacts/` |
| 独立校验 | `tests/verify/` | pytest（python） | 用 pypdf / PyMuPDF / Pillow **独立交叉验证** e2e 产物的结构、内容、像素、加密属性 |
| 旧版回归 | `tests/legacy/` | pytest | 旧版 `pdf_optimizer.py` 三处修复的回归（历史 ID 校验、路径穿越拒绝、RGB+SMask 压缩） |

「浏览器生产、python 独立验证」：e2e 产物由浏览器内 WASM 引擎生成，校验层用完全不同的引擎
（python 生态）读同一份字节流做断言，避免同源实现错误互相掩盖。

## 运行顺序

```bash
bash scripts/run_tests.sh              # 全部：unit → build → e2e → verify(+legacy)
bash scripts/run_tests.sh --verify-only   # 只跑 python 校验（需要 .artifacts 已有产物）
bash scripts/run_tests.sh --e2e-only      # 只跑 e2e
```

分步手动运行：

```bash
npx vitest run                                   # 单元测试
npx playwright test                              # e2e（自动 build + 起静态服务器 :8137）
python3 -m pytest tests/verify -v                # 独立校验
python3 -m pytest                                # 校验 + 旧版回归（pytest.ini testpaths）
```

## 夹具

全部测试夹具由 `scripts/build_fixtures.py` 程序化合成（无任何用户私有内容），
输出到 `tests/fixtures/out/`：multi3/multi8（中英文多页）、rotated90（/Rotate=90）、
smask_alpha（SMask 透明）、scan2（扫描件模拟）、enc_user123（AES-256）、
photo_l/photo_p/alpha.png、doc.docx、slides.pptx、corrupted（截断损坏）。

```bash
python3 scripts/build_fixtures.py    # 幂等；e2e helper 会在缺失时自动重建
```

## 产物约定（e2e → verify 的接口）

e2e 用 `helpers.saveDownload(page, 按钮名, 保存名)` 把下载产物存到 `tests/e2e/.artifacts/`。
verify 层按通配符查找（`find_artifact("watermark*.pdf")`）：

| 产物通配符 | 来源工具 | 校验要点 |
|---|---|---|
| `*merge*.pdf` | 合并 | 页数/顺序/文字 |
| `split*.zip` | 拆分 | ZIP 内 PDF 页数之和=原页数 |
| `organize*.pdf` | 页面整理 | 页数/渲染/旋转 |
| `edit*.pdf` | 页面编辑 | 新增文字真实存在 |
| `watermark*.pdf` | 水印 | 像素差证明水印落页、原文字保留、旋转页兼容 |
| `overlay*.pdf` | 叠加 | 页数=底稿、像素差 |
| `images2pdf*.pdf` | 图片转PDF | 页数=图数、含图像 |
| `pdf2images*` | PDF转图片 | Pillow 可开、尺寸>0 |
| `extract*` | 提取图像 | 至少 1 张可开图像 |
| `enc*.pdf` / `dec*.pdf` | 加密/解密 | pypdf+fitz 双引擎验证加密态与内容 |
| `compress*.pdf` | 压缩 | 页数不变、每页可渲染 |
| `text*.txt` / `ocr*` | 文本/OCR | 内容非空、可搜索 PDF 双要素（图像页+文字层） |
| `office*.pdf` | Word/PPT 转 | 可打开可渲染（近似转换，见下） |
| `*report*.txt` / `compare*.zip` | 比较 | 报告结论字样/差异图 |

**诚实标注**：某工具的 e2e 尚未产出产物时，对应 verify 测试自动 `skip`（不会假通过）。
verify 报告中的 `skipped` 数量代表「e2e 未覆盖该产物的导出」，不是校验通过。

## 已知边界（校验层如实反映）

- Office 转 PDF 为浏览器端**近似转换**（DOM→图像→PDF），产物无文字层属预期；
  校验只断言可打开、可渲染、页数>0。
- 栅格化压缩模式的产物文字不可选中，属该模式的明示代价。
- 加密产物只允许用测试夹具自带的已知密码验证（`test123` / `user123`），
  不实现、不测试任何密码破解。
- `.artifacts/` 内产物只读；校验层绝不修改或删除产物，也不触碰用户真实数据目录。
