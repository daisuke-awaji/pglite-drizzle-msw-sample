// GitHub Pages ではサイトが /<リポジトリ名>/ 配下に置かれるので、API のパスも BASE_URL を基準にする。
// 本番で別ドメインの API を使う場合は VITE_API_BASE で上書きする。
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL}api`
