/**
 * モック API（MSW + ブラウザ内の PGlite）で動かすビルドか。
 * VITE_USE_MOCK=false でビルドすると false になり、これで囲んだ開発用の機能（障害シミュレーション・
 * サンプルデータへの初期化・DB の状態表示など）はバンドルから消える
 */
export const USES_MOCK_API = import.meta.env.VITE_USE_MOCK !== 'false'
