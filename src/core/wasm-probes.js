// WASM / 引擎状态探测装配：把各引擎的「按需预载」动作注册进 wasm-registry。
// 状态上报分散在各加载点（worker 内经 engine.js 转发；pandoc/typst/字体在本模块 probe 内），
// 这里只负责定义元信息与 probe 闭包，供设置面板触发。
import { defineEngine } from './wasm-registry.js';
import { warmEngine, run as engineRun } from './engine.js';
import { getPandoc } from './mdpandoc.js';
import { markdownToPdfTypst } from './mdtypst.js';
import { probeFonts } from './fonts.js';
import { setEngineStatus } from './wasm-registry.js';

export function setupEngineRegistry() {
  if (setupEngineRegistry._done) return;
  setupEngineRegistry._done = true;

  defineEngine({
    id: 'pdflib',
    label: 'pdf-lib',
    desc: 'PDF 结构读写核心，随引擎 Worker 常驻内存',
    size: '内置',
    probe: async () => warmEngine(),
  });
  defineEngine({
    id: 'pdfjs',
    label: 'pdf.js',
    desc: '页面渲染、文本提取与缩略图（含 CMap / 标准字体资源）',
    size: '内置',
    probe: async () => { await engineRun('engine.warm', { engine: 'pdfjs' }, { tray: false }); },
  });
  defineEngine({
    id: 'mupdf',
    label: 'MuPDF',
    desc: '加密 PDF 解锁 / 解密 / 光栅化（WASM）',
    size: '内置 · 按需加载',
    probe: async () => { await engineRun('engine.warm', { engine: 'mupdf' }, { tray: false }); },
  });
  defineEngine({
    id: 'tesseract',
    label: 'Tesseract.js',
    desc: 'OCR 文字识别（WASM 核心 + 本地语言包 chi_sim / chi_tra / eng）',
    size: '核心 ~5MB + 语言包',
    probe: async () => { await engineRun('engine.warm', { engine: 'tesseract' }, { tray: false }); },
  });
  defineEngine({
    id: 'pandoc',
    label: 'Pandoc',
    desc: '通用文档转换（WASM）：Markdown → typst / docx 等链路的前端',
    size: '55.9MB',
    probe: async () => {
      await getPandoc({ onStage: (s) => setEngineStatus('pandoc', 'loading', s) });
      setEngineStatus('pandoc', 'ready');
    },
  });
  defineEngine({
    id: 'typst',
    label: 'Typst 编译器',
    desc: '杂志级排版引擎（WASM）：Markdown → PDF，首次编译需数秒',
    size: '27MB + 字体包',
    probe: async () => {
      await markdownToPdfTypst('引擎预热\n\n===\n\n这是一次引擎状态探测编译。', { paper: 'a4', onStage: (s) => setEngineStatus('typst', 'loading', s) });
      setEngineStatus('typst', 'ready');
    },
  });
  defineEngine({
    id: 'fonts',
    label: 'Noto Sans SC 字体包',
    desc: '中文水印与 Typst 排版的 CJK 字体（2 字重子集）',
    size: '~4.4MB',
    probe: async () => {
      setEngineStatus('fonts', 'loading', '检查字体包…');
      const r = await probeFonts();
      setEngineStatus('fonts', r['noto-sc'] ? 'ready' : 'error', r['noto-sc'] ? '已部署 · 中文水印可用' : '未部署（水印功能受限）');
    },
  });
}
