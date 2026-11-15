import { Button } from '@ui-sdk/react/button'
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@ui-sdk/react/dialog'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { FolderKanbanIcon, PlusIcon } from 'lucide-react'
import { Link, redirect, useFetcher, useLoaderData, useSearchParams } from 'react-router'
import { api } from '../api/client'
import { AvatarStack, ColorDot, EmptyState, PageHeader, ProgressBar } from '../components/display'
import { SelectField, TextareaField, TextField } from '../components/fields'
import { SearchParamInput } from '../components/search-param-input'
import { COLOR_ITEMS as colorItems } from '../shared/enums'
import { projectInput } from '../shared/schemas'
import { errorsFor, intentOf, load, run, validate, type ActionResult } from './lib'

export const handle = { crumb: () => 'プロジェクト' }

// 絞り込みは URL の ?q= と ?status= が持つ。loader は URL から読むだけ
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? 'active'
  return load(
    api.listProjects(
      { q: url.searchParams.get('q'), status: status === 'all' ? undefined : status },
      request.signal,
    ),
  )
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData()
  const intent = intentOf(form)
  const v = validate(intent, projectInput, form)
  if (!v.ok) return v.result
  const result = await run(intent, () => api.createProject(v.value), 'プロジェクトを作成しました')
  if ('ok' in result && result.ok) return redirect(`/projects/${result.id}`)
  return result
}

export function Component() {
  const projects = useLoaderData<typeof loader>()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? 'active'

  return (
    <div className="page">
      <PageHeader title="プロジェクト" actions={<NewProjectDialog />} />
      <div className="toolbar">
        <SearchParamInput label="プロジェクトを検索" placeholder="名前で検索" />
        <SegmentedControl
          aria-label="表示するプロジェクト"
          value={status}
          onValueChange={(value) =>
            setParams((prev) => {
              const p = new URLSearchParams(prev)
              if (!value || value === 'active') p.delete('status')
              else p.set('status', value)
              return p
            })
          }
        >
          <SegmentedControlIndicator />
          <SegmentedControlItem value="active">進行中</SegmentedControlItem>
          <SegmentedControlItem value="archived">アーカイブ</SegmentedControlItem>
          <SegmentedControlItem value="all">すべて</SegmentedControlItem>
        </SegmentedControl>
      </div>

      {projects.length === 0 ? (
        <EmptyState icon={FolderKanbanIcon} title="プロジェクトがありません" />
      ) : (
        <ul className="card-grid">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="card project-card" data-archived={p.status === 'archived' ? '' : undefined}>
                <div className="project-card-head">
                  <ColorDot color={p.color} />
                  <h2>{p.name}</h2>
                  {p.status === 'archived' && <span className="badge">アーカイブ</span>}
                </div>
                <p className="muted clamp-2">{p.description || '説明はありません'}</p>
                <div className="project-card-foot">
                  <AvatarStack members={p.members} />
                  <span className="muted small tabular">
                    {p.doneCount}/{p.taskCount} 完了
                  </span>
                </div>
                <ProgressBar label={`${p.name}の進み具合`} done={p.doneCount} total={p.taskCount} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NewProjectDialog() {
  const fetcher = useFetcher<ActionResult>()
  const errors = errorsFor(fetcher.data, 'create')
  return (
    <Dialog>
      <DialogTrigger data-variant="solid">
        <PlusIcon aria-hidden="true" />
        新しいプロジェクト
      </DialogTrigger>
      <DialogBackdrop />
      <DialogContent className="dialog">
        <DialogTitle>新しいプロジェクト</DialogTitle>
        <DialogDescription>作成するとプロジェクトのページに移動します。</DialogDescription>
        <fetcher.Form method="post" className="form" noValidate>
          <input type="hidden" name="intent" value="create" />
          <TextField label="プロジェクト名" name="name" required autoComplete="off" errors={errors.name} />
          <TextareaField label="説明" name="description" errors={errors.description} />
          <SelectField label="色" name="color" items={colorItems} defaultValue="gray" errors={errors.color} />
          <div className="dialog-actions">
            <DialogClose>キャンセル</DialogClose>
            <Button type="submit" data-variant="solid" disabled={fetcher.state !== 'idle'} focusableWhenDisabled>
              作成
            </Button>
          </div>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  )
}
