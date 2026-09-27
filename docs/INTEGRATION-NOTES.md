# 集成清单（Phase 2 / Phase 3 待办）

> 来源：Phase 1 各簇代理的"发现但未修"报告 + 主线程实现 E/D 簇过程中发现并已修复的引擎缺陷。
> 状态标记：[ ] 待处理 / [x] 已完成

## 已修复（2026-09-27，E/D 簇实现过程中发现）

- [x] **engine-worker `replaceExt` 未定义**（crypto.encrypt/decrypt 产物命名 ReferenceError）→ 已在 withSuffix 旁补定义。
- [x] **engine-worker `fmtMB` 未定义**（compress.run 进度回调 ReferenceError，格式化模块在 format.js）→ 已 import。
- [x] **tesseract.js v7 默认请求 `.traineddata.gz`**（本地为未压缩 tessdata_fast → 404）→ getTessWorker 增加 `gzip: false`。
- [x] **OCR 可搜索 PDF 无文字层**：tesseract v7 词坐标嵌在 `w0.bbox.x0/y1`，引擎按顶层字段读取得 NaN，drawText 全部静默抛错 → 已按 bbox 兼容取值 + Number.isFinite 守卫。

## 已修复（2026-09-27 晚，用户报告"水印完全不显示"后）

- [x] **引擎 pageMeta() 盒形状错误**：产出 `{x,y,w,h}` 而 geometry.normBox 只认
  `{x,y,width,height}`/`{x0,y0,x1,y1}` → 视觉坐标全 NaN（wm.apply/preview 画空、
  单锚点 ReferenceError——即 B 文件头所述缺陷的根因）→ 已改 pageMeta 产出 width/height。
  **B 的主线程绕过绘制可择机切回引擎 wm.\*（不急，现路径已稳定）。**
- [x] **水印字体三连修**：①原打包 OTF(CFF) 经 pdf-lib subset:true 产出损坏字形
  （MuPDF: FT_New_Memory_Face unknown format，中文全部不可见）；②自写 otf2ttf 转换
  字形映射错位；③最终资产 = Google Fonts 官方可变 TTF → instancer(wght 400/700) →
  fontTools 子集（约 10MB/个），重建脚本 scripts/build_fonts.sh。
- [x] **pdf-lib subset:true 对大型 CJK 字体的字形损坏**（部分字渲染、部分空白/错字，
  官方 TTF 也复现）→ CJK 文字全面改走**栅格化路径**：Canvas/OffscreenCanvas 逐行
  绘字 → 透明 PNG → drawImage（旋转锚点修正 + ExtGState 透明度）。主线程水印
  （watermark-editor.js）与引擎页面编辑（engine-worker page.addContent）都已切换；
  拉丁内置字体保持矢量。产物体积 KB 级（3 页平铺水印 18.9KB）。
  诚实标注：栅格水印文字不可选中（本就是覆盖标记，影响可忽略）。
- [x] **sanitizeLayer 层级键名错位**：模型读 `layer.layer`、编辑器写 `layer.layerSide`，
  背景层被静默降级为前景 → 模型层兼容两种键。
- [x] **新增全屏水印**：watermark-model 增 `placement:'fullscreen'` + `density`
  （sanitizeLayer 钳制 1-16）与 `fullscreenLayout()`（均匀格子 + 四周出血一圈，
  旋转后仍覆盖页角——isam.top 3×3 网格的强化版，调研报告见会话记录）；编辑器
  平铺方式增"全屏铺满"选项 + 密度输入；水印工具页新增**独立**"一键全屏水印"卡片
  （默认 45°/透明度 0.15/暗黄 #c8c832/密度 4，与图层模式互不影响）。
  单测 4 项（fullscreenLayout/sanitize 兼容）。

### 遗留小项
- [ ] 引擎 OCR 隐藏文字层仍走 subset:true 矢量（不可见层，字形损坏不影响搜索性，
      ToUnicode 正确）；如需完美可切栅格。
- [ ] B 的 under+图片层路径 embedImageAny 嵌入的是外层 doc，prependAsFormXObject
      经 save/load/copy 迁移资源是否完整待验证（水印 under 文字已实测正常）。
- [ ] A 完成后 edit 工具的 CJK 文字对象走引擎 raster 路径，verify 的 edit 文字断言
      （get_text 含"测试水印文字"）会失效 → 需改为像素级断言（栅格无文字层）。

## C 簇（图像与比较）报告

- [ ] **engine-worker `decodeImageXObject` 不支持无 Filter 未压缩图像流**
  （`src/core/engine-worker.js:959-993` 附近）。修复后 `images.extract` 对未压缩
  DCTDecode/FlateDecode 之外的图像流也应产出；C 簇在 extractimages.js 里的主线程
  fallback 保留为兜底，修复后可在 warnings 里注明"已由引擎原生处理"。
- [ ] **SMask 单独对象枚举顺序不同时，composite 模式可能多产出主图/SMask 拆分产物**
  （`src/core/engine-worker.js:959-993`）。修复：枚举时按 IndirectObject 归组去重。
- [ ] **pdf.js CID 字体（STSong-Light 等非嵌入 CJK）不可见** → 资产已复制：
  `public/pdfjs/cmaps`（1.6MB）+ `public/pdfjs/standard_fonts`（816K）。
  待办：engine-worker `getDocument` 传 `cMapUrl: assetBase+'pdfjs/cmaps/',
  cMapPacked: true, standardFontDataUrl: assetBase+'pdfjs/standard_fonts/'`。
  影响面：缩略图/预览/比较像素 diff/图文报告截图的 CJK 可见性。**高优先**。
- [ ] **engine.js `run()` 自动装载名单不含 `aDocId/bDocId`**（比较工具已手动
  ensureDoc 绕过）。修复：名单加入 aDocId/bDocId（以及任何双文档 op 参数）。
- [ ] **多代理并行跑 playwright 竞争 `tests/e2e/.tmp` 与 dist**（偶发 ENOENT 假失败）。
  缓解：Phase 3 全量 e2e 由主代理串行执行；必要时 playwright.config 增
  `outputDir` 隔离 + webServer 加互斥等待。

## B 簇（水印）报告

（待 B 完成后补充）

## A / D / E 簇报告

- D/E 簇已由主代理直接实现（并发限额所迫），e2e 15/15 通过：
  compress 3、security 4（含 pypdf 交叉验证）、office 3、ocr 3、text 2。
- OCR 结果卡会显示诊断字段：识别词数 / 字体错误 / 绘制错误（正常时只有词数）。

## 已确认事实（集成时直接引用）

- C 簇 e2e 11/11 通过（images2pdf/pdf2images/extractimages/compare）。
- compare.run 需要 aDocId/bDocId 手动 ensureDoc（engine run() 名单修复前）。
- extractimages.js 内含主线程 fallback 提取器（引擎 0 产物时启用并写 warnings）。
- pytest verify 层 24 项就绪（tests/verify/），产物名约定见 tests/README.md。
  当前 18 过 / 4 skip；watermark_rotated 与 overlay 2 项因 B 代理 WIP 产物暂挂，
  B 完成后复跑。
- 报告要求：图文并茂 + 16 工具全覆盖（report-capture.spec 逐工具真实操作截图）。
