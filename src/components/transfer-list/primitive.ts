import {
  announce,
  createChange,
  createFocusRecovery,
  createRovingFocus,
  createSelection,
  definePrimitive,
  type ChangeDetails,
} from '@ui-sdk/core'

// UI SDK に無い「トランスファーリスト」を behavior から組み立てた primitive。
// - 左右のリストはそれぞれ Tab で 1 回だけ止まり、上下の矢印・Home・End で移動する（createRovingFocus）
// - Space で選択を切り替え（複数可）、Enter で選択中（なければフォーカス中）の項目を反対側へ移す
// - 移動後は移動元に残った最も近い項目へ、なければ移動先へフォーカスを移す（createFocusRecovery）
// - 移動した件数を読み上げる（announce）。値は親が持つ（value / onValueChange）
// - エージェントは assign / unassign を名前か id で呼べる（agent キー）

export type TransferItem = { id: string; label: string }
export type Side = 'available' | 'assigned'
// "assign" と "unassign" は共通の reason 語彙にないので独自に宣言する
export type TransferReason = 'assign' | 'unassign'

export type TransferListOptions = {
  items?: TransferItem[]
  value?: string[]
  defaultValue?: string[]
  onValueChange?: (value: string[], details: ChangeDetails<TransferReason>) => void
  itemLabel?: string
}

type State = {
  items: TransferItem[]
  value: string[]
  selected: string[]
  focusedAvailable: string | null
  focusedAssigned: string | null
}

type OptionProps = { value: string }
type SelectionReason = 'item-press' | 'list-navigation'

const optionSlot = { available: 'availableOption', assigned: 'assignedOption' } as const
const focusKey = { available: 'focusedAvailable', assigned: 'focusedAssigned' } as const
const other = (side: Side): Side => (side === 'available' ? 'assigned' : 'available')

export function listOf(state: Pick<State, 'items' | 'value'>, side: Side): TransferItem[] {
  const assigned = new Set(state.value)
  return state.items.filter((item) => assigned.has(item.id) === (side === 'assigned'))
}

const selectedOn = (state: State, side: Side) => {
  const ids = new Set(listOf(state, side).map((i) => i.id))
  return state.selected.filter((id) => ids.has(id))
}

// 移動元に残った項目のうち、外れた項目に最も近いもの（後ろを優先）
function nearest(order: string[], keep: (id: string) => boolean, from: string): string | undefined {
  const at = order.indexOf(from)
  return order.slice(at + 1).find(keep) ?? order.slice(0, Math.max(at, 0)).reverse().find(keep)
}

