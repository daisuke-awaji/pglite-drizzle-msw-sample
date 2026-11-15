import { createConfirm } from '@ui-sdk/react/alert-dialog'

export type Question = { title: string; description: string; confirmLabel: string }

// 一覧の行やメニューから共有して使う確認ダイアログ（描画は confirm.tsx の ConfirmDialog）。
// await confirmDanger({...}) で答えを待てる。同意ボタンには data-agent-confirm が付いているので、
// エージェントが押すときは人の許可が要る（src/agent.ts の allow）
export const confirmDanger = createConfirm<Question>()
