import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

import type { ApprovalRequest } from '@falcondeck/client-core'
import { ApprovalCard } from '@falcondeck/chat-ui'
import { Badge } from '@falcondeck/ui'

export type ApprovalBarProps = {
  approvals: ApprovalRequest[]
  onApproval: (requestId: string, decision: 'allow' | 'deny' | 'always_allow') => void
}

export function ApprovalBar({ approvals, onApproval }: ApprovalBarProps) {
  const [expanded, setExpanded] = useState(false)

  if (approvals.length === 0) return null

  return (
    <div className="border-b border-border-subtle">
      <button
        type="button"
        onClick={() => setExpanded((c) => !c)}
        className="flex w-full items-center gap-2 bg-warning-muted/30 px-4 py-2 text-[length:var(--fd-text-xs)] font-medium text-warning transition-colors hover:bg-warning-muted/50"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {approvals.length === 1
          ? '1 approval pending'
          : `${approvals.length} approvals pending`}
        <Badge variant="warning" className="ml-1">{approvals.length}</Badge>
        <span className="ml-auto">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded ? (
        <div className="max-h-[300px] space-y-2 overflow-y-auto bg-surface-1 p-3">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.request_id}
              approval={approval}
              onAllow={() => onApproval(approval.request_id, 'allow')}
              onDeny={() => onApproval(approval.request_id, 'deny')}
              onAlwaysAllow={() => onApproval(approval.request_id, 'always_allow')}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
