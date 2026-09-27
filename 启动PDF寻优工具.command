#!/bin/bash
# 双击启动 PDF 体积寻优工具（自动打开浏览器面板）
cd "$(dirname "$0")"
exec python3 pdf_optimizer.py
