import { useMemo, type ComponentProps, type ReactNode } from 'react'

import { currentTurnPlan } from '@falcondeck/client-core'
import type {
  ConversationItem,
  FalconDeckPreferences,
  InteractiveRequest,
  InteractiveResponsePayload,
  RemoteStatusResponse,
  ServiceNotice,
  ThreadSummary,
  TrustedDevice,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import {
  Conversation,
  OperationalNotice,
  PlanBar,
  PromptInput,
  QueuedTurns,
  type OpenFileDiff,
} from '@falcondeck/chat-ui'

import { InteractiveRequestBar } from './InteractiveRequestBar'
import { ConversationFindBar } from './ConversationFindBar'
import { RemotePairingPopover } from './RemotePairingPopover'
import { SessionHeader } from './SessionHeader'

type DesktopConversationPaneProps = {
  selectedWorkspace: WorkspaceSummary | null
  selectedThread: ThreadSummary | null
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  remoteStatus: RemoteStatusResponse | null
  pairingLink: string | null
  isStartingRemote: boolean
  remoteControlsDisabled: boolean
  remoteControlsUnavailableReason: string | null
  conversationItems: ConversationItem[]
  preferences: FalconDeckPreferences | null
  conversationEmptyState: ReactNode
  isSending: boolean
  sendingLabel?: string | null
  isThreadDetailPending: boolean
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  onLoadOlderMessages?: () => void
  interactiveRequests: InteractiveRequest[]
  operationalNotice: ServiceNotice | null
  onDismissOperationalNotice: (noticeId: string) => void
  findRequestKey?: number
  onStartPairing: () => void
  onRevokeDevice?: (device: TrustedDevice) => void
  revokingDeviceId?: string | null
  onInteractiveResponse: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => void
  promptInputKey?: string
  promptInputProps: ComponentProps<typeof PromptInput>
  onRemoveQueuedTurn?: (queuedId: string) => void
  onSteerQueuedTurn?: (queuedId: string) => void
  onEditQueuedTurn?: (queuedId: string, text: string) => void
  canSteerQueuedTurn?: boolean
  onOpenFile?: OpenFileDiff | null
  headerControls?: ReactNode
  onNewThread?: () => void
  onEditResend?: (item: Extract<ConversationItem, { kind: 'user_message' }>) => void
  editResendUnavailableReason?: string | null
  onRetryResponse?: (item: Extract<ConversationItem, { kind: 'user_message' }>) => void
}

export function DesktopConversationPane({
  selectedWorkspace,
  selectedThread,
  selectedWorkspaceId,
  selectedThreadId,
  remoteStatus,
  pairingLink,
  isStartingRemote,
  remoteControlsDisabled,
  remoteControlsUnavailableReason,
  conversationItems,
  preferences,
  conversationEmptyState,
  isSending,
  sendingLabel = null,
  isThreadDetailPending,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  onLoadOlderMessages,
  interactiveRequests,
  operationalNotice,
  onDismissOperationalNotice,
  findRequestKey = 0,
  onStartPairing,
  onRevokeDevice,
  revokingDeviceId,
  onInteractiveResponse,
  promptInputKey,
  promptInputProps,
  onRemoveQueuedTurn,
  onSteerQueuedTurn,
  onEditQueuedTurn,
  canSteerQueuedTurn,
  onOpenFile,
  headerControls,
  onNewThread,
  onEditResend,
  editResendUnavailableReason,
  onRetryResponse,
}: DesktopConversationPaneProps) {
  // The live plan is pinned above the composer instead of scrolling away with
  // the rest of the turn; the transcript skips the same item.
  const pinnedPlan = useMemo(() => currentTurnPlan(conversationItems), [conversationItems])
  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-1">
      <SessionHeader
        workspace={selectedWorkspace}
        thread={selectedThread}
        onNewThread={onNewThread}
        compact
      >
        <RemotePairingPopover
          remoteStatus={remoteStatus}
          pairingLink={pairingLink}
          onStartPairing={onStartPairing}
          isStartingRemote={isStartingRemote}
          remoteControlsDisabled={remoteControlsDisabled}
          remoteControlsUnavailableReason={remoteControlsUnavailableReason}
          onRevokeDevice={onRevokeDevice}
          revokingDeviceId={revokingDeviceId}
        />
        {headerControls}
      </SessionHeader>
      {operationalNotice ? (
        <OperationalNotice notice={operationalNotice} onDismiss={onDismissOperationalNotice} />
      ) : null}
      <ConversationFindBar requestKey={findRequestKey} />
      <Conversation
        threadKey={
          selectedThreadId
            ? `${selectedWorkspaceId ?? 'workspace'}:${selectedThreadId}`
            : selectedWorkspaceId
        }
        items={conversationItems}
        exportTitle={selectedThread?.title}
        preferences={preferences}
        emptyState={conversationEmptyState}
        isSending={isSending}
        sendingLabel={sendingLabel}
        isThinking={selectedThread?.status === 'running'}
        isWaitingForInput={selectedThread?.status === 'waiting_for_input'}
        isLoading={isThreadDetailPending}
        hasOlder={hasOlderMessages}
        isLoadingOlder={isLoadingOlderMessages}
        onLoadOlder={onLoadOlderMessages}
        onOpenFile={onOpenFile}
        onEditResend={onEditResend}
        editResendUnavailableReason={editResendUnavailableReason}
        onRetryResponse={onRetryResponse}
        pinnedPlanId={pinnedPlan?.itemId ?? null}
      />
      {pinnedPlan ? <PlanBar plan={pinnedPlan.plan} threadKey={selectedThreadId} /> : null}
      <InteractiveRequestBar requests={interactiveRequests} onRespond={onInteractiveResponse} />
      {selectedThread && onRemoveQueuedTurn && onSteerQueuedTurn ? (
        <QueuedTurns
          queuedTurns={selectedThread.queued_turns}
          canSteer={canSteerQueuedTurn}
          onRemove={onRemoveQueuedTurn}
          onSteer={onSteerQueuedTurn}
          onEdit={onEditQueuedTurn}
        />
      ) : null}
      <PromptInput key={promptInputKey} {...promptInputProps} />
    </section>
  )
}