export const transferList = definePrimitive({
  name: 'transfer-list',
  options: {
    items: 'value',
    value: 'list',
    defaultValue: 'list',
    onValueChange: 'callback',
    itemLabel: 'string',
  },
  controlled: ['value'],
  state: (options: TransferListOptions): State => ({
    items: options.items ?? [],
    value: options.value ?? options.defaultValue ?? [],
    selected: [],
    focusedAvailable: null,
    focusedAssigned: null,
  }),
  sync: (options) => ({
    ...(options.items ? { items: options.items } : {}),
    ...(options.value ? { value: options.value } : {}),
  }),
  api: (context) => {
    const { store } = context
    const change = createChange(context)
    const selection = createSelection<TransferListOptions, State, 'selected', SelectionReason>(context, {
      key: 'selected',
      set: (selected) => (store.set({ selected }), true),
      order: () => store.get().items.map((i) => i.id),
      multiple: () => true,
    })

    const block = (side: Side) => ({
      roving: createRovingFocus<State, OptionProps>(context, { slot: optionSlot[side], key: focusKey[side] }),
      recovery: createFocusRecovery<OptionProps>({
        fallback: (lost) => {
          const state = store.get()
          const ids = listOf(state, side).map((i) => i.id)
          const next = nearest(state.items.map((i) => i.id), (id) => ids.includes(id), lost.key)
          return next ? context.element(optionSlot[side], next) : undefined
        },
      }),
    })
    const blocks = { available: block('available'), assigned: block('assigned') }

    // value を親が持つとき、変更が props で戻るまでの間に次の move が来ることがある
    // （エージェントが 1 回の act で assign と unassign を続けて呼ぶなど）。新しい value が届くまでは直前に求めた値を基準にする
    let requested: string[] | null = null
    let valueOption = context.options().value
    context.onOptions((options) => {
      if (options.value === valueOption) return
      valueOption = options.value
      requested = null
    })
    const currentValue = () => requested ?? store.get().value

    // 名前でも id でも受け取る（エージェントは画面に見えている名前で指示しがちなので）
    const resolve = (names: string[]) => {
      const { items } = store.get()
      return names
        .map((r) => items.find((i) => i.id === r) ?? items.find((i) => i.label === r))
        .filter((i): i is TransferItem => i !== undefined)
        .map((i) => i.id)
    }

    const move = (to: Side, wanted: string[] | undefined, event?: Event) => {
      const state = { ...store.get(), value: currentValue() }
      const from = other(to)
      const pool = listOf(state, from).map((i) => i.id)
      const focused = state[focusKey[from]]
      const picked = wanted
        ? resolve(wanted)
        : selectedOn(state, from).length > 0
          ? selectedOn(state, from)
          : focused && pool.includes(focused) && event instanceof KeyboardEvent
            ? [focused]
            : []
      const ids = picked.filter((id) => pool.includes(id))
      if (ids.length === 0) return false

      const moved = new Set(ids)
      const value = to === 'assigned' ? [...state.value, ...ids] : state.value.filter((id) => !moved.has(id))
      const order = state.items.map((i) => i.id)
      const sorted = order.filter((id) => value.includes(id))
      if (!change('value', sorted, { reason: to === 'assigned' ? 'assign' : 'unassign', event })) return false
      if (context.options().value) requested = sorted

      store.set({ selected: state.selected.filter((id) => !moved.has(id)) })
      const noun = context.options().itemLabel ?? '件'
      announce(to === 'assigned' ? `${ids.length} ${noun}を割り当てました` : `${ids.length} ${noun}を外しました`)

      const stay = nearest(order, (id) => pool.includes(id) && !moved.has(id), ids[0]!)
      if (stay) blocks[from].roving.focus(stay)
      else blocks[to].roving.focus(ids[0])
      return true
    }

    return {
      selection,
      blocks,
      move,
      assign: (ids?: string[], event?: Event) => move('assigned', ids, event),
      unassign: (ids?: string[], event?: Event) => move('available', ids, event),
      items: () => store.get().items.map((item) => ({ value: item.id, label: item.label })),
    }
  },
  slots: (slot) => {
    const list = (side: Side) =>
      slot({
        role: 'listbox',
        keys: { none: '各項目が矢印キーを処理する（roving focus）' },
        attrs: (state) => ({
          'aria-multiselectable': 'true',
          'data-empty': listOf(state, side).length === 0 ? '' : undefined,
        }),
      })

    const option = (side: Side) =>
      slot<OptionProps>({
        role: 'option',
        focus: 'roving',
        props: { value: 'string' },
        attrs: (state, part) => ({
          tabindex: part.api.blocks[side].roving.tabIndex(state, part),
          'aria-selected': String(state.selected.includes(part.key)),
          'data-selected': state.selected.includes(part.key) ? '' : undefined,
        }),
        press: ({ api, key }, event) => api.selection.toggle(key, { reason: 'item-press', event }),
        on: {
          keydown: (event, { api, el, key }) => {
            const e = event as KeyboardEvent
            if (e.key === ' ') {
              e.preventDefault()
              api.selection.toggle(key, { reason: 'item-press', event: e })
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              api.move(other(side), undefined, e)
              return
            }
            if (el) api.blocks[side].roving.keydown(e, el)
          },
        },
        bind: (el, part) => {
          const cleanups = [part.api.blocks[side].roving.bind(el, part), part.api.blocks[side].recovery.bind(el, part)]
          return () => cleanups.forEach((c) => c())
        },
      })

    // 選択がないときは押せないが、フォーカスは保つ（disabled だとフォーカスが外れる）
    const mover = (to: Side) =>
      slot({
        attrs: (state) => {
          const none = selectedOn(state, other(to)).length === 0
          return { type: 'button', 'aria-disabled': none ? 'true' : undefined, 'data-disabled': none ? '' : undefined }
        },
        press: ({ api }, event) => {
          api.move(to, undefined, event)
        },
      })

    return {
      root: slot({ role: 'group' }),
      available: list('available'),
      availableOption: option('available'),
      assigned: list('assigned'),
      assignedOption: option('assigned'),
      assign: mover('assigned'),
      unassign: mover('available'),
    }
  },
  agent: { actions: ['assign', 'unassign'], items: (api) => api.items() },
})
