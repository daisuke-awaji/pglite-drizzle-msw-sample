import { Button } from '@ui-sdk/react/button'
import {
  createDialogController,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@ui-sdk/react/dialog'
import { Menu, MenuContent, MenuItem, MenuItemIcon, MenuTrigger } from '@ui-sdk/react/menu'
import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon, UsersIcon } from 'lucide-react'
import { useFetcher, useLoaderData } from 'react-router'
import { api } from '../api/client'
import { confirmDanger } from '../components/confirm-danger'
import { EmptyState, MemberAvatar, PageHeader } from '../components/display'
import { TextField } from '../components/fields'
import { memberInput, memberPatch } from '../shared/schemas'
import type { MemberListItem } from '../shared/types'
import { errorsFor, intentOf, load, run, unknownIntent, validate, type ActionResult } from './lib'

export const handle = { crumb: () => 'メンバー' }

export async function loader({ request }: { request: Request }) {
  return load(api.listMembers(request.signal))
}

// 追加と編集で 1 つのダイアログを使い回す。どの行から開いたかは payload で渡す
const memberDialog = createDialogController<MemberListItem | null>()

export async function action({ request }: { request: Request }) {
  const form = await request.formData()
  const intent = intentOf(form)
  const id = Number(form.get('id'))
  switch (intent) {
    case 'create': {
      const v = validate(intent, memberInput, form)
      if (!v.ok) return v.result
      const result = await run(intent, () => api.createMember(v.value), 'メンバーを追加しました')
      if ('ok' in result && result.ok) memberDialog.close()
      return result
    }
    case 'update': {
      const v = validate(intent, memberPatch, form)
      if (!v.ok) return v.result
      const result = await run(intent, () => api.updateMember(id, v.value), '保存しました')
      if ('ok' in result && result.ok) memberDialog.close()
      return result
    }
    case 'delete':
      return run(intent, () => api.deleteMember(id), 'メンバーを削除しました')
    default:
      return unknownIntent(intent)
  }
}

export function Component() {
  const members = useLoaderData<typeof loader>()
  return (
    <div className="page">
      <PageHeader
        title="メンバー"
        actions={
          <DialogTrigger controller={memberDialog} payload={null} data-variant="solid">
            <PlusIcon aria-hidden="true" />
            メンバーを追加
          </DialogTrigger>
        }
      />
      {members.length === 0 ? (
        <EmptyState icon={UsersIcon} title="メンバーがいません" />
      ) : (
        <div className="table-wrap">
          <table className="table table-stack">
            <caption className="sr-only">メンバーの一覧</caption>
            <thead>
              <tr>
                <th scope="col">名前</th>
                <th scope="col">メールアドレス</th>
                <th scope="col">役割</th>
                <th scope="col" className="num">
                  プロジェクト
                </th>
                <th scope="col" className="num">
                  未完了のタスク
                </th>
                <th scope="col" className="col-actions">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={m.id} member={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MemberDialog />
    </div>
  )
}

function MemberRow({ member }: { member: MemberListItem }) {
  const fetcher = useFetcher<ActionResult>()
  if (fetcher.state !== 'idle' && fetcher.formData?.get('intent') === 'delete') return null

  const remove = async () => {
    const description =
      member.openTaskCount > 0
        ? `${member.name}さんを削除します。担当中のタスク ${member.openTaskCount} 件は未割り当てになり、コメントは残ります。`
        : `${member.name}さんを削除します。コメントは投稿者なしで残ります。`
    const ok = await confirmDanger({ title: `${member.name}さんを削除しますか？`, description, confirmLabel: 'メンバーを削除' })
    if (ok) fetcher.submit({ intent: 'delete', id: String(member.id) }, { method: 'post' })
  }

  return (
    <tr>
      <td className="cell-primary">
        <span className="assignee">
          <MemberAvatar member={member} />
          {member.name}
        </span>
      </td>
      <td className="muted cell-break" data-label="メール">
        {member.email}
      </td>
      <td data-label="役割">{member.title || <span className="muted">—</span>}</td>
      <td className="num tabular" data-label="プロジェクト">
        {member.projectCount}
      </td>
      <td className="num tabular" data-label="未完了のタスク">
        {member.openTaskCount}
      </td>
      <td className="col-actions">
        <Menu
          presentation="auto"
          onAction={(value) => {
            if (value === 'edit') memberDialog.open({ payload: member })
            if (value === 'delete') return remove()
          }}
        >
          <MenuTrigger aria-label={`${member.name}さんの操作`} data-variant="ghost">
            <MoreHorizontalIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem value="edit">
              <MenuItemIcon>
                <PencilIcon />
              </MenuItemIcon>
              編集
            </MenuItem>
            <MenuItem value="delete" data-variant="destructive">
              <MenuItemIcon>
                <Trash2Icon />
              </MenuItemIcon>
              削除
            </MenuItem>
          </MenuContent>
        </Menu>
      </td>
    </tr>
  )
}

function MemberDialog() {
  const fetcher = useFetcher<ActionResult>({ key: 'member-dialog' })
  return (
    <Dialog controller={memberDialog}>
      <DialogBackdrop />
      <DialogContent<MemberListItem | null> className="dialog" keepMounted>
        {(state) => {
          const member = state.payload ?? null
          const intent = member ? 'update' : 'create'
          const errors = errorsFor(fetcher.data, intent)
          return (
            <>
              <DialogTitle>{member ? `${member.name}さんを編集` : 'メンバーを追加'}</DialogTitle>
              <fetcher.Form method="post" className="form" key={member?.id ?? 'new'} noValidate>
                <input type="hidden" name="intent" value={intent} />
                {member && <input type="hidden" name="id" value={member.id} />}
                <TextField label="名前" name="name" defaultValue={member?.name} required autoComplete="off" errors={errors.name} />
                <TextField
                  label="メールアドレス"
                  name="email"
                  type="email"
                  defaultValue={member?.email}
                  required
                  autoComplete="off"
                  errors={errors.email}
                />
                <TextField label="役割" name="title" defaultValue={member?.title} errors={errors.title} />
                <div className="dialog-actions">
                  <DialogClose>キャンセル</DialogClose>
                  <Button type="submit" data-variant="solid" disabled={fetcher.state !== 'idle'} focusableWhenDisabled>
                    {member ? '保存' : '追加'}
                  </Button>
                </div>
              </fetcher.Form>
            </>
          )
        }}
      </DialogContent>
    </Dialog>
  )
}
