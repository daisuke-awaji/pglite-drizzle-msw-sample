import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TransferList } from './transfer-list'

const agent = createAgent()

const members = [
  { id: '1', label: '相沢 愛子' },
  { id: '2', label: '馬場 文太' },
  { id: '3', label: '千葉 千夏' },
  { id: '4', label: '土井 大輔' },
]

function Harness({ onChange }: { onChange?: (value: string[], source: string) => void }) {
  const [value, setValue] = useState(['1', '3'])
  return (
    <TransferList
      label="メンバーの割り当て"
      availableLabel="未割り当て"
      assignedLabel="割り当て済み"
      itemLabel="人"
      items={members}
      value={value}
      onValueChange={(next, details) => {
        onChange?.(next, details.source)
        setValue(next)
      }}
    />
  )
}

const list = (name: RegExp) => screen.getByRole('listbox', { name })
const options = (name: RegExp) => [...list(name).querySelectorAll('[role=option]')].map((o) => o.textContent)

describe('TransferList', () => {
  test('Tab で各リストに 1 回だけ入り、矢印で移動し、Space で選び、ボタンで移す', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.tab()
    expect(document.activeElement?.textContent).toBe('馬場 文太')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toBe('土井 大輔')
    await user.keyboard('{Home}')
    expect(document.activeElement?.textContent).toBe('馬場 文太')

    await user.keyboard(' ')
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowDown} ')
    const assign = screen.getByRole('button', { name: '割り当てる' })
    expect(assign.getAttribute('aria-disabled')).toBeNull()
    await user.click(assign)

    expect(options(/割り当て済み/)).toEqual(['相沢 愛子', '馬場 文太', '千葉 千夏', '土井 大輔'])
    expect(options(/未割り当て/)).toEqual([])
    await waitFor(() => expect(document.querySelector('[aria-live]')?.textContent).toBe('2 人を割り当てました'))
    expect(onChange).toHaveBeenLastCalledWith(['1', '2', '3', '4'], expect.any(String))
    // 移動元が空になったので、移動先の最初の項目へフォーカスが移る
    expect(document.activeElement?.textContent).toBe('馬場 文太')
    expect(document.activeElement?.closest('[role=listbox]')).toBe(list(/割り当て済み/))
  })

  test('Enter で移すと、移動元に残った最も近い項目へフォーカスが戻る', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.tab()
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement?.textContent).toBe('相沢 愛子')
    await user.keyboard('{Enter}')
    expect(options(/割り当て済み/)).toEqual(['千葉 千夏'])
    expect(document.activeElement?.textContent).toBe('千葉 千夏')
  })

  test('エージェントは名前で assign / unassign でき、宣言していない操作は断られる', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const entry = agent.snapshot().find((e) => e.component === 'transfer-list' && !e.offPage)
    expect(entry).toMatchObject({ label: 'メンバーの割り当て', actions: ['assign', 'unassign'] })
    for (const item of agent.snapshot().filter((e) => !e.offPage && e.component !== 'more')) {
      expect(item.label, `${item.component} ${item.ref} has no name`).toBeTruthy()
    }

    let result!: Awaited<ReturnType<typeof agent.act>>
    await act(async () => {
      result = await agent.act({
        steps: [
          { ref: 'メンバーの割り当て', action: 'assign', args: [['土井 大輔']] },
          { ref: 'メンバーの割り当て', action: 'unassign', args: [['相沢 愛子']] },
        ],
      })
    })
    expect(result.ok, result.error?.message).toBe(true)
    expect(options(/割り当て済み/)).toEqual(['千葉 千夏', '土井 大輔'])
    expect(onChange).toHaveBeenCalledWith(['1', '3', '4'], 'agent')

    const refused = await agent.act({ steps: [{ ref: 'メンバーの割り当て', action: 'setValue', args: [['2']] }] })
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toMatch(/assign, unassign/)
  })
})
