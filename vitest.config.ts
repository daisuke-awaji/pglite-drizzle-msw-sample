import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// テストは 2 種類に分ける。どちらも `npm test` でまとめて走る。
// - unit:        *.test.ts(x)             DB も HTTP も使わない。速いので、保存のたびに回す
// - integration: *.integration.test.ts(x) 本物の PostgreSQL（PGlite）と MSW をつないで確かめる
// e2e（ビルドしたアプリをブラウザで操作する）は e2e/ にあり、Playwright で別に走らせる
export default mergeConfig(
  viteConfig({ command: 'serve', mode: 'test' }),
  defineConfig({
    test: {
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      // 乱数順で走らせ、テスト同士の隠れた依存（前のテストのデータを当てにするなど）を見つける
      sequence: { shuffle: { files: false, tests: true } },
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'jsdom',
            include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
            exclude: ['src/**/*.integration.test.{ts,tsx}'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            environment: 'jsdom',
            include: ['src/**/*.integration.test.{ts,tsx}'],
            testTimeout: 20_000,
            hookTimeout: 30_000,
            // TEST_DATABASE_URL があれば本物の PostgreSQL に流す（src/test/db.ts）。前後で複製した DB を掃除する
            globalSetup: ['./src/test/postgres-global-setup.ts'],
          },
        },
      ],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/test/**',
          'src/main.tsx',
          'src/vite-env.d.ts',
          // ブラウザでしか動かない起動処理（IndexedDB・Service Worker）は e2e で確かめる
          'src/db/client.browser.ts',
          'src/db/migrate.browser.ts',
          'src/mocks/browser.ts',
          // 型だけのファイルと、開発者ツール用のブリッジ（window.agent）
          'src/shared/types.ts',
          'src/agent.ts',
        ],
        reporter: ['text-summary', 'html', 'json-summary'],
        // 下回ったら CI を落とす。上げるのはよいが、理由なく下げない（README の「カバレッジ」を参照）
        thresholds: { statements: 85, branches: 72, functions: 85, lines: 87 },
      },
    },
  }),
)
