import { Button } from '@ui-sdk/react/button'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { Link, redirect, useFetcher, useLoaderData, type Params } from 'react-router'
import { api } from '../api/client'
import { confirmDanger } from '../components/confirm-danger'
import { ColorDot, DateTime, MemberAvatar } from '../components/display'
import { DateField, MultiComboboxField, SelectField, TextareaField, TextField } from '../components/fields'
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, TASK_STATUSES } from '../shared/enums'
import { commentInput, taskPatch } from '../shared/schemas'
import type { Comment, TaskDetail } from '../shared/types'
import { useFocusAfterRemoval } from '../lib/focus-after-removal'
import { useUnsavedChanges } from '../lib/use-unsaved-changes'
import { errorsFor, idParam, intentOf, load, run, unknownIntent, validate, type ActionResult } from './lib'

export const handle = {
  crumb: (data: unknown) => {
    const d = data as Awaited<ReturnType<typeof loader>> | undefined
    if (!d) return undefined
    return [
      { label: 'プロジェクト', to: '/projects' },
      { label: d.task.project.name, to: `/projects/${d.task.project.id}/tasks` },
      { label: d.task.title },
    ]
  },
}

export async function loader({ params, request }: { params: Params; request: Request }) {
  const [task, tags] = await Promise.all([
    load(api.getTask(idParam(params, 'taskId'), request.signal)),
    load(api.listTags(request.signal)),
  ])
  return { task, tags }
}

export async function action({ params, request }: { params: Params; request: Request }) {
  const id = idParam(params, 'taskId')
  const form = await request.formData()
  const intent = intentOf(form)
  switch (intent) {
    case 'save':
    case 'update': {
      const v = validate(intent, taskPatch, form, ['tagIds'])
      if (!v.ok) return v.result
      return run(intent, () => api.updateTask(id, v.value), intent === 'save' ? '保存しました' : undefined)
    }
    case 'delete': {
      const projectId = Number(form.get('projectId'))
      const result = await run(intent, () => api.deleteTask(id), 'タスクを削除しました')
      return 'ok' in result && result.ok ? redirect(`/projects/${projectId}/tasks`) : result
    }
    case 'comment': {
      const v = validate(intent, commentInput, form)
      if (!v.ok) return v.result
      return run(intent, () => api.addComment(id, v.value), 'コメントしました')
    }
    case 'delete-comment':
      return run(intent, () => api.deleteComment(Number(form.get('commentId'))), 'コメントを削除しました')
    default:
      return unknownIntent(intent)
  }
}

export function Component() {
  const { task } = useLoaderData<typeof loader>()
  return (
    <div className="page">
      <h1 className="sr-only">{task.title}</h1>
      {/* 狭い画面では「本文 → 属性 → コメント」の順に並べる（CSS の grid-template-areas） */}
      <div className="detail">
        <div className="detail-main">
          <TaskForm key={task.id} task={task} />
        </div>
        <aside className="detail-side card" aria-label="タスクの属性">
          <Properties task={task} />
        </aside>
        <div className="detail-comments">
          <Comments task={task} />
        </div>
      </div>
    </div>
  )
}

// 明示的に保存するフォーム（タイトルと説明）。保存前に画面を離れようとしたら確認する
function TaskForm({ task }: { task: TaskDetail }) {
  const fetcher = useFetcher<ActionResult>()
  const errors = errorsFor(fetcher.data, 'save')
  const [dirty, setDirty] = useState(false)
  useUnsavedChanges(dirty && fetcher.state === 'idle')

  // 保存できたら「変更なし」に戻す
  const saved = fetcher.state === 'idle' && fetcher.data?.ok === true && fetcher.data.intent === 'save'
  const [lastSaved, setLastSaved] = useState(fetcher.data)
  if (saved && fetcher.data !== lastSaved) {
    setLastSaved(fetcher.data)
    setDirty(false)
  }

  return (
    <fetcher.Form
      method="post"
      className="form"
      noValidate
      onChange={(e) => {
        const form = new FormData(e.currentTarget)
        setDirty(form.get('title') !== task.title || form.get('description') !== task.description)
      }}
    >
      <input type="hidden" name="intent" value="save" />
      <TextField label="タイトル" name="title" defaultValue={task.title} required errors={errors.title} className="title-input" />
      <TextareaField label="説明" name="description" defaultValue={task.description} errors={errors.description} rows={6} />
      <div className="form-actions">
        <Button type="submit" data-variant="solid" disabled={fetcher.state !== 'idle'} focusableWhenDisabled>
          保存
        </Button>
      </div>
    </fetcher.Form>
  )
}

const statusItems = TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))
const priorityItems = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))

// 変えたらすぐ保存する項目。項目ごとに fetcher を分け、送信中はその値を先に見せる
function useField(task: TaskDetail, field: string) {
  const fetcher = useFetcher<ActionResult>({ key: `task-${task.id}-${field}` })
  const submit = (values: string | string[] | null) => {
    const form = new FormData()
    form.set('intent', 'update')
    const list = Array.isArray(values) ? values : [values ?? '']
    for (const v of list.length > 0 ? list : ['']) form.append(field, v)
    fetcher.submit(form, { method: 'post' })
  }
  return { fetcher, pending: fetcher.formData, submit, errors: errorsFor(fetcher.data, 'update')[field] }
}

