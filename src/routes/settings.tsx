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
import { useFetcher, useLoaderData, useRevalidator } from 'react-router'
import { api, devApi } from '../api/client'
import { PageHeader } from '../components/display'
import { InlineError } from '../components/error-view'
import { SelectField, TextField } from '../components/fields'
import { USES_MOCK_API } from '../lib/env'
import { useFocusAfterRemoval } from '../lib/focus-after-removal'
import { tagInput } from '../shared/schemas'
import type { DbInfo, TagListItem } from '../shared/types'
import { usePreferences, type Fault, type Latency, type Theme } from '../stores/preferences'
import { errorsFor, intentOf, run, settle, unknownIntent, validate, type ActionResult } from './lib'

export const handle = { crumb: () => '設定' }

// 設定画面は「障害シミュレーションを止める」場所でもあるので、API が失敗しても画面全体はエラーにしない。
// 読めなかった部分だけをその場でエラー表示にする
export async function loader({ request }: { request: Request }) {
  const [tags, db] = await Promise.all([
    settle(api.listTags(request.signal)),
    // ブラウザ内 DB の状態はモック API にしかない
    USES_MOCK_API ? settle(devApi.dbInfo(request.signal)) : undefined,
  ])
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
      if (!USES_MOCK_API) return unknownIntent(intent)
      return run(intent, () => devApi.reset(), 'サンプルデータに戻しました')
    default:
      return unknownIntent(intent)
  }
}

const faultItems: { value: Fault; label: string }[] = [
  { value: 'none', label: 'なし（正常）' },
  { value: 'error-writes', label: '保存だけ失敗させる（503）' },
  { value: 'error-all', label: 'すべて失敗させる（503）' },
  { value: 'offline', label: 'サーバーにつながらない' },
]

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
        {USES_MOCK_API && <Storage />}
      </div>
    </div>
  )
}

// この端末だけの設定。Zustand の persist で localStorage に保存される
function Preferences() {
  const { theme, sidebarCollapsed, latency, fault, setTheme, toggleSidebar, setLatency, setFault } = usePreferences()
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
      <Field className="field-row desktop-only">
        <Switch checked={sidebarCollapsed} onCheckedChange={toggleSidebar}>
          <SwitchThumb />
        </Switch>
        <FieldLabel>サイドバーを折りたたむ</FieldLabel>
      </Field>
      {/* モック API の挙動を変える設定。本番の API には効かないので出さない */}
      {USES_MOCK_API && (
        <>
          <SelectField
            label="API の遅延"
            name="latency"
            items={latencyItems}
            value={String(latency)}
            onValueChange={(v) => v && setLatency(Number(v) as Latency)}
            description="モック API の応答を遅らせて、読み込み中の表示や楽観的更新を確かめます"
          />
          <SelectField
            label="障害シミュレーション"
            name="fault"
            items={faultItems}
            value={fault}
            onValueChange={(v) => v && setFault(v as Fault)}
            description="エラー表示と再試行を確かめます。この設定は保存されず、ページを読み込み直すと「なし」に戻ります"
          />
        </>
      )}
    </section>
  )
}

function Tags() {
  const { tags: result } = useLoaderData<typeof loader>()
  const revalidator = useRevalidator()
  if (!result.ok) {
    return (
      <section className="card form">
        <h2>タグ</h2>
        <InlineError error={result.error} onRetry={() => revalidator.revalidate()} />
      </section>
    )
  }
  return <TagList tags={result.value} />
}

function TagList({ tags }: { tags: TagListItem[] }) {
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
  const { ref: rowRef, plan: planFocus } = useFocusAfterRemoval<HTMLLIElement>()
  if (fetcher.state !== 'idle') return null
  return (
    <li ref={rowRef}>
      <span className="tag">{tag.name}</span>
      <span className="muted small tabular">{tag.taskCount} 件</span>
      <Button
        data-variant="ghost"
        aria-label={`タグ「${tag.name}」を削除`}
        data-agent-confirm={`タグ「${tag.name}」を削除し、${tag.taskCount} 件のタスクから外します`}
        data-row-focus
        onClick={() => {
          planFocus()()
          void fetcher.submit({ intent: 'delete-tag', id: String(tag.id) }, { method: 'post' })
        }}
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
  const { db: result } = useLoaderData<typeof loader>()
  if (!result) return null
  return (
    <section className="card form span-2">
      <h2>データの保存先</h2>
      <div className="table-wrap">
        <table className="table table-stack">
          <caption className="sr-only">データの保存先</caption>
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
                <td className="cell-primary">{s.where}</td>
                <td data-label="キー">
                  <code className="cell-break">{s.key}</code>
                </td>
                <td data-label="内容">{s.what}</td>
                <td className="muted" data-label="経路">
                  {s.via}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.ok ? <DbMeta db={result.value} /> : <InlineError error={result.error} />}
      <ResetData />
    </section>
  )
}

function DbMeta({ db }: { db: DbInfo }) {
  return (
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
  )
}

function ResetData() {
  const fetcher = useFetcher<ActionResult>()
  return (
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
  )
}
