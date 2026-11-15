import { sql } from 'drizzle-orm'
import { comments, members, projectMembers, projects, tags, tasks, taskTags } from '../db/schema'
import { addDays } from '../shared/dates'
import type { Priority, TaskStatus } from '../shared/enums'
import type { Db } from '../server/core'

const MEMBERS = [
  { name: '相沢 愛子', email: 'aiko@example.com', title: 'プロダクトマネージャー' },
  { name: '馬場 文太', email: 'bunta@example.com', title: 'フロントエンド' },
  { name: '千葉 千夏', email: 'chika@example.com', title: 'デザイナー' },
  { name: '土井 大輔', email: 'daisuke@example.com', title: 'バックエンド' },
  { name: '江藤 恵美', email: 'emi@example.com', title: 'QA' },
  { name: '古川 文夫', email: 'fumio@example.com', title: 'インフラ' },
  { name: '後藤 玄', email: 'gen@example.com', title: 'バックエンド' },
  { name: '堀 遥', email: 'haruka@example.com', title: 'マーケティング' },
]

const TAGS = ['UI', 'API', 'バグ', 'ドキュメント', '調査', 'パフォーマンス']

type SeedTask = [title: string, status: TaskStatus, priority: Priority, assignee: number | null, dueInDays: number | null, tags: number[]]

const PROJECTS: {
  name: string
  description: string
  color: 'blue' | 'green' | 'amber' | 'violet'
  status?: 'archived'
  members: number[]
  tasks: SeedTask[]
}[] = [
  {
    name: 'Web サイト刷新',
    description: 'コーポレートサイトのデザインと CMS を入れ替える。',
    color: 'blue',
    members: [0, 1, 2, 4],
    tasks: [
      ['トップページのワイヤーフレーム', 'done', 'high', 2, -10, [0]],
      ['デザイントークンの整理', 'done', 'medium', 2, -6, [0, 3]],
      ['ヘッダーとフッターの実装', 'in_progress', 'high', 1, 2, [0]],
      ['お問い合わせフォームのバリデーション', 'in_progress', 'medium', 1, 5, [0, 1]],
      ['CMS のコンテンツモデル設計', 'todo', 'high', 0, 7, [1, 3]],
      ['画像の遅延読み込み', 'todo', 'low', null, 14, [5]],
      ['Safari でメニューが閉じない', 'todo', 'high', 4, -1, [2]],
      ['アクセシビリティ監査', 'todo', 'medium', 4, 21, [4]],
      ['OGP 画像の自動生成', 'todo', 'low', null, null, [0]],
      ['404 ページのデザイン', 'done', 'low', 2, -3, [0]],
      ['フォント読み込みの最適化', 'in_progress', 'medium', 1, 3, [5]],
      ['サイトマップの作成', 'todo', 'low', 0, 10, [3]],
    ],
  },
  {
    name: 'モバイルアプリ v2',
    description: 'オフライン対応とプッシュ通知を入れる。',
    color: 'violet',
    members: [0, 1, 3, 6],
    tasks: [
      ['オフライン同期の方式を決める', 'done', 'high', 3, -14, [4]],
      ['ローカル DB のスキーマ', 'in_progress', 'high', 3, 1, [1]],
      ['プッシュ通知の権限ダイアログ', 'todo', 'medium', 1, 6, [0]],
      ['同期の競合解決', 'todo', 'high', 6, 12, [1, 4]],
      ['起動時間の計測', 'todo', 'medium', null, 9, [5]],
      ['ログイン後に白い画面が出る', 'in_progress', 'high', 1, 0, [2]],
    ],
  },
  {
    name: '社内ツール基盤',
    description: '認証・監査ログ・権限管理を共通化する。',
    color: 'green',
    members: [3, 5, 6],
    tasks: [
      ['SSO の接続テスト', 'done', 'medium', 5, -20, [1]],
      ['監査ログの保存期間を決める', 'todo', 'low', 3, 30, [3, 4]],
      ['権限モデルの API', 'in_progress', 'high', 6, 4, [1]],
      ['Terraform のモジュール化', 'todo', 'medium', 5, 15, [3]],
    ],
  },
  {
    name: '2025 年度キャンペーン',
    description: '終了したキャンペーン。参照用に残している。',
    color: 'amber',
    status: 'archived',
    members: [0, 7],
    tasks: [
      ['LP の公開', 'done', 'high', 7, -200, [0]],
      ['効果測定レポート', 'done', 'medium', 0, -150, [3]],
    ],
  },
]

