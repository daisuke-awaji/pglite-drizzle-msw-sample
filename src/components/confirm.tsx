import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@ui-sdk/react/alert-dialog'
import { confirmDanger, type Question } from './confirm-danger'

export function ConfirmDialog() {
  return (
    <AlertDialog controller={confirmDanger.controller}>
      <AlertDialogBackdrop />
      <AlertDialogContent<Question>>
        {(state) => (
          <>
            <AlertDialogTitle>{state.payload?.title}</AlertDialogTitle>
            <AlertDialogDescription>{state.payload?.description}</AlertDialogDescription>
            <div className="dialog-actions">
              <AlertDialogClose>キャンセル</AlertDialogClose>
              <AlertDialogClose
                value="confirm"
                data-variant="destructive"
                data-agent-confirm={state.payload?.description}
              >
                {state.payload?.confirmLabel}
              </AlertDialogClose>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
