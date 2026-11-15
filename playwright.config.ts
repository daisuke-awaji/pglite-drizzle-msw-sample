import { defineConfig, devices } from '@playwright/test'

// e2e はビルドしたアプリ（vite preview）を本物のブラウザで操作する。
// ブラウザごとに IndexedDB が分かれるので、テストごとにまっさらなサンプルデータから始まる。
//
// - CI: `npx playwright install --with-deps chromium` のあと `npm run test:e2e`
// - 手元: 同じ。ブラウザを入れずに既存の Chromium を使うときは PW_CHROMIUM_PATH にパスを渡す
const PORT = Number(process.env.E2E_PORT ?? 4173)
const executablePath = process.env.PW_CHROMIUM_PATH || undefined

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // 失敗したときのスクリーンショットやトレースの置き場所（既定はリポジトリ直下の test-results/）
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results',
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never', outputFolder: process.env.PW_REPORT_DIR ?? 'playwright-report' }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // 指で操作するスマートフォン（タッチ・狭い画面）。Pixel 7 は Chromium で動く
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
