# AGENTS.md

- UI は `@ui-sdk/react` で組む。使う前に ui-sdk スキルがあればそれに従い、`node_modules/@ui-sdk/react/docs/llms.txt` を読む。
  部品を新しく作るときは `node_modules/@ui-sdk/react/docs/core.md` を見出しで検索し、同じフォルダの `rendering.md` も読む。
- サーバーのデータは React Router の `loader` / `action` で読み書きする。業務ロジックと検証は `src/server` に置き、MSW や PGlite に依存させない（`src/architecture.test.ts` が確かめる）。
- エンドポイントは `src/server/routes.ts` に足す（MSW も本番のサーバーも同じ表を登録する）。プロトタイプ専用のもの（サンプルデータ・全消去・障害シミュレーション）は `src/mocks` に置き、画面側は `USES_MOCK_API`（`src/lib/env.ts`）で囲む。
- loader では `load()`、action では `validate()` と `run()` を通す（`src/routes/lib.ts`）。エラーの出し方がそろう。画面の一部だけ失敗させたいときは `settle()`。
- 入力の形は `src/shared/schemas.ts` の Zod スキーマに一本化する（サーバー層と `action` の両方で使う）。
- 端末ごとの設定は `src/stores/preferences.ts`、下書きは `src/stores/drafts.ts`、絞り込みなどは URL に置く。
- スキーマを変えたら `npm run db:generate -- --name <変更内容>` で `drizzle/` に SQL を追加する。
- 表には `table-stack` クラスと各セルの `data-label` を付ける（スマートフォンでカードになる）。アイコンだけのボタンには `aria-label` を付ける。
- テスト: DB を使うものは `*.integration.test.ts(x)`、それ以外は `*.test.ts(x)`、ブラウザでしか分からないことは `e2e/`。
  エンドポイントを足したら `src/api/api.integration.test.ts` に、画面を足したら `src/routes/app.integration.test.tsx` と `e2e/pages.spec.ts` にケースを足す。
  テスト中の console.error / warn は失敗になる。わざと出すときだけ `allowConsole()` で許可する。
- 変更したら `npm run check`（lint・型・unit/integration・カバレッジ）を通す。開発用の機能に触れたら `npm run check:no-mock-build` も通す。画面を変えたら `npm run test:e2e` も通す。
