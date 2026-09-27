# 开发契约（CONTRACTS）— 并行开发必读

所有 subagent 开发前必须阅读本文档。**主代理独占** `src/core/`、`src/components/ui.js`、`src/components/input.js`、`src/main.js`、`src/tools/registry.js`、`src/tools/core.js`；**各代理只写自己名下的文件**。需要改动共享文件时，在最终报告里提出，由主代理统一处理。

## 1. 架构总览

纯静态站点（Vite + 原生 ES modules）。**所有文件处理在浏览器内 Web Worker 完成，文件字节绝不发送网络**。后台只是静态资源服务器（scripts/serve.py）。

```
浏览器
  main.js（应用壳/路由/主题/历史页/设置）
  tools/<id>.js       ← 各代理负责（每工具一个文件，自注册）
  components/         ← ui.js / input.js（主代理）；pagethumbs.js（共享，只读使用）
                        watermark-editor.js（代理B）、compare-view.js（代理C）等各自新建
  core/
    engine.js         ← run(op,args,opts,docsMap) / abort(opId) / ensureDoc(doc)
    engine-worker.js  ← 全部 PDF op 实现（主代理拥有；接口见下）
    geometry.js       ← 坐标变换（visual↔user、tile、角度）
    pagerange.js      ← parsePageRange(input, pageCount) / splitGroups
    watermark-model.js← sanitizeLayer / resolveLayerPages / applyTemplateVars / tileLayout
    ssim.js / textdiff.js / compress-planner.js / errors.js / format.js
    history.js（IndexedDB）/ settings.js / fonts.js / download.js / files.js
```

## 2. 引擎 op 协议（engine-worker.js 已实现的接口）

主线程调用：`run(op, args, {onProgress}, docsMap)`；`docsMap` 是 `Map(docId → document)`（document 来自 `addDocument(file)`，含 `.file` File 对象）。返回 `{artifacts, summary, warnings?, ...}`，另有 `_opId` 供取消。错误为 `Error` 且带 `code`（`ERR_*`，见 core/errors.js）。

| op | args | 返回 |
|---|---|---|
| `doc.open`（engine 自动） | — | `{pageCount, pages:[{index,w,h,media,rot,crop,visualW,visualH}], encrypted, needsPassword, meta, warnings, size}` |
| `doc.unlock` | `{docId, password}` | 同上（解密副本替换） |
| `doc.render` | `{docId, page(0基), dpi, gray?, bg?}` | `{bitmap(ImageBitmap), width, height, visualW, visualH}` |
| `pages.merge` | `{items:[{docId, pages:'1-3,5'∣'all'}]}` | `{artifacts:[{name,mime,bytes}], summary:{pages}}` |
| `pages.split` | `{docId, mode:{kind:'each'∣'every'∣'ranges', n?, groups?}, baseName?}` | artifacts 每组一个 |
| `pages.organize` | `{docId, plan:[{srcDocId?, srcPage, rotation(绝对0/90/180/270), crop?{x,y,w,h 视觉坐标}, blank?{w,h}}]}` | artifact 整理结果 |
| `page.addContent` | `{docId, edits:[{page, objects:[...]}]}`（见 §3） | artifact |
| `wm.apply` | `{docId, spec:{layers:[...]}, vars?}` | artifact；vars 含 `{docName,date,time}` |
| `wm.preview` | `{docId, page, spec, vars, dpi?}` | `{bitmap, width, height, visualW, visualH}` —— 与导出同一绘制路径 |
| `overlay.apply` | `{baseDocId, overlayDocId, mapping:{mode:'oneToOne'∣'repeatFirst'∣'custom', custom?:[{base,over}]}, options:{scale, opacity, offsetX, offsetY, under}}` | artifact |
| `images.toPdf` | `{images:[{name, bytes(Uint8Array), mime}], paper:'auto'∣'a4'∣'a3'∣'letter'∣'a5', orientation, margin(pt), fit:'contain'∣'cover', bg?}` | artifact |
| `pdf.toImages` | `{docId, pages, dpi, format:'png'∣'jpeg', quality, bg}` | artifacts 每页一个 |
| `images.extract` | `{docId, pages, mode:'raw'∣'composite'}` | artifacts + `{summary:{found,skipped}, warnings}` |
| `crypto.encrypt` | `{docId, userPassword, ownerPassword?, permissions?}` | artifact 加密 PDF（AES-256，mupdf） |
| `crypto.decrypt` | `{docId, password}` | artifact 解密 PDF |
| `compress.run` | `{docId, modes:{smart,raster,structural}, targetBytes?, targetMargin?, minSsim?, evalSample?, evalDpi?}` | `{rows:[{id,mode,params,label,ok,size,ratio,ssim,ssimMin,elapsed,error?}], bestId, minId, qualityId, srcSize, artifacts}` |
| `ocr.run` | `{docId, pages, langs:'chi_sim+eng', dpi, mode:'auto'∣'ocr'∣'searchable', minNativeChars?}` | `{artifacts(可搜索pdf+txt), pages:[{page,ocr,chars}], summary}` |
| `text.extract` | `{docId, pages}` | `{pages:[{page, text, chars}]}` |
| `compare.run` | `{aDocId, bDocId, pagesA, pagesB, dpi, threshold, withText}` | `{pairs, textDiffs, extraA, extraB, bitmaps:[{a,b,pct,bitmap,width,height}]}` |

