# 与 PDF24（tools.pdf24.org/zh）功能对比报告

对比时间：2026-10-01。PDF24 全站共 **70 个独立工具**（主站 24 个 + all-tools 页面全集，含跨分类重复）。
本项目原有能力：**15 个工具**。全部处理均在浏览器端完成（PDF24 为服务器端处理，两者隐私模型不同）。

## 一、总体对比

| 状态 | 数量 | 说明 |
|---|---|---|
| ✅ 已实现（原有 15 工具覆盖） | 22 个 PDF24 工具 | 见下表映射 |
| 🆕 本次新增（收入「更多」分组） | 48 个 | 见第三节 |
| ⛔ 浏览器端不可行 / 不适用 | 8 项 | 见第四节，附原因 |

## 二、已实现映射（✅ 22 项）

| PDF24 工具 | 本项目对应 | 备注 |
|---|---|---|
| PDF合并 | 合并 PDF | 均支持页范围；本项目还支持 PDF+图片混合 |
| 组合文档 (assemble-pdf) | 合并 PDF | 多文件按序组合，功能一致 |
| PDF拆分 | 拆分 PDF | 每页/每N页/自定义范围 |
| PDF压缩 | PDF 压缩 | 三模式寻优，强于 PDF24 单一压缩 |
| 优化PDF (web-optimize-pdf) | PDF 压缩（结构无损模式） | 同一功能 |
| PDF编辑 | 页面编辑 | 文字/图片/形状 |
| 注释PDF (annotate-pdf) | 页面编辑 | 添加文字/形状即注释 |
| 图片转PDF / JPG转PDF / PNG转PDF / WEBP转PDF | 图片转 PDF | 同一实现，支持浏览器可解码的全部格式 |
| PDF转图像 / PDF转JPG / PDF转PNG | PDF 转图片 | PNG/JPEG + DPI/质量 |
| 从PDF提取图像 | 提取图片 | 含 SMask 合成 |
| 用密码保护PDF | 密码保护（加密） | AES-256 |
| 移除PDF密码保护 | 密码保护（解锁） | 同一工具双向 |
| PDF页面重排 (rearrange-pdf-pages) | 页面整理 | 缩略图拖拽重排 |
| OCR 文字识别 | OCR 文字识别 | Tesseract 本地 |
| 添加水印 | 添加水印 | 功能超集（平铺/全屏/模板变量） |
| PDF叠加 | PDF 叠加 | 一致 |
| 比较PDF文件 | PDF 比较 | 像素+文本 diff |
| PDF转文本 (pdf-to-txt) | 提取文本 | 一致 |
| Word转PDF / DOCX转PDF | Word/PPT 转 PDF | 旧 .doc 不支持（两家一致：PDF24 也是服务器转换） |
| PowerPoint转PDF / PPTX转PDF | Word/PPT 转 PDF | 同上 |
| 查看PDF和其他文件 (view-pdf) | 🆕 PDF 查看器（本次新增，见下） | 原无，本次补齐 |
| — | — | — |

## 三、本次新增（🆕 48 个工具，全部收入「更多」分组，默认不在主页显示）

### 3.1 页面操作（9 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| 旋转 PDF | 旋转PDF页面 | 指定页范围绝对/相对旋转（pdf-lib 原位旋转） |
| 删除 PDF 页面 | 删除PDF页面 | 页范围剔除重建 |
| 提取 PDF 页面 | PDF页面提取 | 页范围抽取为新文件 |
| 每页页面数 (N-up) | 每页页面数 | 2/4/6/9/16 版，矢量嵌入（embedPage），支持横向/纵向/加边框 |
| 页面切半 | 将PDF页面裁切为两半 | 左右/上下切分，矢量裁剪（BBox），顺序可选 |
| 裁剪 PDF | 裁剪 PDF | 边距/百分比/精确框三种模式设置 CropBox |
| 更改页面大小 | 更改 PDF 页面大小 | A4/A3/A5/Letter，适应/填充/拉伸 |
| 添加页码 | 在PDF文件添加页码 | 9 宫格位置、起始号、格式模板（第 n 页/共 N 页）、字号颜色边距、CJK 安全 |
| 添加书签 | 为PDF添加书签 | 大纲（Outline）层级写入，低层 PDF 对象构建 |

