import { reportError } from './lib/report-error'

// 起動（モック API・ブラウザ内 DB の準備）に失敗したときの画面。
// React やルーターが動く前に失敗することもあるので、DOM を直接組み立てる

/** PGlite が IndexedDB に作るデータベース名（src/db/client.browser.ts の idb://starter-kit） */
export const IDB_NAME = '/pglite/starter-kit'

export function explainBootFailure(error: unknown, env: { indexedDB: boolean; serviceWorker: boolean }): string {
  if (!env.serviceWorker) {
    return 'このブラウザでは Service Worker を使えないため、アプリを動かせません。https のページか localhost で開いてください。プライベートブラウズでは使えないことがあります。'
  }
  if (!env.indexedDB) {
    return 'このブラウザではデータを保存できない（IndexedDB を使えない）ため、アプリを動かせません。プライベートブラウズを終了するか、別のブラウザで開いてください。'
  }
  const text = error instanceof Error ? error.message : String(error)
  if (/quota|storage/i.test(text)) {
    return 'ブラウザの保存領域が足りません。ほかのサイトのデータを消すか、下のボタンでこのアプリのデータを消してからやり直してください。'
  }
  return 'データベースの準備に失敗しました。読み込み直しても直らないときは、このアプリのデータを消してからやり直してください。'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

export function renderBootError(root: HTMLElement, error: unknown) {
  reportError(error, { source: 'boot' })
  const message = explainBootFailure(error, {
    indexedDB: typeof indexedDB !== 'undefined',
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  })

  const reload = el('button', { type: 'button', className: 'boot-button', textContent: '読み込み直す' })
  reload.addEventListener('click', () => location.reload())

  const wipe = el('button', { type: 'button', className: 'boot-button', textContent: 'このアプリのデータを消して読み込み直す' })
  wipe.addEventListener('click', () => {
    if (!window.confirm('ブラウザ内のデータ（プロジェクト・タスクなど）をすべて消します。よろしいですか？')) return
    const req = indexedDB.deleteDatabase(IDB_NAME)
    for (const type of ['success', 'error', 'blocked']) req.addEventListener(type, () => location.reload())
  })

  const details = el(
    'details',
    { className: 'boot-details' },
    el('summary', { textContent: '技術的な詳細' }),
    el('pre', { textContent: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  )

  const heading = el('h1', { id: 'boot-error-title', tabIndex: -1, textContent: 'アプリを起動できませんでした' })
  const panel = el(
    'main',
    { className: 'boot-error' },
    el(
      'div',
      { className: 'boot-error-body' },
      heading,
      el('p', { textContent: message }),
      el('div', { className: 'boot-actions' }, reload, wipe),
      details,
    ),
  )
  panel.setAttribute('role', 'alert')
  panel.setAttribute('aria-labelledby', 'boot-error-title')
  root.replaceChildren(panel)
  document.title = '起動できませんでした | Starter Kit'
  heading.focus()
}
