import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { routes } from '../router'

/**
 * アプリの本物のルート（loader・action・画面）を、URL を指定してそのまま描画する。
 * setupTestApi() と組み合わせると、画面 → API クライアント → MSW → src/server → PGlite まで本物で動く
 */
export async function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(<RouterProvider router={router} />)
  // loader が終わって画面の見出しが出るまで待つ（PGlite の初回は少し時間がかかる）
  await screen.findByRole('heading', { level: 1 }, { timeout: 10_000 })
  return { router, ...view }
}
