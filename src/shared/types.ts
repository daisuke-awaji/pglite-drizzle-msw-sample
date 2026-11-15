// UI と API の間でやり取りする形（JSON なので日付は文字列）。
// UI はこの型だけを知っていて、DB やスキーマには依存しない。
export type Todo = {
  id: number
  title: string
  done: boolean
  createdAt: string
}

export type ApiError = { error: string }
