import { Button } from '@ui-sdk/react/button'
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox'
import {
  createDialogController,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@ui-sdk/react/dialog'
import { Menu, MenuContent, MenuItem, MenuItemIcon, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu'
import {
  Pagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
} from '@ui-sdk/react/pagination'
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from '@ui-sdk/react/select'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  KanbanIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  Link,
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
  type Params,
} from 'react-router'
import { api } from '../api/client'
import { confirmDanger } from '../components/confirm-danger'
import { Assignee, DueDate, EmptyState, PriorityLabel, StatusLabel } from '../components/display'
import { DateField, MultiComboboxField, SelectField, TextareaField, TextField } from '../components/fields'
import { SearchParamInput } from '../components/search-param-input'
import {
  PRIORITIES,
  PRIORITY_LABEL,
  SORT_LABEL,
  STATUS_LABEL,
  TASK_SORTS,
  TASK_STATUSES,
  type TaskStatus,
} from '../shared/enums'
import { taskInput, taskPatch } from '../shared/schemas'
import type { ProjectDetail, TaskListItem } from '../shared/types'
import { hasDraft, useDrafts, useTaskDraft } from '../stores/drafts'
import { usePreferences } from '../stores/preferences'
import { errorsFor, idParam, intentOf, load, run, unknownIntent, validate, type ActionResult } from './lib'

export const handle = { crumb: () => 'タスク' }

// 絞り込み・並べ替え・ページは URL が持つ（共有・リロード・戻るで再現できる）。
// 表とボードの切り替えは端末ごとの好みなので Zustand（localStorage）が持つ。loader からも読める
export async function loader({ params, request }: { params: Params; request: Request }) {
  const projectId = idParam(params, 'projectId')
  const search = Object.fromEntries(new URL(request.url).searchParams)
  const board = usePreferences.getState().taskView === 'board'
  const [page, tags] = await Promise.all([
    load(api.listTasks(projectId, board ? { ...search, page: 1, pageSize: 100 } : search, request.signal)),
    load(api.listTags(request.signal)),
  ])
  return { page, tags }
}

const newTaskDialog = createDialogController()

export async function action({ params, request }: { params: Params; request: Request }) {
  const projectId = idParam(params, 'projectId')
  const form = await request.formData()
  const intent = intentOf(form)
  switch (intent) {
    case 'create': {
      const v = validate(intent, taskInput, form, ['tagIds'])
      if (!v.ok) return v.result
      const result = await run(intent, () => api.createTask(projectId, v.value), 'タスクを作成しました')
      // 作成できたら、下書き（sessionStorage）を消してダイアログを閉じる。ストアもダイアログも React の外から操作できる
      if ('ok' in result && result.ok) {
        useDrafts.getState().clearTask(projectId)
        newTaskDialog.close()
      }
      return result
    }
    case 'update': {
      const id = Number(form.get('id'))
      const v = validate(intent, taskPatch, form)
      if (!v.ok) return v.result
      return run(intent, () => api.updateTask(id, v.value))
    }
    case 'delete': {
      const id = Number(form.get('id'))
      return run(intent, () => api.deleteTask(id), 'タスクを削除しました')
    }
    default:
      return unknownIntent(intent)
  }
}

const STATUS_ICON = { todo: CircleDashedIcon, in_progress: CircleDotIcon, done: CircleCheckIcon }

export function Component() {
  const { page, tags } = useLoaderData<typeof loader>()
  const project = useRouteLoaderData('project') as ProjectDetail
  const view = usePreferences((s) => s.taskView)
  const setView = usePreferences((s) => s.setTaskView)
  const revalidator = useRevalidator()
  const filtered = [...new URLSearchParams(location.search).keys()].some((k) => k !== 'sort' && k !== 'page')

  return (
    <div className="stack">
      <div className="toolbar">
        <SearchParamInput label="タスクを検索" placeholder="タイトルで検索" />
        <ParamSelect
          label="状態で絞り込む"
          param="status"
          items={[{ value: '', label: 'すべてのステータス' }, ...TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        <ParamSelect
          label="担当で絞り込む"
          param="assignee"
          items={[
            { value: '', label: 'すべての担当者' },
            { value: 'none', label: '未割り当て' },
            ...project.members.map((m) => ({ value: String(m.id), label: m.name })),
          ]}
        />
        <ParamSelect
          label="タグで絞り込む"
          param="tag"
          items={[{ value: '', label: 'すべてのタグ' }, ...tags.map((t) => ({ value: String(t.id), label: t.name }))]}
        />
        <ParamSelect
          label="並び順"
          param="sort"
          items={TASK_SORTS.map((s) => ({ value: s === 'updated' ? '' : s, label: SORT_LABEL[s] }))}
        />
        <div className="toolbar-end">
          <SegmentedControl
            aria-label="表示形式"
            value={view}
            onValueChange={(next) => {
              if (!next) return
              setView(next as typeof view)
              revalidator.revalidate()
            }}
          >
            <SegmentedControlIndicator />
            <SegmentedControlItem value="table" aria-label="表">
              <TableIcon aria-hidden="true" />
            </SegmentedControlItem>
            <SegmentedControlItem value="board" aria-label="ボード">
              <KanbanIcon aria-hidden="true" />
            </SegmentedControlItem>
          </SegmentedControl>
          <NewTaskDialog project={project} tags={tags} />
        </div>
      </div>

      {page.total === 0 ? (
        <EmptyState icon={ListTodoIcon} title={filtered ? '条件に合うタスクはありません' : 'タスクはまだありません'} />
      ) : view === 'board' ? (
        <Board tasks={page.items} />
      ) : (
        <>
          <TaskTable tasks={page.items} />
          <div className="table-foot">
            <span className="muted small tabular">
              {page.total} 件中 {(page.page - 1) * page.pageSize + 1}–{Math.min(page.page * page.pageSize, page.total)} 件
            </span>
            <TaskPagination page={page.page} pageCount={page.pageCount} />
          </div>
        </>
      )}
    </div>
  )
}

function ParamSelect({ label, param, items }: { label: string; param: string; items: { value: string; label: string }[] }) {
  const [params, setParams] = useSearchParams()
  const value = params.get(param) ?? ''
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) =>
        setParams((prev) => {
          const p = new URLSearchParams(prev)
          if (next) p.set(param, String(next))
          else p.delete(param)
          p.delete('page')
          return p
        })
      }
    >
      <SelectTrigger className="select-compact" aria-label={label}>
        <SelectValue />
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
  )
}

