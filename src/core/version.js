// 完整版本号信息。__APP_VERSION__ 等由 vite 构建时 define 注入（vite.config.js），
// vitest 等非 vite 环境回退到 package.json 语义（typeof 判断兼容未定义标识符）。
export const APP_NAME = 'PDF 万能工具箱';
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0';
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_DATE = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';
export const APP_REPO = 'https://github.com/Sam5440/pdf-toolkit';
export const APP_REPO_ISSUES = 'https://github.com/Sam5440/pdf-toolkit/issues';
export const APP_LICENSE = 'MIT';
/** 完整版本号串，如：v1.0.0 · 5433d06 · 2026-10-04 */
export const APP_VERSION_FULL = `v${APP_VERSION} · ${BUILD_COMMIT}${BUILD_DATE ? ` · ${BUILD_DATE}` : ''}`;
