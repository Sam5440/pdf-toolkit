#!/usr/bin/env python3
"""本地静态服务器：正确的 MIME、Range 支持、SPA 回退。
仅用于服务静态站点；不接收、不处理任何用户文件数据。
用法: python3 scripts/serve.py [目录] [端口]
"""
import http.server
import os
import re
import socketserver
import sys
import urllib.parse

ROOT = sys.argv[1] if len(sys.argv) > 1 else "dist"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".otf": "font/otf",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".traineddata": "application/octet-stream",
    ".gz": "application/gzip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def send_head(self):
        # SPA 回退：未知无扩展名路径 → index.html
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.splitext(self.path)[1]:
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    if not os.path.isdir(ROOT):
        print(f"目录不存在: {ROOT}（先运行 npx vite build）", file=sys.stderr)
        sys.exit(1)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"PDF 万能工具箱: http://127.0.0.1:{PORT}/  (根目录: {os.path.abspath(ROOT)})")
        print("按 Ctrl+C 退出")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