### 3.2 信息与安全（8 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| 修改文档信息 | 修改 PDF 文档信息 | 标题/作者/主题/关键词/创建修改时间 |
| 移除元数据 | 移除PDF元数据 | Info 字典清空 + XMP 剥离 |
| 查看器偏好 | 设置PDF查看器偏好 | PageMode/PageLayout/隐藏工具栏等 Catalog 位 |
| PDF 涂黑 | PDF涂黑 | mupdf Redact 注解 **真删除文字**（非仅盖黑框），失败回退绘制黑框 |
| PDF 签署 | PDF签署 | 手绘/输入签名 → 图章落页（复用编辑绘制管线） |
| 填写 PDF 表单 | 填写PDF | 枚举 AcroForm 字段 → 文本/复选框/单选/下拉赋值，可选扁平化 |
| 创建可填写表单 | 创建可填写的PDF表单 | 指定页/位置/尺寸添加文本框与复选框字段 |
| 密码生成器 | 生成密码 | 纯本地随机，长度/字符集可配 |

### 3.3 优化与修复（3 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| 扁平化 PDF | 扁平化PDF文件 | 表单扁平化（矢量保留）/ 栅格化扁平（注释、图层全部烧入）双模式 |
| 栅格化 PDF | 栅格化PDF | 指定 DPI/格式/灰度整册转图像 PDF |
| 修复 PDF | 修复 PDF | mupdf 重建交叉引用+垃圾回收，回退 pdf-lib 容错重存 |

### 3.4 查看与检查（2 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| PDF 查看器 | 查看PDF和其他文件 | pdf.js 渲染，翻页/缩放/旋转 |
| PDF 搜索 | 在 PDF 中搜索 | 全册文本检索：页码/次数/上下文摘要，大小写/正则可选 |

### 3.5 创建与转换入 PDF（12 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| 生成 PDF | 生成PDF / 撰写PDF | 富文本编辑（标题/正文/列表/粗体/对齐）→ 分页渲染 → PDF；撰写PDF 合并到此实现 |
| 文本转 PDF | 文本转PDF | .txt 编码自适应，字体/页幅/边距可调 |
| Markdown 转 PDF | Markdown转PDF | 标题/列表/粗斜体/代码块/引用/分隔线 |
| RTF 转 PDF | RTF转PDF | RTF 子集解析（\\uN Unicode、分组、十六进制字节） |
| EPUB 转 PDF | EPUB转PDF | ZIP+XHTML 解析（fflate + DOMParser）→ 分页 |
| ODF 转 PDF | ODT/ODS/ODP/ODG转PDF（4卡合一） | content.xml 文本抽取 → 分页 |
| Excel 转 PDF | Excel转PDF / XLSX转PDF | .xlsx 解析（共享字符串/内联）→ 表格分页；旧 .xls 不支持 |
| SVG 转 PDF | SVG转PDF | 浏览器原生解码 → 高分辨率位图嵌入 |
| TIFF 转 PDF | TIFF转PDF | 自研 TIFF 解码器（LZW/PackBits/Deflate/无压缩） |
| HEIC 转 PDF | HEIC转PDF | 优先原生解码（Safari 可用），失败给出明确引导 |
| 网页转 PDF | 网页转PDF | **降级实现**：URL 直取（受 CORS 限制）或上传 .html/.mhtml → 正文抽取 → PDF（隐私模型不允许走服务器抓取） |
| 扫描件转 PDF | 用摄像头创建PDF | getUserMedia 拍摄多张 → 图片转 PDF |

