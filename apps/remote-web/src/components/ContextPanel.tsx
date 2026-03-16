import type { ApprovalRequest, ThreadSummary } from '@falcondeck/client-core'
import { ApprovalCard } from '@falcondeck/chat-ui'
import { Badge, Panel, PanelContent, PanelHeader, StatusIndicator } from '@falcondeck/ui'

export type RemoteContextPanelProps = {
  approvals: ApprovalRequest[]
  onApproval: (requestId: string, decision: 'allow' | 'deny') => void
  thread: ThreadSummary | null
}

export function RemoteContextPanel({ approvals, onApproval, thread }: RemoteContextPanelProps) {
  const hasApprovals = approvals.length > 0
  const hasPlan = Boolean(thread?.latest_plan?.steps.length)

  if (!hasApprovals && !hasPlan) return null

  return (
    <div className="flex flex-col overflow-y-auto rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1">
      {hasApprovals ? (
        <Panel>
          <PanelHeader>
            <StatusIndicator status="warning" size="sm" pulse />
            Approvals
            <Badge variant="warning" className="ml-auto">{approvals.length}</Badge>
          </PanelHeader>
          <PanelContent>
            <div className="space-y-2">
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.request_id}
                  approval={approval}
                  onAllow={() => onApproval(approval.request_id, 'allow')}
                  onDeny={() => onApproval(approval.request_id, 'deny')}
                />
              ))}
            </div>
          </PanelContent>
        </Panel>
      ) : null}

      {hasPlan ? (
        <Panel collapsible defaultOpen>
          <PanelHeader collapsible>Plan</PanelHeader>
          <PanelContent collapsible>
            <div className="space-y-1">
              {thread!.latest_plan!.steps.map((step, index) => (
                <div key={`${step.step}-${index}`} className="flex items-center justify-between gap-2 text-[length:var(--fd-text-sm)]">
                  <span className="text-fg-primary">{step.step}</span>
                  <span className="text-[length:var(--fd-text-xs)] text-fg-muted">{step.status}</span>
                </div>
              ))}
            </div>
          </PanelContent>
        </Panel>
      ) : null}
    </div>
  )
}
