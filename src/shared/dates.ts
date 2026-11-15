// 期限などの「日付」は時刻もタイムゾーンも持たない YYYY-MM-DD の文字列で扱う（UI SDK の DatePicker と同じ形）
const pad = (n: number) => String(n).padStart(2, '0')

export function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function addDays(date: Date, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return toDateString(d)
}

export const today = () => toDateString(new Date())