function Properties({ task }: { task: TaskDetail }) {
  const { tags } = useLoaderData<typeof loader>()
  const status = useField(task, 'status')
  const priority = useField(task, 'priority')
  const assignee = useField(task, 'assigneeId')
  const due = useField(task, 'dueDate')
  const tagField = useField(task, 'tagIds')
  const deleter = useFetcher<ActionResult>()

  const remove = async () => {
    const ok = await confirmDanger({
      title: `「${task.title}」を削除しますか？`,
      description: `タスク「${task.title}」と、そのコメント ${task.comments.length} 件を削除します。`,
      confirmLabel: 'タスクを削除',
    })
    if (ok) deleter.submit({ intent: 'delete', projectId: String(task.project.id) }, { method: 'post' })
  }

  return (
    <div className="form">
      <p className="side-project">
        <ColorDot color={task.project.color} />
        <Link to={`/projects/${task.project.id}/tasks`}>{task.project.name}</Link>
      </p>
      <SelectField
        label="ステータス"
        name="status"
        items={statusItems}
        value={(status.pending?.get('status') as string | null) ?? task.status}
        onValueChange={(v) => v && status.submit(String(v))}
        errors={status.errors}
      />
      <SelectField
        label="優先度"
        name="priority"
        items={priorityItems}
        value={(priority.pending?.get('priority') as string | null) ?? task.priority}
        onValueChange={(v) => v && priority.submit(String(v))}
        errors={priority.errors}
      />
      <SelectField
        label="担当者"
        name="assigneeId"
        items={[{ value: 'none', label: '未割り当て' }, ...task.project.members.map((m) => ({ value: String(m.id), label: m.name }))]}
        value={(assignee.pending?.get('assigneeId') as string | null) || (task.assignee ? String(task.assignee.id) : 'none')}
        onValueChange={(v) => v && assignee.submit(String(v))}
        errors={assignee.errors}
      />
      <DateField
        label="期限"
        name="dueDate"
        value={due.pending ? (due.pending.get('dueDate') as string) || null : task.dueDate}
        onValueChange={(v) => due.submit((v as string | null) ?? '')}
        errors={due.errors}
      />
      <MultiComboboxField
        label="タグ"
        name="tagIds"
        placeholder="タグを追加…"
        items={tags.map((t) => ({ value: String(t.id), label: t.name }))}
        value={
          tagField.pending
            ? tagField.pending.getAll('tagIds').map(String).filter(Boolean)
            : task.tags.map((t) => String(t.id))
        }
        onValueChange={(v) => tagField.submit(v as string[])}
        errors={tagField.errors}
      />
      <dl className="meta">
        <div>
          <dt>作成</dt>
          <dd>
            <DateTime value={task.createdAt} />
          </dd>
        </div>
        <div>
          <dt>更新</dt>
          <dd>
            <DateTime value={task.updatedAt} />
          </dd>
        </div>
      </dl>
      <Button data-variant="destructive" onClick={remove}>
        <Trash2Icon aria-hidden="true" />
        タスクを削除
      </Button>
    </div>
  )
}

function Comments({ task }: { task: TaskDetail }) {
  const fetcher = useFetcher<ActionResult>()
  const errors = errorsFor(fetcher.data, 'comment')
  const authors = task.project.members.map((m) => ({ value: String(m.id), label: m.name }))
  // 投稿が終わったらフォームを空にする（key を変えて作り直す）
  const formKey = task.comments.length

  return (
    <section className="comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading">
        コメント <span className="muted tabular">{task.comments.length}</span>
      </h2>
      <ol className="comment-list">
        {task.comments.map((c) => (
          <CommentItem key={c.id} comment={c} />
        ))}
      </ol>
      {authors.length === 0 ? (
        <p className="muted">プロジェクトにメンバーがいないため、コメントできません。</p>
      ) : (
        <fetcher.Form method="post" className="form card" key={formKey} noValidate>
          <input type="hidden" name="intent" value="comment" />
          <TextareaField label="コメント" name="body" required errors={errors.body} rows={3} />
          <div className="comment-form-foot">
            <SelectField label="投稿者" name="authorId" items={authors} defaultValue={authors[0]!.value} errors={errors.authorId} />
            <Button type="submit" data-variant="solid" disabled={fetcher.state !== 'idle'} focusableWhenDisabled>
              コメントする
            </Button>
          </div>
        </fetcher.Form>
      )}
    </section>
  )
}

function CommentItem({ comment }: { comment: Comment }) {
  const fetcher = useFetcher<ActionResult>()
  const { ref: rowRef, plan: planFocus } = useFocusAfterRemoval<HTMLLIElement>()
  if (fetcher.state !== 'idle') return null
  const author = comment.author?.name ?? '削除されたメンバー'
  return (
    <li ref={rowRef} className="comment">
      {comment.author ? <MemberAvatar member={comment.author} /> : <span className="avatar avatar-ghost" aria-hidden="true" />}
      <div className="comment-body">
        <p className="comment-head">
          <strong>{author}</strong>
          <span className="muted small">
            <DateTime value={comment.createdAt} />
          </span>
        </p>
        <p className="pre-wrap">{comment.body}</p>
      </div>
      <Button
        data-variant="ghost"
        aria-label={`${author}のコメント（${new Date(comment.createdAt).toLocaleString('ja-JP')}）を削除`}
        data-row-focus
        onClick={() => {
          planFocus()()
          void fetcher.submit({ intent: 'delete-comment', commentId: String(comment.id) }, { method: 'post' })
        }}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
    </li>
  )
}
