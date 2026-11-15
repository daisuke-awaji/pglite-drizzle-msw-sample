import { AlertTriangleIcon, CalendarClockIcon, CircleDotIcon, FolderKanbanIcon, UsersIcon } from 'lucide-react'
import { Link, useLoaderData } from 'react-router'
import { api } from '../api/client'
import { Assignee, ColorDot, DueDate, EmptyState, PageHeader, ProgressBar, StatusLabel } from '../components/display'
import { today } from '../shared/dates'
import { STATUS_LABEL, TASK_STATUSES } from '../shared/enums'
import { load } from './lib'

export async function loader({ request }: { request: Request }) {
  return load(api.dashboard(today(), request.signal))
}

export function Component() {
  const d = useLoaderData<typeof loader>()
  const total = TASK_STATUSES.reduce((n, s) => n + d.byStatus[s], 0)

  return (
    <div className="page">
      <PageHeader title="ダッシュボード" />

      <section className="metrics" aria-label="概要">
        <Metric icon={FolderKanbanIcon} label="進行中のプロジェクト" value={d.counts.projects} to="/projects" />
        <Metric icon={CircleDotIcon} label="未完了のタスク" value={d.counts.openTasks} />
        <Metric icon={AlertTriangleIcon} label="期限切れ" value={d.counts.overdue} tone={d.counts.overdue > 0 ? 'danger' : undefined} />
        <Metric icon={UsersIcon} label="メンバー" value={d.counts.members} to="/members" />
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>プロジェクトの進み具合</h2>
          <ul className="progress-list">
            {d.projects.map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="progress-name">
                  <ColorDot color={p.color} />
                  {p.name}
                </Link>
                <ProgressBar label={`${p.name}の進み具合`} done={p.doneCount} total={p.taskCount} />
                <span className="muted tabular">
                  {p.doneCount}/{p.taskCount}
                </span>
              </li>
            ))}
          </ul>
          <div className="status-bar" role="img" aria-label={TASK_STATUSES.map((s) => `${STATUS_LABEL[s]} ${d.byStatus[s]} 件`).join('、')}>
            {TASK_STATUSES.map((s) => (
              <span key={s} data-status={s} style={{ flexGrow: d.byStatus[s] }} title={`${STATUS_LABEL[s]} ${d.byStatus[s]}`} />
            ))}
          </div>
          <ul className="legend" aria-hidden="true">
            {TASK_STATUSES.map((s) => (
              <li key={s}>
                <StatusLabel status={s} /> <span className="tabular">{d.byStatus[s]}</span>
              </li>
            ))}
            <li className="muted">合計 {total}</li>
          </ul>
        </section>

        <section className="card">
          <h2>期限が近いタスク</h2>
          {d.upcoming.length === 0 ? (
            <EmptyState icon={CalendarClockIcon} title="期限の近いタスクはありません" />
          ) : (
            <ul className="task-mini-list">
              {d.upcoming.map((t) => (
                <li key={t.id}>
                  <DueDate date={t.dueDate} />
                  <div>
                    <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                    <p className="muted small">{t.project.name}</p>
                  </div>
                  <Assignee member={t.assignee} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  to,
  tone,
}: {
  icon: typeof UsersIcon
  label: string
  value: number
  to?: string
  tone?: 'danger'
}) {
  const body = (
    <>
      <span className="metric-label">
        <Icon aria-hidden="true" />
        {label}
      </span>
      <span className="metric-value tabular">{value}</span>
    </>
  )
  return to ? (
    <Link to={to} className="metric" data-tone={tone}>
      {body}
    </Link>
  ) : (
    <div className="metric" data-tone={tone}>
      {body}
    </div>
  )
}
