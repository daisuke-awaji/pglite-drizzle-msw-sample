import { Button } from '@ui-sdk/react/button'
import { SlidersHorizontalIcon } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

// 絞り込みの並び。広い画面では常に見せ、狭い画面では「絞り込み」ボタンで開閉する（縦の場所を取りすぎないように）
export function FilterPanel({ activeCount, children }: { activeCount: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <Button className="filters-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontalIcon aria-hidden="true" />
        絞り込み
        {activeCount > 0 && (
          <span className="badge tabular">
            {activeCount}
            <span className="sr-only">件の条件</span>
          </span>
        )}
      </Button>
      <div id={id} className="filters" data-open={open ? '' : undefined}>
        {children}
      </div>
    </>
  )
}
