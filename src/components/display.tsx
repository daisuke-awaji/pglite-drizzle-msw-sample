import { Avatar, AvatarFallback } from '@ui-sdk/react/avatar'
import { Progress, ProgressIndicator, ProgressTrack } from '@ui-sdk/react/progress'
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { today } from '../shared/dates'
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  type Priority,
  type ProjectColor,
  type TaskStatus,
} from '../shared/enums'
import type { MemberRef } from '../shared/types'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  )
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon aria-hidden="true" />
      <p>{title}</p>
      {children}
    </div>
  )
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)

const hue = (id: number) => (id * 47) % 360

// 名前を横に書くときは装飾なので読み上げない。アバターだけのときは role="img" で名前を付ける
export function MemberAvatar({ member, labelled = false }: { member: MemberRef; labelled?: boolean }) {
  const a11y = labelled ? { role: 'img', 'aria-label': member.name } : { 'aria-hidden': true }
  return (
    <Avatar className="avatar" style={{ '--avatar-hue': hue(member.id) } as React.CSSProperties} {...a11y}>
      <AvatarFallback>{initials(member.name)}</AvatarFallback>
    </Avatar>
  )
}

export function AvatarStack({ members, max = 4 }: { members: MemberRef[]; max?: number }) {
  const shown = members.slice(0, max)
  const rest = members.length - shown.length
  return (
    <div className="avatar-stack" role="img" aria-label={`メンバー ${members.length} 人: ${members.map((m) => m.name).join('、')}`}>
      {shown.map((m) => (
        <MemberAvatar key={m.id} member={m} />
      ))}
      {rest > 0 && <span className="avatar avatar-more" aria-hidden="true">+{rest}</span>}
    </div>
  )
}

export function Assignee({ member }: { member: MemberRef | null }) {
  if (!member) return <span className="muted">未割り当て</span>
  return (
    <span className="assignee">
      <MemberAvatar member={member} />
      {member.name}
    </span>
  )
}

const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  todo: CircleDashedIcon,
  in_progress: CircleDotIcon,
  done: CircleCheckIcon,
}

export function StatusLabel({ status }: { status: TaskStatus }) {
  const Icon = STATUS_ICON[status]
  return (
    <span className="status" data-status={status}>
      <Icon aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}

const PRIORITY_ICON: Record<Priority, LucideIcon> = {
  low: SignalLowIcon,
  medium: SignalMediumIcon,
  high: SignalHighIcon,
}

export function PriorityLabel({ priority }: { priority: Priority }) {
  const Icon = PRIORITY_ICON[priority]
  return (
    <span className="priority" data-priority={priority}>
      <Icon aria-hidden="true" />
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

export function ColorDot({ color }: { color: ProjectColor }) {
  return <span className="color-dot" data-color={color} aria-hidden="true" />
}

const dateFormat = new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' })
const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })

export function DueDate({ date, done = false }: { date: string | null; done?: boolean }) {
  if (!date) return <span className="muted">—</span>
  const t = today()
  const state = done ? undefined : date < t ? 'overdue' : date === t ? 'today' : undefined
  return (
    <time className="due" dateTime={date} data-state={state}>
      {dateFormat.format(new Date(`${date}T00:00:00`))}
      {state === 'overdue' && <span className="sr-only">（期限切れ）</span>}
      {state === 'today' && <span className="sr-only">（今日まで）</span>}
    </time>
  )
}

export function DateTime({ value }: { value: string }) {
  return <time dateTime={value}>{dateTimeFormat.format(new Date(value))}</time>
}

export function ProgressBar({ label, done, total }: { label: string; done: number; total: number }) {
  const value = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <Progress value={value} aria-label={label} className="progress">
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </Progress>
  )
}
