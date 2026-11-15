import { afterEach, describe, expect, test, vi } from 'vitest'
import { explainBootFailure, IDB_NAME, renderBootError } from './boot-error'
import { allowConsole } from './test/console'

const ok = { indexedDB: true, serviceWorker: true }

describe('起動に失敗した理由の説明', () => {
  test('Service Worker を使えない環境（http のページ・一部のプライベートブラウズ）', () => {
    expect(explainBootFailure(new Error('x'), { ...ok, serviceWorker: false })).toMatch(/Service Worker/)
  })
  test('IndexedDB を使えない環境', () => {
    expect(explainBootFailure(new Error('x'), { ...ok, indexedDB: false })).toMatch(/IndexedDB/)
  })
  test('保存領域が足りない', () => {
    expect(explainBootFailure(new DOMException('QuotaExceededError: quota'), ok)).toMatch(/保存領域/)
  })
  test('それ以外は、データを消してやり直す方法を案内する', () => {
    expect(explainBootFailure('boom', ok)).toMatch(/データを消して/)
  })
})

describe('起動に失敗したときの画面', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  function render() {
    allowConsole(/\[boot\]/)
    const root = document.createElement('div')
    document.body.append(root)
    renderBootError(root, new Error('wasm の読み込みに失敗'))
    return root
  }

  test('見出しにフォーカスを移し、理由・対処・技術的な詳細を出す', () => {
    const root = render()
    const heading = root.querySelector('h1')!
    expect(heading).toHaveTextContent('アプリを起動できませんでした')
    expect(document.activeElement).toBe(heading)
    expect(root.querySelector('[role="alert"]')).toBeTruthy()
    expect(root.querySelector('pre')).toHaveTextContent('Error: wasm の読み込みに失敗')
    expect(document.title).toBe('起動できませんでした | Starter Kit')
  })

  test('「データを消して読み込み直す」は確認してから IndexedDB を消す', () => {
    const deleteDatabase = vi.fn(() => new EventTarget())
    vi.stubGlobal('indexedDB', { deleteDatabase })
    const confirm = vi.spyOn(window, 'confirm')
    const root = render()
    const wipe = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('データを消して'))!

    confirm.mockReturnValueOnce(false)
    wipe.click()
    expect(deleteDatabase).not.toHaveBeenCalled()

    confirm.mockReturnValueOnce(true)
    wipe.click()
    expect(deleteDatabase).toHaveBeenCalledWith(IDB_NAME)
  })
})
