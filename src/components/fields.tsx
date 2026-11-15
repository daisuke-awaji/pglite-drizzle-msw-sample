import {
  Combobox,
  type ComboboxProps,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@ui-sdk/react/combobox'
import { DatePicker, DatePickerClear, DatePickerInput, DatePickerTrigger } from '@ui-sdk/react/date-picker'
import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field'
import { Input } from '@ui-sdk/react/input'
import {
  Select,
  type SelectProps,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select'
import { Textarea } from '@ui-sdk/react/textarea'
import { CalendarIcon, CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

// Field + Label + コントロール + エラー表示をひとまとめにした小さな部品。
// errors には Zod（サーバー層・action）が返した項目ごとのメッセージを渡す。

type Option = { value: string; label: string }

type BaseProps = {
  label: string
  name: string
  errors?: string[]
  description?: ReactNode
}

function FieldShell({ label, name, errors, description, children }: BaseProps & { children: ReactNode }) {
  return (
    <Field name={name} invalid={errors?.length ? true : undefined}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError>{(state) => errors?.[0] ?? state.message}</FieldError>
    </Field>
  )
}

export function TextField({
  label,
  name,
  errors,
  description,
  ...input
}: BaseProps & Omit<ComponentProps<typeof Input>, 'name'>) {
  return (
    <FieldShell label={label} name={name} errors={errors} description={description}>
      <Input name={name} {...input} />
    </FieldShell>
  )
}

export function TextareaField({
  label,
  name,
  errors,
  description,
  ...textarea
}: BaseProps & Omit<ComponentProps<typeof Textarea>, 'name'>) {
  return (
    <FieldShell label={label} name={name} errors={errors} description={description}>
      <Textarea name={name} {...textarea} />
    </FieldShell>
  )
}

export function SelectField({
  label,
  name,
  errors,
  description,
  items,
  placeholder,
  ...select
}: BaseProps & {
  items: Option[]
  placeholder?: string
  value?: string | null
  defaultValue?: string | null
  onValueChange?: (value: string | null) => void
  disabled?: boolean
  required?: boolean
}) {
  const props: SelectProps<string> = { name, items, ...select }
  return (
    <FieldShell label={label} name={name} errors={errors} description={description}>
      <Select {...props}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
          <ChevronDownIcon aria-hidden="true" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
              <SelectItemIndicator>
                <CheckIcon aria-hidden="true" />
              </SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  )
}

export function DateField({
  label,
  name,
  errors,
  description,
  ...picker
}: BaseProps & Omit<ComponentProps<typeof DatePicker>, 'name' | 'children'>) {
  return (
    <FieldShell label={label} name={name} errors={errors} description={description}>
      <DatePicker name={name} locale="ja-JP" {...picker}>
        <div className="date-row">
          <DatePickerInput />
          <DatePickerClear aria-label={`${label}を消す`} data-variant="ghost">
            <XIcon aria-hidden="true" />
          </DatePickerClear>
          <DatePickerTrigger aria-label={`${label}をカレンダーで選ぶ`} data-variant="ghost">
            <CalendarIcon aria-hidden="true" />
          </DatePickerTrigger>
        </div>
      </DatePicker>
    </FieldShell>
  )
}

export function MultiComboboxField({
  label,
  name,
  errors,
  description,
  items,
  placeholder,
  ...combobox
}: BaseProps & {
  items: Option[]
  placeholder?: string
  value?: string[]
  defaultValue?: string[]
  onValueChange?: (value: string[]) => void
  disabled?: boolean
}) {
  const labelOf = (value: unknown) => items.find((i) => i.value === value)?.label ?? String(value)
  const props: ComboboxProps<string, true> = { name, multiple: true, itemToLabel: labelOf, ...combobox }
  return (
    <FieldShell label={label} name={name} errors={errors} description={description}>
      <Combobox {...props}>
        <div className="chips-row">
          <ComboboxChips>
            <ComboboxValue>
              {(state) =>
                (state.value as string[]).map((value, index) => (
                  <ComboboxChip key={value} value={value}>
                    {state.labels[index]}
                    <ComboboxChipRemove aria-label={`${state.labels[index]}を外す`}>
                      <XIcon aria-hidden="true" />
                    </ComboboxChipRemove>
                  </ComboboxChip>
                ))
              }
            </ComboboxValue>
            <ComboboxInput placeholder={placeholder} />
          </ComboboxChips>
          <ComboboxTrigger aria-label={`${label}の候補を表示`} data-variant="ghost">
            <ChevronDownIcon aria-hidden="true" />
          </ComboboxTrigger>
        </div>
        <ComboboxContent>
          <ComboboxEmpty>見つかりません</ComboboxEmpty>
          <ComboboxList>
            {items.map((item) => (
              <ComboboxItem key={item.value} value={item.value} label={item.label}>
                {item.label}
                <ComboboxItemIndicator>
                  <CheckIcon aria-hidden="true" />
                </ComboboxItemIndicator>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </FieldShell>
  )
}
