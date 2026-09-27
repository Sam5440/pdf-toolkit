import { defineConfig, devices } from '@playwright/test';

const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,      // 共享静态服务器与浏览器内存，串行更稳
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/.report' }]],
  outputDir: 'tests/e2e/.tmp',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite build && python3 scripts/serve.py dist 8137',
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
