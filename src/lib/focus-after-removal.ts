import { useRef } from 'react'

// 一覧の行を消すと、行の中にあったフォーカス（操作メニューや削除ボタン）が body に落ちる。
// キーボードの利用者は先頭からやり直しになり、スクリーンリーダーは位置を見失う（WCAG 2.4.3）。
// そこで「消す前」に戻り先を決めておき、行が DOM から消えたらそこへ移す。
// 戻り先: 次の行 → 前の行 → ページの見出し（h1）。行の中では data-row-focus の付いた要素を選ぶ

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** 行が消えるのを待つ上限。モック API の遅延（最大 1 秒）や遅い回線でも間に合うよう長めにとる */
const WAIT_MS = 10_000

function focusTargetIn(row: Element | null): HTMLElement | null {
  if (!row) return null
  return row.querySelector<HTMLElement>('[data-row-focus]') ?? row.querySelector<HTMLElement>(FOCUSABLE)
}

function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('#main h1') ?? document.getElementById('main')
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  return heading
}

/** フォーカスが行と一緒に消えた（または誰も持っていない）ときだけ、こちらで移す */
function focusWasLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/**
 * 行を消す前に呼ぶ。返り値の関数を、削除を送る直前に呼ぶと、行が消えたあとでフォーカスを移す。
 * 削除をやめたとき（確認でキャンセルしたとき）は、返り値を呼ばなければ何もしない
 */
export function planFocusAfterRemoval(row: Element | null): () => void {
  if (!row) return () => {}
  const next = focusTargetIn(row.nextElementSibling)
  const previous = focusTargetIn(row.previousElementSibling)
  return () => {
    const deadline = performance.now() + WAIT_MS
    const tick = () => {
      if (row.isConnected) {
        if (performance.now() < deadline) requestAnimationFrame(tick)
        return
      }
      if (!focusWasLost()) return
      const target = [next, previous].find((el) => el?.isConnected) ?? pageHeading()
      target?.focus({ preventScroll: false })
    }
    requestAnimationFrame(tick)
  }
}

/** 行の要素に付ける ref と、削除の前に呼ぶ planFocusAfterRemoval を組にしたもの */
export function useFocusAfterRemoval<T extends Element>() {
  const ref = useRef<T>(null)
  return { ref, plan: () => planFocusAfterRemoval(ref.current) }
}
