import { createParts } from '@ui-sdk/react/primitive'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { listOf, transferList, type TransferItem, type TransferListOptions } from './primitive'

const parts = createParts(transferList, {
  root: 'div',
  available: 'ul',
  availableOption: 'li',
  assigned: 'ul',
  assignedOption: 'li',
  assign: 'button',
  unassign: 'button',
})

type Props = {
  label: string
  items: TransferItem[]
  value: string[]
  onValueChange: NonNullable<TransferListOptions['onValueChange']>
  availableLabel: string
  assignedLabel: string
  itemLabel?: string
  renderItem?: (item: TransferItem) => ReactNode
}

export function TransferList({
  label,
  items,
  value,
  onValueChange,
  availableLabel,
  assignedLabel,
  itemLabel,
  renderItem = (item) => item.label,
}: Props) {
  const id = useId()
  const available = listOf({ items, value }, 'available')
  const assigned = listOf({ items, value }, 'assigned')

  return (
    <parts.Root aria-label={label} items={items} value={value} onValueChange={onValueChange} itemLabel={itemLabel} className="transfer">
      <div className="transfer-pane">
        <h3 id={`${id}-available`}>
          {availableLabel}
          <span className="muted tabular">{available.length}</span>
        </h3>
        <parts.Available aria-labelledby={`${id}-available`} className="transfer-list">
          {available.map((item) => (
            <parts.AvailableOption key={item.id} value={item.id}>
              {renderItem(item)}
            </parts.AvailableOption>
          ))}
        </parts.Available>
      </div>
      <div className="transfer-actions">
        <parts.Assign>
          割り当てる
          <ChevronRightIcon aria-hidden="true" />
        </parts.Assign>
        <parts.Unassign>
          <ChevronLeftIcon aria-hidden="true" />
          外す
        </parts.Unassign>
      </div>
      <div className="transfer-pane">
        <h3 id={`${id}-assigned`}>
          {assignedLabel}
          <span className="muted tabular">{assigned.length}</span>
        </h3>
        <parts.Assigned aria-labelledby={`${id}-assigned`} className="transfer-list">
          {assigned.map((item) => (
            <parts.AssignedOption key={item.id} value={item.id}>
              {renderItem(item)}
            </parts.AssignedOption>
          ))}
        </parts.Assigned>
      </div>
    </parts.Root>
  )
}
