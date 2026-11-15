import { useEffect } from 'react'
import { useBlocker } from 'react-router'
import { confirmDanger } from '../components/confirm-danger'

/**
 * 保存していない変更があるとき、別の画面への移動とタブを閉じる操作の前に確認する。
 * - アプリ内の移動（リンク・戻る）: 確認ダイアログを出し、「破棄して移動」を選んだときだけ進む
 * - タブを閉じる・再読み込み: ブラウザ標準の確認を出す（文言はブラウザが決める）
 */
export function useUnsavedChanges(dirty: boolean, description = '入力した内容は保存されていません。移動すると失われます。') {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  )

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let active = true
    const ask = async () => {
      const ok = await confirmDanger({ title: '保存していない変更があります', description, confirmLabel: '破棄して移動' })
      if (!active) return
      if (ok) blocker.proceed()
      else blocker.reset()
    }
    void ask()
    return () => {
      active = false
    }
  }, [blocker, description])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
