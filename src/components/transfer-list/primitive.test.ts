import { checkServer, mount } from '@ui-sdk/core/testing'
import { describe, expect, test } from 'vitest'
import { transferList } from './primitive'

const items = [
  { id: 'a', label: '相沢' },
  { id: 'b', label: '馬場' },
  { id: 'c', label: '千葉' },
  { id: 'd', label: '土井' },
]

// キーボードとフォーカスの振る舞いは transfer-list.test.tsx（React で描画）で確かめる。
// mount のマークアップはタグ名が小文字になるため、availableOption のような名前の slot を置けない
const markup = `<root aria-label="割り当て">
  <available></available>
  <assign>割り当てる</assign>
  <unassign>外す</unassign>
  <assigned></assigned>
</root>`

const setup = () => mount(transferList, { items, defaultValue: ['a', 'c'], itemLabel: '人' }, markup)

test('選択がないときは移動ボタンが aria-disabled（フォーカスは保てる）', () => {
  const view = setup()
  try {
    expect(view.part('assign')!.getAttribute('aria-disabled')).toBe('true')
    expect(view.part('assign')!.hasAttribute('disabled')).toBe(false)
  } finally {
    view.unmount()
  }
})

describe('transfer-list primitive', () => {
  test('api.assign は id でも名前でも受け取り、反対側にあるものは無視する', async () => {
    const view = setup()
    try {
      expect(view.api.assign(['馬場', 'a', 'zzz'])).toBe(true)
      expect(view.state.value).toEqual(['a', 'b', 'c'])
      expect(view.api.unassign(['土井'])).toBe(false)
    } finally {
      view.unmount()
    }
  })

  test('onValueChange で cancel すると値は変わらない', async () => {
    const view = mount(
      transferList,
      { items, defaultValue: ['a'], onValueChange: (_v, details) => details.cancel() },
      markup,
    )
    try {
      expect(view.api.assign(['b'])).toBe(false)
      expect(view.state.value).toEqual(['a'])
    } finally {
      view.unmount()
    }
  })

  test('サーバーでも描画できる', () => {
    checkServer(transferList, { items, defaultValue: ['a', 'c'] }, markup)
  })
})