const COMMENTS: [projectIndex: number, taskIndex: number, author: number, body: string][] = [
  [0, 2, 0, 'ロゴの余白はデザインカンプに合わせてください。'],
  [0, 2, 1, '了解です。モバイルのハンバーガーメニューも合わせて対応します。'],
  [0, 6, 4, 'iOS 17 の Safari で再現しました。Escape でも閉じません。'],
  [1, 5, 1, 'トークンの更新処理が原因っぽいです。調査中。'],
  [1, 5, 3, 'API 側のレスポンスは正常でした。'],
  [2, 2, 6, '読み取り専用ロールを追加する案を検討しています。'],
]

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// プロトタイプ専用のサンプルデータ。本番のバックエンドには持っていかない（src/server には置かない）

export async function seed(db: Db, today = new Date()): Promise<void> {
  await db.transaction((tx) => insertSampleData(tx, today))
}

async function insertSampleData(tx: Tx, today: Date): Promise<void> {
  const memberRows = await tx.insert(members).values(MEMBERS).returning({ id: members.id })
  const tagRows = await tx.insert(tags).values(TAGS.map((name) => ({ name }))).returning({ id: tags.id })
  const memberId = (i: number) => memberRows[i]!.id
  const taskIds: number[][] = []

  for (const p of PROJECTS) {
    const [project] = await tx
      .insert(projects)
      .values({ name: p.name, description: p.description, color: p.color, status: p.status ?? 'active' })
      .returning({ id: projects.id })
    await tx.insert(projectMembers).values(p.members.map((m) => ({ projectId: project!.id, memberId: memberId(m) })))

    const rows = await tx
      .insert(tasks)
      .values(
        p.tasks.map(([title, status, priority, assignee, due], i) => ({
          projectId: project!.id,
          title,
          status,
          priority,
          assigneeId: assignee === null ? null : memberId(assignee),
          dueDate: due === null ? null : addDays(today, due),
          // 日時をずらして「更新が新しい順」で並びに差が出るようにする
          createdAt: new Date(today.getTime() - (i + 24) * 3_600_000),
          updatedAt: new Date(today.getTime() - i * 3_600_000),
        })),
      )
      .returning({ id: tasks.id })
    taskIds.push(rows.map((r) => r.id))

    const links = p.tasks.flatMap(([, , , , , tagIdx], i) =>
      tagIdx.map((t) => ({ taskId: rows[i]!.id, tagId: tagRows[t]!.id })),
    )
    if (links.length > 0) await tx.insert(taskTags).values(links)
  }

  await tx.insert(comments).values(
    COMMENTS.map(([p, t, author, body], i) => ({
      taskId: taskIds[p]![t]!,
      authorId: memberId(author),
      body,
      createdAt: new Date(today.getTime() - (COMMENTS.length - i) * 1_800_000),
    })),
  )
}

const TABLES = [comments, taskTags, tasks, projectMembers, projects, tags, members]

/**
 * どの表も空のとき（初めて開いたとき）だけサンプルデータを入れる。
 * members だけを見ると、利用者がメンバーを全員消したあとの再読み込みで seed がタグの一意制約に当たり、
 * 起動できなくなる（データを消すしかなくなる）ので、全部の表を見る
 */
export async function seedIfEmpty(db: Db, today = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    // トランザクションは 1 本の接続なので、問い合わせは 1 つずつ送る（node-postgres では同時に送れない）
    for (const t of TABLES) if ((await tx.$count(t)) > 0) return false
    await insertSampleData(tx, today)
    return true
  })
}

/** すべて消してサンプルデータに戻す。途中で失敗しても空の DB が残らないよう、1 つのトランザクションで行う */
export async function resetData(db: Db, today = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`truncate ${comments}, ${taskTags}, ${tasks}, ${projectMembers}, ${projects}, ${tags}, ${members} restart identity cascade`,
    )
    await insertSampleData(tx, today)
  })
}