function TaskPagination({ page, pageCount }: { page: number; pageCount: number }) {
  const [params] = useSearchParams()
  const href = (n: number) => {
    const p = new URLSearchParams(params)
    if (n === 1) p.delete('page')
    else p.set('page', String(n))
    const q = p.toString()
    return q ? `?${q}` : '?'
  }
  if (pageCount <= 1) return null
  return (
    <Pagination aria-label="ページ" page={page} pageCount={pageCount} getHref={href}>
      <PaginationList>
        {({ items }) => (
          <>
            <PaginationItem>
              <PaginationPrevious aria-label="前のページ" render={<Link to={href(Math.max(1, page - 1))} />}>
                <ChevronLeftIcon aria-hidden="true" />
              </PaginationPrevious>
            </PaginationItem>
            {items.map((item) => (
              <PaginationItem key={item}>
                {typeof item === 'number' ? (
                  <PaginationLink page={item} render={<Link to={href(item)} />} />
                ) : (
                  <PaginationEllipsis />
                )}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext aria-label="次のページ" render={<Link to={href(Math.min(pageCount, page + 1))} />}>
                <ChevronRightIcon aria-hidden="true" />
              </PaginationNext>
            </PaginationItem>
          </>
        )}
      </PaginationList>
    </Pagination>
  )
}

// 楽観的更新: 送信中は fetcher.formData の値を先に画面へ出す。失敗すれば loader の値に戻る
function useOptimisticTask(task: TaskListItem) {
  const fetcher = useFetcher<ActionResult>({ key: `task-${task.id}` })
  const pending = fetcher.formData
  const status = (pending?.get('status') as TaskStatus | null) ?? task.status
  const deleting = pending?.get('intent') === 'delete'
  const update = (patch: Record<string, string>) =>
    fetcher.submit({ intent: 'update', id: String(task.id), ...patch }, { method: 'post' })
  const remove = async () => {
    const ok = await confirmDanger({
      title: `「${task.title}」を削除しますか？`,
      description: `タスク「${task.title}」と、そのコメント ${task.commentCount} 件を削除します。`,
      confirmLabel: 'タスクを削除',
    })
    if (ok) await fetcher.submit({ intent: 'delete', id: String(task.id) }, { method: 'post' })
  }
  return { status, deleting, update, remove }
}

function TaskTable({ tasks }: { tasks: TaskListItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col" className="col-check">
              <span className="sr-only">完了</span>
            </th>
            <th scope="col">タイトル</th>
            <th scope="col">ステータス</th>
            <th scope="col">優先度</th>
            <th scope="col">担当者</th>
            <th scope="col">期限</th>
            <th scope="col">タグ</th>
            <th scope="col" className="col-actions">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TaskRow({ task }: { task: TaskListItem }) {
  const { status, deleting, update, remove } = useOptimisticTask(task)
  if (deleting) return null
  return (
    <tr data-status={status}>
      <td className="col-check">
        <Checkbox
          aria-label={`「${task.title}」を完了にする`}
          checked={status === 'done'}
          onCheckedChange={(checked) => update({ status: checked === true ? 'done' : 'todo' })}
        >
          <CheckboxIndicator />
        </Checkbox>
      </td>
      <td className="col-title">
        <Link to={`/tasks/${task.id}`}>{task.title}</Link>
        {task.commentCount > 0 && (
          <span className="comment-count muted" title={`コメント ${task.commentCount} 件`}>
            <MessageSquareIcon aria-hidden="true" />
            <span className="tabular">{task.commentCount}</span>
            <span className="sr-only">件のコメント</span>
          </span>
        )}
      </td>
      <td>
        <StatusLabel status={status} />
      </td>
      <td>
        <PriorityLabel priority={task.priority} />
      </td>
      <td>
        <Assignee member={task.assignee} />
      </td>
      <td>
        <DueDate date={task.dueDate} done={status === 'done'} />
      </td>
      <td>
        <Tags tags={task.tags} />
      </td>
      <td className="col-actions">
        <TaskMenu task={task} status={status} update={update} remove={remove} />
      </td>
    </tr>
  )
}

function Tags({ tags }: { tags: TaskListItem['tags'] }) {
  return (
    <ul className="tags" aria-label="タグ">
      {tags.map((t) => (
        <li key={t.id} className="tag">
          {t.name}
        </li>
      ))}
    </ul>
  )
}

// 行ごとに Menu を置き、トリガーに行の名前を付ける（エージェントが「どの行の操作か」を区別できるように）
function TaskMenu({
  task,
  status,
  update,
  remove,
}: {
  task: TaskListItem
  status: TaskStatus
  update: (patch: Record<string, string>) => void
  remove: () => Promise<void>
}) {
  const navigate = useNavigate()
  return (
    <Menu
      onAction={(value) => {
        if (value === 'open') navigate(`/tasks/${task.id}`)
        else if (value === 'delete') return remove()
        else update({ status: value })
      }}
    >
      <MenuTrigger aria-label={`「${task.title}」の操作`} data-variant="ghost">
        <MoreHorizontalIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        <MenuItem value="open">
          <MenuItemIcon>
            <ExternalLinkIcon />
          </MenuItemIcon>
          開く
        </MenuItem>
        <MenuSeparator />
        {TASK_STATUSES.filter((s) => s !== status).map((s) => {
          const Icon = STATUS_ICON[s]
          return (
            <MenuItem key={s} value={s}>
              <MenuItemIcon>
                <Icon />
              </MenuItemIcon>
              {STATUS_LABEL[s]}にする
            </MenuItem>
          )
        })}
        <MenuSeparator />
        <MenuItem value="delete" data-variant="destructive">
          <MenuItemIcon>
            <Trash2Icon />
          </MenuItemIcon>
          削除
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function Board({ tasks }: { tasks: TaskListItem[] }) {
  return (
    <div className="board">
      {TASK_STATUSES.map((s) => {
        const column = tasks.filter((t) => t.status === s)
        return (
          <section key={s} className="board-column" aria-label={STATUS_LABEL[s]}>
            <h2>
              <StatusLabel status={s} />
              <span className="muted tabular">{column.length}</span>
            </h2>
            <ul>
              {column.map((task) => (
                <BoardCard key={task.id} task={task} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function BoardCard({ task }: { task: TaskListItem }) {
  const { status, deleting, update, remove } = useOptimisticTask(task)
  if (deleting) return null
  return (
    <li className="board-card" data-moving={status !== task.status ? '' : undefined}>
      <div className="board-card-head">
        <Link to={`/tasks/${task.id}`}>{task.title}</Link>
        <TaskMenu task={task} status={status} update={update} remove={remove} />
      </div>
      <Tags tags={task.tags} />
      <div className="board-card-foot">
        <PriorityLabel priority={task.priority} />
        <DueDate date={task.dueDate} done={status === 'done'} />
        <Assignee member={task.assignee} />
      </div>
    </li>
  )
}

const priorityItems = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))
const statusItems = TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))

function NewTaskDialog({ project, tags }: { project: ProjectDetail; tags: { id: number; name: string }[] }) {
  const fetcher = useFetcher<ActionResult>()
  const errors = errorsFor(fetcher.data, 'create')
  const draft = useTaskDraft(project.id)
  const updateDraft = useDrafts((s) => s.updateTask)
  const clearDraft = useDrafts((s) => s.clearTask)
  const set = (patch: Partial<typeof draft>) => updateDraft(project.id, patch)

  return (
    <Dialog controller={newTaskDialog}>
      <DialogTrigger data-variant="solid">
        <PlusIcon aria-hidden="true" />
        新しいタスク
        {hasDraft(draft) && <span className="draft-dot" aria-label="（下書きあり）" />}
      </DialogTrigger>
      <DialogBackdrop />
      <DialogContent className="dialog dialog-wide">
        <DialogTitle>新しいタスク</DialogTitle>
        <DialogDescription>{project.name}</DialogDescription>
        <fetcher.Form method="post" className="form" noValidate>
          <input type="hidden" name="intent" value="create" />
          <TextField
            label="タイトル"
            name="title"
            required
            autoComplete="off"
            value={draft.title}
            onValueChange={(title) => set({ title })}
            errors={errors.title}
          />
          <TextareaField
            label="説明"
            name="description"
            value={draft.description}
            onValueChange={(description) => set({ description })}
            errors={errors.description}
          />
          <div className="form-grid">
            <SelectField
              label="ステータス"
              name="status"
              items={statusItems}
              value={draft.status}
              onValueChange={(status) => status && set({ status: status as TaskStatus })}
              errors={errors.status}
            />
            <SelectField
              label="優先度"
              name="priority"
              items={priorityItems}
              value={draft.priority}
              onValueChange={(priority) => priority && set({ priority: priority as typeof draft.priority })}
              errors={errors.priority}
            />
            <SelectField
              label="担当者"
              name="assigneeId"
              items={[{ value: 'none', label: '未割り当て' }, ...project.members.map((m) => ({ value: String(m.id), label: m.name }))]}
              value={draft.assigneeId ?? 'none'}
              onValueChange={(v) => set({ assigneeId: v === 'none' ? null : (v as string | null) })}
              description="プロジェクトのメンバーから選びます"
              errors={errors.assigneeId}
            />
            <DateField
              label="期限"
              name="dueDate"
              value={draft.dueDate}
              onValueChange={(dueDate) => set({ dueDate: dueDate as string | null })}
              errors={errors.dueDate}
            />
          </div>
          <MultiComboboxField
            label="タグ"
            name="tagIds"
            placeholder="タグを追加…"
            items={tags.map((t) => ({ value: String(t.id), label: t.name }))}
            value={draft.tagIds}
            onValueChange={(tagIds) => set({ tagIds: tagIds as string[] })}
            errors={errors.tagIds}
          />
          {fetcher.data && !fetcher.data.ok && !fetcher.data.fieldErrors && (
            <p className="form-error" role="alert">
              {fetcher.data.error}
            </p>
          )}
          <div className="dialog-actions">
            {hasDraft(draft) && (
              <Button data-variant="ghost" className="mr-auto" onClick={() => clearDraft(project.id)}>
                下書きを消す
              </Button>
            )}
            <DialogClose>閉じる</DialogClose>
            <Button type="submit" data-variant="solid" disabled={fetcher.state !== 'idle'} focusableWhenDisabled>
              作成
            </Button>
          </div>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  )
}
