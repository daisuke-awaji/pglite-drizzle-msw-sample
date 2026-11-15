# AGENTS.md

- UI は `@ui-sdk/react` で組む。使う前に ui-sdk スキルがあればそれに従い、`node_modules/@ui-sdk/react/docs/llms.txt` を読む。
  部品を新しく作るときは `node_modules/@ui-sdk/react/docs/core.md` を見出しで検索し、同じフォルダの `rendering.md` も読む。
- サーバーのデータは React Router の `loader` / `action` で読み書きする。業務ロジックと検証は `src/server` に置き、HTTP や PGlite に依存させない。
- 入力の形は `src/shared/schemas.ts` の Zod スキーマに一本化する（サーバー層と `action` の両方で使う）。
- 端末ごとの設定は `src/stores/preferences.ts`、下書きは `src/stores/drafts.ts`、絞り込みなどは URL に置く。
- スキーマを変えたら `npm run db:generate -- --name <変更内容>` で `drizzle/` に SQL を追加する。
- 変更したら `npm run lint`、`npm run typecheck`、`npm test` を通す。
