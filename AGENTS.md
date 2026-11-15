# AGENTS.md

- UI は `@ui-sdk/react` で組む。使う前に ui-sdk スキルがあればそれに従い、`node_modules/@ui-sdk/react/docs/llms.txt` を読む。
  部品を新しく作るときは `node_modules/@ui-sdk/react/docs/core.md` を見出しで検索し、同じフォルダの `rendering.md` も読む。
- サーバーのデータは React Router の `loader` / `action` で読み書きする。業務ロジックと検証は `src/server` に置き、MSW や PGlite に依存させない（`src/architecture.test.ts` が確かめる）。
- エンドポイントは `src/server/routes.ts` に足す（MSW も本番のサーバーも同じ表を登録する）。サーバー関数は `access`（`src/server/access.ts`）を受け取り、ログインした人が見てよいものだけを読み書きする（見えないものは 404、管理者だけの操作は 403）。`src/server/access.integration.test.ts` の表にケースを足す。プロトタイプ専用のもの（サンプルデータ・全消去・障害シミュレーション）は `src/mocks` に置き、画面側は `USES_MOCK_API`（`src/lib/env.ts`）で囲む。
- loader では `load()`、action では `validate()` と `run()` を通す（`src/routes/lib.ts`）。エラーの出し方がそろう。画面の一部だけ失敗させたいときは `settle()`。
- 入力の形は `src/shared/schemas.ts` の Zod スキーマに一本化する（サーバー層と `action` の両方で使う）。
- 端末ごとの設定は `src/stores/preferences.ts`、下書きは `src/stores/drafts.ts`、絞り込みなどは URL に置く。
- スキーマを変えたら `npm run db:generate -- --name <変更内容>` で `drizzle/` に SQL を追加する。
  生成された SQL を読み、`npm run check:migrations` を通す。`main` に入ったマイグレーションは書き換えない（直すときは新しいマイグレーションを足す）。
  列の削除・名前や型の変更は 1 回のリリースでしない（「足す → 移す → 切り替える → 消す」。`docs/production.md` の「マイグレーション」）。
- 表には `table-stack` クラスと各セルの `data-label` を付ける（スマートフォンでカードになる）。アイコンだけのボタンには `aria-label` を付ける。
- 名前・タイトルなど利用者が入れる文字は、入力できる最大の長さでも崩れないようにする。全体を読む画面（見出し・説明・コメント）は折り返し、一覧・カードは `clamp-2` / `clamp-3`、1 行に収める所（パンくず・担当者・タグ）は `truncate` にして `title` で全体を出す。flex・grid の子が中身で広がらないよう `min-width: 0` か `minmax(0, 1fr)` を付ける。画面を足したら `e2e/long-text.spec.ts` にも足す。
- テスト: DB を使うものは `*.integration.test.ts(x)`、それ以外は `*.test.ts(x)`、ブラウザでしか分からないことは `e2e/`。
  エンドポイントを足したら `src/api/api.integration.test.ts` に、画面を足したら `src/routes/app.integration.test.tsx` と `e2e/pages.spec.ts` にケースを足す。
  テスト中の console.error / warn は失敗になる。わざと出すときだけ `allowConsole()` で許可する。
- 変更したら `npm run check`（lint・型・unit/integration・server・カバレッジ）を通す。開発用の機能に触れたら `npm run check:no-mock-build` も通す。画面を変えたら `npm run test:e2e` も通す。
- 本番のサーバー（`server/`）や DB に触れたら、本物の PostgreSQL で `TEST_DATABASE_URL=postgres://... npm run test:integration && npm run test:server` も通す。
- AWS の構成（`infra/`）やデプロイの手順に触れたら `cd infra && npm run typecheck && npm test` を通す。cdk-nag の指摘はまず直し、直せないときだけ `infra/lib/nag.ts` に理由を書いて認める。AWS の資格情報を使う操作（deploy など）は人が行う。
