// offline.playwright.config.js — 离线独立运行验证专用配置
// 前置：8088 端口已有静态服务（python3 scripts/serve.py <dist> 8088）
// 本配置不起新服务器、不构建，只连接 8088。
export default {
  testDir: 'tests/e2e',
  testMatch: /offline\.spec\.js/,
  outputDir: 'test-results-offline',
  workers: 1,
  timeout: 300_000,
  use: {
    baseURL: 'http://localhost:8088',
    trace: 'off',
  },
  reporter: [['list']],
};