进度回调收到 `{stage, done, total, rows?}`。取消：`run()` 返回的 Promise 结果带 `_opId`，传给 `abort(opId)`；worker 在页/候选间检查并抛 `ERR_CANCELLED`。

**注意**：`run()` 需要传 `docsMap`（工具里用 `new Map(docs.map(d=>[d.id,d]))`），否则引擎无法自动装载文件字节。

## 3. 水印层规格（wm.apply spec.layers，sanitizeLayer 校验）

```js
{
  type: 'text' | 'image',
  // 文字层
  text: '多行支持\n第二行 {页码}',   // 模板变量：{页码} {总页数} {文件名} {日期} {时间}
  fontId: 'auto'|'helvetica'|'times'|'courier'|'noto-sc',
  fontSize: 48, bold: false, align: 'left'|'center'|'right',
  color: '#888888', opacity: 0.35,
  // 图片层（imageBytes 为 Uint8Array，imageMime 可选）
  // 公共定位
  anchor: 'tl'..'mc'..'br', offsetX: 0, offsetY: 0,   // pt，视觉坐标
  rotation: 0,             // 度，视觉逆时针（worker 换算页面旋转）
  placement: 'single'|'tile'|'diagonal',
  tileSpacingX: 80, tileSpacingY: 80, stagger: false, marginX: 20, marginY: 20,
  layerSide: 'over'|'under',   // under 用 Form XObject 前置，保真（保留注释/链接）
  pages: 'all'|'odd'|'even'|'custom', customRange: '1-3,5',
}
```

**真实预览**：调 `wm.preview`（与导出同代码），得到 ImageBitmap 画到 canvas。编辑器交互（拖动等）在 canvas 上换算：canvas 像素 → 页面视觉 pt：`ptX = (canvasX / rect.width) * visualW`。防抖 350ms + 递增版本号，旧响应丢弃（比较 `reqVersion !== myVersion` 则不渲染）。

**页面编辑对象**（page.addContent，坐标全部为视觉 pt，相对该页可视区左上）：
`{type:'text', text, x, y, w?, fontSize, color, opacity, rotation, fontId, bold, align}`
`{type:'image', bytes, mime, x, y, w, h, opacity, rotation}`
`{type:'rect'|'highlight'|'ellipse', x, y, w, h, color, opacity, fill?, stroke?, strokeWidth?}`

## 4. 工具模块契约（tools/<id>.js）

```js
import { registerTool } from './core.js';

registerTool({
  id: 'watermark',            // 唯一
  name: '添加水印',
  icon: '💧',                 // 单个 emoji
  group: 'content',           // optimize|pages|content|convert|security|check
  desc: '一句话（首页卡片与顶栏显示）',
  accepts: 'pdf',             // pdf|image|office
  multiple: false,
  render(container) {
    // container 是 .ws-main；用 inputPanel + 参数 + 开始按钮 + progressCard + 结果卡
  },
});
```

- UI 构建：用 `components/ui.js`（field/select/numberInput/textInput/passwordInput/checkbox/row/button/progressCard/toast/openModal/warningsBox）。**禁止 innerHTML 注入用户内容**；静态模板 innerHTML 可用但用户值必须走 `esc()` 或 textContent。
- 结果展示：每个产物一张 `.result-artifact` 行 + 下载按钮（`downloadArtifact`）+ "保存到历史"（`addHistory`，outputs 带 Blob）+ 多产物时提供"打包下载 ZIP"（`downloadZip`）。
- 警告展示用 `warningsBox(res.warnings)`。
- 大提示（近似转换/语义损失等限制）用 `.alert.alert-warn` 置顶展示。
- 输入面板：`inputPanel({multiple, accept, acceptHint, acceptTest})`，`panel.docs()` 取文档。
- 执行中：开始按钮 disable；进度用 progressCard（`set(pct, text)` / `indeterminate(text)` / `error(msg)`）；结束后恢复按钮。
- 取消：保留 opId，提供取消按钮调 `abort(opId)`（v1 至少压缩/OCR/比较提供）。

## 5. 各代理文件所有权（Phase 1）

