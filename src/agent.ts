import { confirm } from '@ui-sdk/react/alert-dialog'
import { createAgent } from '@ui-sdk/react/agent'
import { USES_MOCK_API } from './lib/env'

// エージェントブリッジ。描画より前に作る必要があるので main.tsx の先頭で読み込む。
// data-agent-confirm が付いた操作（削除など）は、実行前に人に確認する。
export const agent = createAgent({
  allow: (step) =>
    step.confirm
      ? confirm({
          title: 'エージェントの操作を許可しますか？',
          description: step.confirm,
          confirmLabel: '許可する',
          cancelLabel: '許可しない',
        })
      : true,
})

// 開発者ツールのコンソールから window.agent.snapshot() などで試せるようにする。
// 本番（モック API を使わないビルド）では、ページ上の誰でも操作できる口を開けたままにしない
if (import.meta.env.DEV || USES_MOCK_API) Object.assign(window, { agent })
