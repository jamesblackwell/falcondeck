import { AlertTriangle, LoaderCircle, Smartphone } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

import type { ApprovalRequest, RemoteStatusResponse, ThreadSummary } from '@falcondeck/client-core'
import { ApprovalCard, CodeBlock } from '@falcondeck/chat-ui'
import {
  Badge,
  Button,
  Input,
  Panel,
  PanelContent,
  PanelHeader,
  StatusIndicator,
} from '@falcondeck/ui'

import { remoteDescription, remoteHeadline, remoteTone } from '../utils'

export type ContextPanelProps = {
  remoteStatus: RemoteStatusResponse | null
  pairingLink: string | null
  relayUrl: string
  onRelayUrlChange: (url: string) => void
  onStartPairing: () => void
  isStartingRemote: boolean
  approvals: ApprovalRequest[]
  onApproval: (requestId: string, decision: 'allow' | 'deny' | 'always_allow') => void
  thread: ThreadSummary | null
}

export function ContextPanel({
  remoteStatus,
  pairingLink,
  relayUrl,
  onRelayUrlChange,
  onStartPairing,
  isStartingRemote,
  approvals,
  onApproval,
  thread,
}: ContextPanelProps) {
  const isRemoteConnected = remoteStatus?.status === 'connected'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1">
      {/* Remote Pairing */}
      <Panel collapsible defaultOpen={!isRemoteConnected}>
        <PanelHeader collapsible>
          <Smartphone className="h-3.5 w-3.5" />
          Remote
          {remoteStatus ? (
            <Badge variant={remoteTone(remoteStatus.status)} dot className="ml-auto">
              {remoteStatus.status}
            </Badge>
          ) : null}
        </PanelHeader>
        <PanelContent collapsible>
          <div className="space-y-3">
            <Input value={relayUrl} onChange={(event) => onRelayUrlChange(event.target.value)} />
            <Button
              type="button"
              size="sm"
              onClick={onStartPairing}
              disabled={isStartingRemote}
              className="w-full"
            >
              {isStartingRemote ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Smartphone className="h-3.5 w-3.5" />
              )}
              Start Pairing
            </Button>

            <div className="rounded-[var(--fd-radius-md)] bg-surface-2 px-3 py-2.5">
              <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                {remoteHeadline(remoteStatus?.status)}
              </p>
              <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                {remoteDescription(remoteStatus)}
              </p>
              <p className="mt-2 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-accent">
                E2E encrypted relay
              </p>
            </div>

            {pairingLink ? (
              <div className="space-y-2 rounded-[var(--fd-radius-lg)] bg-surface-2 p-3">
                <div className="flex justify-center rounded-[var(--fd-radius-lg)] bg-surface-0 p-4">
                  <QRCodeSVG value={pairingLink} size={140} bgColor="transparent" fgColor="#f0f5f1" />
                </div>
                <p className="break-all text-[length:var(--fd-text-2xs)] text-fg-muted">{pairingLink}</p>
                <div className="flex items-center justify-between text-[length:var(--fd-text-xs)]">
                  <span className="text-fg-muted">Code</span>
                  <span className="font-mono font-semibold text-fg-primary">
                    {remoteStatus?.pairing?.pairing_code}
                  </span>
                </div>
              </div>
            ) : null}

            {remoteStatus?.last_error ? (
              <div className="rounded-[var(--fd-radius-md)] border border-danger/20 bg-danger-muted px-3 py-2.5">
                <div className="flex items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Remote error
                </div>
                <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
                  {remoteStatus.last_error}
                </p>
              </div>
            ) : null}
          </div>
        </PanelContent>
      </Panel>

      {/* Approvals */}
      {approvals.length > 0 ? (
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
                  onAlwaysAllow={() => onApproval(approval.request_id, 'always_allow')}
                />
              ))}
            </div>
          </PanelContent>
        </Panel>
      ) : null}

      {/* Plan */}
      {thread?.latest_plan?.steps.length ? (
        <Panel collapsible defaultOpen>
          <PanelHeader collapsible>Plan</PanelHeader>
          <PanelContent collapsible>
            <div className="space-y-1">
              {thread.latest_plan.steps.map((step, index) => (
                <div key={`${step.step}-${index}`} className="flex items-center justify-between gap-2 text-[length:var(--fd-text-sm)]">
                  <span className="text-fg-primary">{step.step}</span>
                  <span className="text-[length:var(--fd-text-xs)] text-fg-muted">{step.status}</span>
                </div>
              ))}
            </div>
          </PanelContent>
        </Panel>
      ) : null}

      {/* Diff */}
      {thread?.latest_diff ? (
        <Panel collapsible defaultOpen={false}>
          <PanelHeader collapsible>Latest diff</PanelHeader>
          <PanelContent collapsible>
            <CodeBlock code={thread.latest_diff} language="diff" />
          </PanelContent>
        </Panel>
      ) : null}
    </div>
  )
}
