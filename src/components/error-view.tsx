import { Button } from '@ui-sdk/react/button'
import { CloudOffIcon, FileQuestionIcon, RefreshCwIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Link, useRevalidator } from 'react-router'
import type { ApiError } from '../api/client'
import { describeError, type ErrorKind } from '../lib/describe-error'
import { reportError } from '../lib/report-error'

// ルートのエラー（loader の失敗・描画中の例外）を、利用者が次に取れる行動と一緒に見せる
const VIEW: Record<ErrorKind, { icon: LucideIcon; title: string }> = {
  'not-found': { icon: FileQuestionIcon, title: 'ページが見つかりません' },
  retryable: { icon: CloudOffIcon, title: 'データを読み込めませんでした' },
  http: { icon: TriangleAlertIcon, title: 'このページを表示できません' },
  unexpected: { icon: TriangleAlertIcon, title: '問題が発生しました' },
}

export function ErrorView({ error, home = true }: { error: unknown; home?: boolean }) {
  const { kind, status, message } = describeError(error)
  const { icon: Icon, title } = VIEW[kind]
  const revalidator = useRevalidator()
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // 想定外のエラーだけを記録する（404 や通信断は利用者の操作や環境によるもので、不具合ではない）
    if (kind === 'unexpected') reportError(error, { source: 'route' })
    // 画面が差し替わったことをスクリーンリーダーにも伝わるよう、見出しへフォーカスを移す
    heading.current?.focus()
  }, [error, kind])

  return (
    <div className="error-page" role="alert" aria-labelledby="error-title">
      <Icon aria-hidden="true" className="error-icon" />
      {status && <p className="error-code tabular">{status}</p>}
      <h1 id="error-title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="muted">{message}</p>
      <div className="row error-actions">
        {kind === 'retryable' && (
          <Button data-variant="solid" onClick={() => revalidator.revalidate()} disabled={revalidator.state !== 'idle'} focusableWhenDisabled>
            <RefreshCwIcon aria-hidden="true" />
            再試行
          </Button>
        )}
        {kind === 'unexpected' && (
          <Button data-variant="solid" onClick={() => location.reload()}>
            <RefreshCwIcon aria-hidden="true" />
            ページを読み込み直す
          </Button>
        )}
        {home && <Link to="/">ダッシュボードへ戻る</Link>}
      </div>
      {import.meta.env.DEV && kind === 'unexpected' && <ErrorDetails error={error} />}
    </div>
  )
}

// 開発中だけ、原因の調べやすさのためにスタックトレースを出す（本番では利用者に内部情報を見せない）
function ErrorDetails({ error }: { error: unknown }): ReactNode {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  return (
    <details className="error-details">
      <summary>詳細（開発時のみ表示）</summary>
      <pre>{text}</pre>
    </details>
  )
}

/** 画面の一部（カードなど）が読めなかったときの小さな表示 */
export function InlineError({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <TriangleAlertIcon aria-hidden="true" />
      <p>{error.message}</p>
      {onRetry && error.retryable && (
        <Button onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />
          再試行
        </Button>
      )}
    </div>
  )
}
