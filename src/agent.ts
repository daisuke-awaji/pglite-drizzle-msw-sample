import { confirm } from '@ui-sdk/react/alert-dialog'
import { createAgent } from '@ui-sdk/react/agent'

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

// 開発者ツールのコンソールから window.agent.snapshot() などで試せるようにする
Object.assign(window, { agent })
