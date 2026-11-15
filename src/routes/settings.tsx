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
import { Field, FieldLabel } from '@ui-sdk/react/field'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { Switch, SwitchThumb } from '@ui-sdk/react/switch'
import { PlusIcon, XIcon } from 'lucide-react'
import { useFetcher, useLoaderData } from 'react-router'
import { api } from '../api/client'
import { PageHeader } from '../components/display'
import { SelectField, TextField } from '../components/fields'
import { tagInput } from '../shared/schemas'
import { usePreferences, type Latency, type Theme } from '../stores/preferences'
import { errorsFor, intentOf, load, run, unknownIntent, validate, type ActionResult } from './lib'

export const handle = { crumb: () => '設定' }

export async function loader({ request }: { request: Request }) {
  const [tags, db] = await Promise.all([load(api.listTags(request.signal)), load(api.dbInfo(request.signal))])
  return { tags, db }
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData()
  const intent = intentOf(form)
  switch (intent) {
    case 'create-tag': {
      const v = validate(intent, tagInput, form)
      if (!v.ok) return v.result
      return run(intent, () => api.createTag(v.value), (t) => `タグ「${(t as { name: string }).name}」を追加しました`)
    }
    case 'delete-tag':
      return run(intent, () => api.deleteTag(Number(form.get('id'))), 'タグを削除しました')
    case 'reset':
      return run(intent, () => api.reset(), 'サンプルデータに戻しました')
    default:
      return unknownIntent(intent)
  }
}

const latencyItems = [
  { value: '0', label: 'なし' },
  { value: '300', label: '300 ミリ秒' },
  { value: '1000', label: '1 秒' },
]

export function Component() {
  return (
    <div className="page">
      <PageHeader title="設定" />
      <div className="settings-grid">
        <Preferences />
        <Tags />
        <Storage />
      </div>
    </div>
  )
}

// この端末だけの設定。Zustand の persist で localStorage に保存される
function Preferences() {
  const { theme, sidebarCollapsed, latency, setTheme, toggleSidebar, setLatency } = usePreferences()
  return (
    <section className="card form">
      <h2>表示</h2>
      <Field>
        <FieldLabel>テーマ</FieldLabel>
        <SegmentedControl value={theme} onValueChange={(v) => v && setTheme(v as Theme)}>
          <SegmentedControlIndicator />
          <SegmentedControlItem value="system">システム</SegmentedControlItem>
          <SegmentedControlItem value="light">ライト</SegmentedControlItem>
          <SegmentedControlItem value="dark">ダーク</SegmentedControlItem>
        </SegmentedControl>
      </Field>
      <Field className="field-row">
        <Switch checked={sidebarCollapsed} onCheckedChange={toggleSidebar}>
          <SwitchThumb />
        </Switch>
        <FieldLabel>サイドバーを折りたたむ</FieldLabel>
      </Field>
      <SelectField
        label="API の遅延"
        name="latency"
        items={latencyItems}
        value={String(latency)}
        onValueChange={(v) => v && setLatency(Number(v) as Latency)}
        description="モック API の応答を遅らせて、読み込み中の表示や楽観的更新を確かめます"
      />
    </section>
  )
}

function Tags() {
  const { tags } = useLoaderData<typeof loader>()
  const fetcher = useFetcher<ActionResult>()
  const errors = errorsFor(fetcher.data, 'create-tag')
  return (
    <section className="card form">
      <h2>タグ</h2>
      <ul className="tag-admin">
        {tags.map((t) => (
          <TagRow key={t.id} tag={t} />
        ))}
      </ul>
      <fetcher.Form method="post" className="inline-form" key={tags.length} noValidate>
        <input type="hidden" name="intent" value="create-tag" />
        <TextField label="新しいタグ" name="name" required autoComplete="off" errors={errors.name} />
        <Button type="submit" disabled={fetcher.state !== 'idle'} focusableWhenDisabled>
          <PlusIcon aria-hidden="true" />
          追加
        </Button>
      </fetcher.Form>
    </section>
  )
}

function TagRow({ tag }: { tag: { id: number; name: string; taskCount: number } }) {
  const fetcher = useFetcher<ActionResult>()
  if (fetcher.state !== 'idle') return null
  return (
    <li>
      <span className="tag">{tag.name}</span>
      <span className="muted small tabular">{tag.taskCount} 件</span>
      <Button
        data-variant="ghost"
        aria-label={`タグ「${tag.name}」を削除`}
        data-agent-confirm={`タグ「${tag.name}」を削除し、${tag.taskCount} 件のタスクから外します`}
        onClick={() => fetcher.submit({ intent: 'delete-tag', id: String(tag.id) }, { method: 'post' })}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </li>
  )
}

const STORAGES = [
  { where: 'IndexedDB', key: 'idb://starter-kit', what: 'ブラウザ内の PostgreSQL（PGlite）のデータ', via: 'MSW → src/server → Drizzle' },
  { where: 'localStorage', key: 'starter-kit:preferences', what: 'テーマ・サイドバー・表示形式・API の遅延', via: 'Zustand persist' },
  { where: 'sessionStorage', key: 'starter-kit:drafts', what: '書きかけのタスク（タブを閉じると消える）', via: 'Zustand persist' },
  { where: 'URL', key: '?q= ?status= ?sort= ?page=', what: '検索・絞り込み・並び順・ページ', via: 'React Router の loader' },
]

function Storage() {
  const { db } = useLoaderData<typeof loader>()
  const fetcher = useFetcher<ActionResult>()
  return (
    <section className="card form span-2">
      <h2>データの保存先</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">保存先</th>
              <th scope="col">キー</th>
              <th scope="col">内容</th>
              <th scope="col">経路</th>
            </tr>
          </thead>
          <tbody>
            {STORAGES.map((s) => (
              <tr key={s.where}>
                <td>{s.where}</td>
                <td>
                  <code>{s.key}</code>
                </td>
                <td>{s.what}</td>
                <td className="muted">{s.via}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="meta">
        <div>
          <dt>データベース</dt>
          <dd>{db.version.split(' on ')[0]}</dd>
        </div>
        <div>
          <dt>マイグレーション</dt>
          <dd>{db.migrations.length} 件適用済み</dd>
        </div>
        <div>
          <dt>行数</dt>
          <dd className="tabular">
            {Object.entries(db.rows)
              .map(([table, n]) => `${table} ${n}`)
              .join(' / ')}
          </dd>
        </div>
      </dl>
      <AlertDialog
        onOpenChange={(open, details) => {
          if (!open && details.returnValue === 'confirm') fetcher.submit({ intent: 'reset' }, { method: 'post' })
        }}
      >
        <AlertDialogTrigger data-variant="destructive" className="self-start">
          サンプルデータに戻す
        </AlertDialogTrigger>
        <AlertDialogBackdrop />
        <AlertDialogContent>
          <AlertDialogTitle>サンプルデータに戻しますか？</AlertDialogTitle>
          <AlertDialogDescription>追加・変更したデータはすべて消えます。設定と下書きは残ります。</AlertDialogDescription>
          <div className="dialog-actions">
            <AlertDialogClose>キャンセル</AlertDialogClose>
            <AlertDialogClose value="confirm" data-variant="destructive" data-agent-confirm="ブラウザ内のデータをすべて消して、サンプルデータに戻します">
              初期化する
            </AlertDialogClose>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
