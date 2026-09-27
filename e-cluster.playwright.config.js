// e-cluster: E 簇（压缩/安全）专用 e2e 配置 — 连接 8089 独立构建，避开并行代理的 8137/dist 竞争
export default {
  testDir: 'tests/e2e',
  testMatch: /(compress|security|office|ocr|text)\.spec\.js/,
  outputDir: 'test-results-e',
  workers: 1,
  timeout: 300_000,
  use: { baseURL: 'http://localhost:8089', trace: 'off' },
  reporter: [['list']],
};