| 代理 | 独占新建/替换 |
|---|---|
| A 页面簇 | `tools/split.js`、`tools/organize.js`、`tools/edit.js`、`tests/e2e/{split,organize,edit}.spec.js`；可用（只读）`components/pagethumbs.js` |
| B 水印簇 | `tools/watermark.js`、`tools/overlay.js`、`components/watermark-editor.js`（新建）、`tests/e2e/{watermark,overlay}.spec.js` |
| C 图像与比较簇 | `tools/images2pdf.js`、`tools/pdf2images.js`、`tools/extractimages.js`、`tools/compare.js`、`components/compare-view.js`（新建）、`tests/e2e/{images2pdf,pdf2images,extractimages,compare}.spec.js` |
| D 转换与OCR簇 | `tools/office.js`、`tools/ocr.js`、`tools/text.js`、`components/office-worker-helpers.js`（如需）、`tests/e2e/{office,ocr,text}.spec.js` |
| E 压缩与安全簇 | `tools/compress.js`、`tools/security.js`、`tests/e2e/{compress,security}.spec.js` |
| F 测试基建 | `playwright.config.js`、`tests/e2e/helpers.js`、`tests/verify/*.py`、`tests/README.md`、`scripts/run_tests.sh`、`.github/workflows/tests.yml`（可选） |

**禁止**：修改 `src/core/**`、`src/tools/registry.js`、`src/tools/core.js`、`src/main.js`、`src/components/ui.js|input.js|pagethumbs.js`、`package.json`、`vite.config.js`、他人名下文件。发现共享代码缺陷 → 写进最终报告。

## 6. e2e 测试契约（tests/e2e/<tool>.spec.js，Playwright）

- `test.describe('<tool> 工具')`；`test.beforeEach`：`await page.goto(BASE)` 后点击 `a.side-link[href="#/tool/<id>"]`。
- 上传必须走真实路径：`await page.locator('.dropzone').click()` + `waitForEvent('filechooser')` + `chooser.setFiles([...])`。**禁止 DOM 注入伪造上传**。
- 夹具：`tests/fixtures/out/`（由 `python3 scripts/build_fixtures.py` 生成；spec 里可在 beforeAll 里跑一次或假定存在——F 提供 helper `ensureFixtures()`）。
- 下载验证：`page.waitForEvent('download')` → `dl.saveAs(路径)`（保存到 `tests/e2e/.artifacts/<tool>-*.pdf`）→ 断言文件存在（内容断言由 python verify 套件做，spec 里只做存在性+大小>0；F 的 python 套件对 .artifacts 做深度校验）。
- 每个工具至少：1 条成功链路（含真实下载）、1 条参数错误链路（不出产物、有错误提示）、UI 状态（按钮禁用/恢复）。
- `BASE = process.env.PDFTOOL_BASE || 'http://127.0.0.1:8137/'`（F 的 config 统一）。

## 7. python verify 契约（tests/verify/）

- 独立引擎校验（pypdf/PyMuPDF/pytest）：对 `tests/e2e/.artifacts/**` 的产物断言页数/顺序/文字/尺寸/加密状态/OCR 文本层；命名约定 `<tool>-<case>.pdf`。
- 环境门禁：soffice/tesseract 可用性探测（本机已具备：soffice 26.2.4.2、tesseract 5.5.2 + chi_sim/chi_tra/eng）。
- **不用浏览器产物自证**：校验器用 pypdf 或 fitz，而非 pdf-lib。

## 8. 已知事实（避免重复踩坑）

- mupdf 加密往返已验证：`saveToBuffer('garbage=2,compress=yes,encrypt=aes-256,user-password=X,owner-password=Y,permissions=N')`；密码含 `,`/`=` 会被引擎拒绝（UI 需提示）。
- pdf-lib `drawPage` 无透明度 → 叠加用 `drawEmbeddedWithOpacity`（worker 内已有）。
- pdf.js v6 `getDocument({data})` 会转移 buffer → worker 内已用 `bytes.slice()`。
- `createImageBitmap` 不支持 TIFF → 图片工具需明确报错提示（ERR_UNSUPPORTED 文案已含"请先转换格式"）。
- tesseract.js v7 + 本地语言包在 `public/tessdata/`（tessdata_fast）；`getTessWorker` 已在 worker 内实现。
- 公共资产路径用 `${import.meta.env.BASE_URL}fonts/...`（支持子目录部署）。
- 后台只服务静态文件；任何"上传到后台"的实现都是违约。

## 9. 运行命令

```bash
npx vite build                      # 构建 → dist/
python3 scripts/serve.py dist 8137  # 本地静态服务
npx vitest run                      # 单元测试
npx playwright test                 # e2e（F 配置后）
python3 scripts/build_fixtures.py   # 生成夹具
python3 -m pytest tests/verify tests/legacy -q   # python 校验
```
