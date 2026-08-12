import { CircleStop } from 'lucide-react'

import { Button } from '@falcondeck/ui'

export function InterruptedTurnNotice({
  onContinue,
  isContinuing = false,
}: {
  onContinue: () => void
  isContinuing?: boolean
}) {
  return (
    <div
      role="status"
      className="mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-[var(--fd-radius-md)] border border-danger/30 bg-danger-muted px-3 py-2"
    >
      <CircleStop aria-hidden="true" className="h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
          This response stopped when FalconDeck closed
        </p>
        <p className="text-[length:var(--fd-text-xs)] text-fg-secondary">
          The conversation is safe. Continue from where the agent left off.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={onContinue}
        disabled={isContinuing}
      >
        {isContinuing ? 'Continuing…' : 'Continue'}
      </Button>
    </div>
  )
}
