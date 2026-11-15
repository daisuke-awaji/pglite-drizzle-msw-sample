import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog'
import { Button } from '@ui-sdk/react/button'
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field'
import { Switch, SwitchThumb } from '@ui-sdk/react/switch'
import { redirect, useFetcher, useRouteLoaderData, type Params } from 'react-router'
import { api } from '../api/client'
import { SelectField, TextareaField, TextField } from '../components/fields'
import { COLOR_ITEMS as colorItems } from '../shared/enums'
import { projectPatch } from '../shared/schemas'
import type { ProjectDetail } from '../shared/types'
import { errorsFor, idParam, intentOf, run, unknownIntent, validate, type ActionResult } from './lib'

export const handle = { crumb: () => '設定' }

export async function action({ params, request }: { params: Params; request: Request }) {
  const id = idParam(params, 'projectId')
  const form = await request.formData()
  const intent = intentOf(form)
  if (intent === 'update') {
    // スイッチはオンのときだけ送られる。フォームの形を API の形（status）に直してから検証する
    form.set('status', form.get('archived') === 'on' ? 'archived' : 'active')
    const v = validate(intent, projectPatch, form)
    if (!v.ok) return v.result
    return run(intent, () => api.updateProject(id, v.value), '保存しました')
  }
  if (intent === 'delete') {
    const result = await run(intent, () => api.deleteProject(id), 'プロジェクトを削除しました')
    return 'ok' in result && result.ok ? redirect('/projects') : result
  }
  return unknownIntent(intent)
}

export function Component() {
  const project = useRouteLoaderData('project') as ProjectDetail
  const fetcher = useFetcher<ActionResult>()
  const errors = errorsFor(fetcher.data, 'update')
  const saving = fetcher.state !== 'idle' && fetcher.formData?.get('intent') === 'update'

  return (
    <div className="settings-grid">
      {/* 保存のたびに updatedAt が変わるので、key で初期値（defaultValue）を読み直させる */}
      <fetcher.Form method="post" className="card form" key={project.updatedAt} noValidate>
        <h2>基本情報</h2>
        <input type="hidden" name="intent" value="update" />
        <TextField label="プロジェクト名" name="name" defaultValue={project.name} required errors={errors.name} />
        <TextareaField label="説明" name="description" defaultValue={project.description} errors={errors.description} />
        <SelectField label="色" name="color" items={colorItems} defaultValue={project.color} errors={errors.color} />
        <Field name="archived" className="field-row">
          <Switch defaultChecked={project.status === 'archived'}>
            <SwitchThumb />
          </Switch>
          <div>
            <FieldLabel>アーカイブする</FieldLabel>
            <FieldDescription>サイドバーとダッシュボードに出なくなります</FieldDescription>
          </div>
        </Field>
        <div className="form-actions">
          <Button type="submit" data-variant="solid" disabled={saving} focusableWhenDisabled>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </fetcher.Form>

      <section className="card danger-zone">
        <h2>プロジェクトの削除</h2>
        <p className="muted">
          タスク {project.taskCount} 件と、そのコメントもまとめて削除されます。
        </p>
        {/* 削除は「同意して閉じた」ことで実行する。クリックでもエージェントの操作でも同じ経路を通る */}
        <AlertDialog
          onOpenChange={(open, details) => {
            if (!open && details.returnValue === 'confirm') fetcher.submit({ intent: 'delete' }, { method: 'post' })
          }}
        >
          <AlertDialogTrigger data-variant="destructive">プロジェクトを削除</AlertDialogTrigger>
          <AlertDialogBackdrop />
          <AlertDialogContent>
            <AlertDialogTitle>「{project.name}」を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              タスク {project.taskCount} 件と、そのコメントもすべて削除します。この操作は取り消せません。
            </AlertDialogDescription>
            <div className="dialog-actions">
              <AlertDialogClose>キャンセル</AlertDialogClose>
              <AlertDialogClose
                value="confirm"
                data-variant="destructive"
                data-agent-confirm={`プロジェクト「${project.name}」とタスク ${project.taskCount} 件を削除します`}
              >
                完全に削除する
              </AlertDialogClose>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  )
}
