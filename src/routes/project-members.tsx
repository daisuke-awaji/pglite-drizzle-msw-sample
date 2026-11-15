import { toast } from '@ui-sdk/react/toast'
import { useFetcher, useLoaderData, useRouteLoaderData, type Params } from 'react-router'
import { api } from '../api/client'
import { MemberAvatar } from '../components/display'
import { TransferList } from '../components/transfer-list/transfer-list'
import { projectMembersInput } from '../shared/schemas'
import type { ProjectDetail } from '../shared/types'
import { idParam, load, run, validate, type ActionResult } from './lib'

export const handle = { crumb: () => 'メンバー' }

export async function loader({ request }: { request: Request }) {
  return load(api.listMembers(request.signal))
}

export async function action({ params, request }: { params: Params; request: Request }) {
  const projectId = idParam(params, 'projectId')
  const form = await request.formData()
  const v = validate('members', projectMembersInput, form, ['memberIds'])
  if (!v.ok) return v.result
  return run('members', async () => {
    const result = await api.setProjectMembers(projectId, v.value.memberIds)
    if (result.unassignedTaskCount > 0) {
      toast.info(`${result.unassignedTaskCount} 件のタスクが未割り当てになりました`, {
        description: '外したメンバーが担当していたタスクです',
      })
    }
    return result
  })
}

export function Component() {
  const project = useRouteLoaderData('project') as ProjectDetail
  const members = useLoaderData<typeof loader>()
  const fetcher = useFetcher<ActionResult>({ key: `project-members-${project.id}` })

  // 送信中は送った値を先に見せる（楽観的更新）。終われば loader の値に置き換わる
  const pending = fetcher.formData?.getAll('memberIds').map(String)
  const value = pending ?? project.members.map((m) => String(m.id))
  const items = members.map((m) => ({ id: String(m.id), label: m.name }))

  return (
    <div className="stack">
      <TransferList
        label="プロジェクトメンバーの割り当て"
        availableLabel="未割り当て"
        assignedLabel="プロジェクトのメンバー"
        itemLabel="人"
        items={items}
        value={value}
        onValueChange={(next) => {
          const form = new FormData()
          for (const id of next) form.append('memberIds', id)
          fetcher.submit(form, { method: 'post' })
        }}
        renderItem={(item) => {
          const m = members.find((x) => String(x.id) === item.id)!
          return (
            <span className="transfer-item">
              <MemberAvatar member={m} />
              <span>{m.name}</span>
              <span className="muted small">{m.title}</span>
            </span>
          )
        }}
      />
    </div>
  )
}
