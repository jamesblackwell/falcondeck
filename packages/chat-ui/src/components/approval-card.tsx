import { memo } from 'react'
import { AlertTriangle } from 'lucide-react'

import type { ApprovalRequest } from '@falcondeck/client-core'
import { Button } from '@falcondeck/ui'

export type ApprovalCardProps = {
  approval: ApprovalRequest
  onAllow: () => void
  onDeny: () => void
  onAlwaysAllow?: () => void
}

export const ApprovalCard = memo(function ApprovalCard({ approval, onAllow, onDeny, onAlwaysAllow }: ApprovalCardProps) {
  return (
    <div className="rounded-[var(--fd-radius-lg)] border border-warning/20 bg-warning-muted px-4 py-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{approval.title}</p>
          {approval.detail ? (
            <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">{approval.detail}</p>
          ) : null}
          {approval.command ? (
            <pre className="mt-2 overflow-x-auto rounded-[var(--fd-radius-md)] bg-surface-1 px-2.5 py-1.5 font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
              {approval.command}
            </pre>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={onDeny}>
              Deny
            </Button>
            <Button type="button" size="sm" onClick={onAllow}>
              Allow
            </Button>
            {onAlwaysAllow ? (
              <Button type="button" size="sm" variant="ghost" onClick={onAlwaysAllow}>
                Always
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
})
