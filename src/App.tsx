import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from './api/client'
import type { Todo } from './shared/types'

const toMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [dbInfo, setDbInfo] = useState<string | null>(null)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      setTodos(await api.listTodos())
    } catch (e) {
      setError(toMessage(e))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.debug(), api.listTodos()])
      .then(([info, list]) => {
        if (cancelled) return
        setDbInfo(`${info.version.split(' on ')[0]} / マイグレーション ${info.migrations.length} 件適用済み`)
        setTodos(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(toMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api.createTodo(title)
      setTitle('')
    })
  }

  return (
    <main>
      <h1>PGlite + Drizzle + MSW</h1>
      <p className="lead">
        ブラウザの中で PostgreSQL（PGlite）が動いています。データは IndexedDB に保存されるので、
        リロードしても残ります。
      </p>
      {dbInfo && <p className="db-info" data-testid="db-info">{dbInfo}</p>}

      <form onSubmit={onSubmit}>
        <input
          aria-label="新しい Todo"
          placeholder="やること"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit">追加</button>
      </form>

      {error && <p role="alert" className="error">{error}</p>}
      {loading ? (
        <p>DB を準備しています…</p>
      ) : todos.length === 0 ? (
        <p className="empty">まだありません</p>
      ) : (
        <ul>
          {todos.map((todo) => (
            <li key={todo.id} className={todo.done ? 'done' : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => void run(() => api.updateTodo(todo.id, { done: !todo.done }))}
                />
                <span>{todo.title}</span>
              </label>
              <button
                className="delete"
                aria-label={`${todo.title} を削除`}
                onClick={() => void run(() => api.deleteTodo(todo.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer>
        <button className="reset" onClick={() => void run(() => api.reset())}>
          データをリセット
        </button>
      </footer>
    </main>
  )
}
