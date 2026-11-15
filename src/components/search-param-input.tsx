import { Input } from '@ui-sdk/react/input'
import { SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

// 入力をそのまま URL（?q=）に書き戻す検索欄。URL が正なので、リロードや共有をしても同じ結果になる
export function SearchParamInput({ label, param = 'q', placeholder }: { label: string; param?: string; placeholder?: string }) {
  const [params, setParams] = useSearchParams()
  const fromUrl = params.get(param) ?? ''
  const [value, setValue] = useState(fromUrl)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // 戻る・進むで URL が変わったら入力欄も合わせる
  const [lastUrl, setLastUrl] = useState(fromUrl)
  if (fromUrl !== lastUrl) {
    setLastUrl(fromUrl)
    setValue(fromUrl)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <div className="search-input">
      <SearchIcon aria-hidden="true" />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onValueChange={(next) => {
          setValue(next)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            setParams(
              (prev) => {
                const p = new URLSearchParams(prev)
                if (next) p.set(param, next)
                else p.delete(param)
                p.delete('page')
                return p
              },
              { replace: true },
            )
          }, 250)
        }}
      />
    </div>
  )
}
