/**
 * モック API（MSW + ブラウザ内の PGlite）で動かすビルドか。
 * VITE_USE_MOCK=false でビルドすると false になり、これで囲んだ開発用の機能（障害シミュレーション・
 * サンプルデータへの初期化・DB の状態表示など）はバンドルから消える
 */
export const USES_MOCK_API = import.meta.env.VITE_USE_MOCK !== 'false'

/**
 * ログイン（Cognito）を使うビルドか。VITE_AUTH_MODE=cognito でビルドしたときだけ（AWS へのデプロイ。infra/scripts/deploy/web-env.ts）。
 * モックのビルドとローカルでは使わない（誰が呼んだかの制限もない）
 */
export const USES_AUTH = import.meta.env.VITE_AUTH_MODE === 'cognito'
