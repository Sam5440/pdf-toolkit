import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangelog } from './scripts/gen-changelog.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const BUILD_COMMIT = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();
const BUILD_DATE = new Date().toISOString().slice(0, 10);

/** 构建收尾：把 git log（含提交时间）写入 dist/changelog.json，设置面板「关于」消费 */
function changelogPlugin() {
  return {
    name: 'pdf-toolkit-changelog',
    apply: 'build',
    closeBundle() {
      try {
        const data = buildChangelog({
          version: pkg.version,
          commit: BUILD_COMMIT,
          buildDate: BUILD_DATE,
        });
        const dest = resolve(dirname(fileURLToPath(import.meta.url)), 'dist/changelog.json');
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, JSON.stringify(data));
      } catch { /* 无 git 环境跳过（运行时按缺失降级） */ }
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
  plugins: [changelogPlugin()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8192,
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