### 3.6 图像工具（3 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| WebP 转 JPG/PNG | WEBP转换为JPG / PNG（2卡合一） | Canvas 重编码，批量 ZIP |
| HEIC 转 JPG/PNG | HEIC转换为JPG / PNG（2卡合一） | 原生解码（Safari）/ 明确失败提示 |
| 生成二维码 | 生成二维码 | QR 编码（引入 MIT 小型库 qrcode-generator，全版本/纠错级）→ PNG |

### 3.7 PDF 导出为其他格式（10 个）

均为**文本级转换**（保留全部文字与段落结构，不保留排版像素级还原；PDF24 为服务器端转换，保真度同样受限于源文件）：

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| PDF 转 Word | PDF转Word / PDF转DOCX | 自建最小 DOCX（OOXML ZIP）段落/标题 |
| PDF 转 PPT | PDF转PowerPoint / PPTX | 每页一帧文本框 |
| PDF 转 Excel | PDF转Excel / XLSX | 行文本 → 工作表（多空格分列尝试） |
| PDF 转 HTML | PDF转HTML | 语义化单文件 HTML（标题/段落/页分隔） |
| PDF 转 Markdown | PDF转Markdown | 字号启发式标题 + 段落/页分隔 |
| PDF 转 RTF | PDF转RTF | 最小 RTF 写入器（\\uN 转义） |
| PDF 转 EPUB | PDF转EPUB | ZIP+OPF+NCX，每章一 XHTML |
| PDF 转 ODF | PDF转ODT/ODS/ODP（3卡合一） | content.xml 最小写入 |
| PDF 转 TIFF | PDF转TIFF | 自研多页 TIFF 编码器（无压缩 RGB，Pillow 可读） |
| PDF 转 SVG | PDF转SVG | 整页位图封装 SVG（浏览器端无矢量追踪路径，如实标注） |

### 3.8 其他（1 个）

| 新工具 | 对应 PDF24 | 实现方式 |
|---|---|---|
| 发票生成 | 创建发票 / 可视化创建发票（2卡合一） | 表单化填写（甲乙方/条目表/税率）→ 表格分页 PDF |

## 四、⛔ 浏览器端不可行 / 不适用（8 项，如实说明）

| PDF24 工具 | 原因 |
|---|---|
| 网页转PDF（URL 直接走服务器抓取） | 隐私模型禁止经第三方服务器；已提供「URL 尝试 + 上传 HTML」降级版（见 3.5） |
| PDF转PDF/A | 真正的 PDF/A 需 ICC 色彩档案、全字体嵌入与一致性校验，浏览器引擎无法保证合规；出具假 PDF/A 反而有害 |
| 检查 PDF/A | 同上，需 veraPDF 级校验器 |
| 创建电子发票 / PDF发票转电子发票 / XML电子发票转PDF / 验证电子发票 | ZUGFeRD/Factur-X/XRechnung 等 EN16931 XML 标准族庞大且强校验，超出浏览器工具合理范围 |
| Publisher转PDF / PUB转PDF | 旧二进制格式浏览器无法解析（与本项目对旧 .doc/.ppt 的立场一致） |
| Excel转PDF 中的旧 .xls | 同上 |
| PDF24 Creator / PDF打印机 / PDF阅读器 | Windows 桌面软件，非 Web 工具，不适用 |

## 五、测试与一致性验证

新增功能沿用项目三层测试架构（「浏览器生产、Python 独立验证」）：

1. **vitest 单元**：QR 编码器（尺寸/ Finder 图案/已知向量）、TIFF 编解码 roundtrip、RTF/Markdown/HTML 解析、OOXML/ODF 写入器结构；
2. **Playwright e2e**：每个新工具的真实上传→处理→下载链路（真实 filechooser 与下载捕获）；
3. **pytest 独立校验**：pypdf/PyMuPDF/Pillow 等不同引擎交叉验证产物——旋转角度、页数、CropBox、大纲树、AcroForm 字段值、涂黑后文字确实被移除、TIFF 可被 Pillow 解码、DOCX/XLSX/PPTX/ODF/EPUB 可被标准库解包并解析出文本、二维码用 OpenCV 解码比对。
