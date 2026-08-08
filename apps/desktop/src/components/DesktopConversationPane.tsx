import type { ComponentProps, ReactNode } from 'react'

import type {
  ConversationItem,
  FalconDeckPreferences,
  InteractiveRequest,
  InteractiveResponsePayload,
  RemoteStatusResponse,
  ThreadSummary,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import { Conversation, PromptInput, QueuedTurns, type OpenFileDiff } from '@falcondeck/chat-ui'

import { InteractiveRequestBar } from './InteractiveRequestBar'
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
  isThreadDetailPending: boolean
  interactiveRequests: InteractiveRequest[]
  onStartPairing: () => void
  onInteractiveResponse: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => void
  promptInputProps: ComponentProps<typeof PromptInput>
  onRemoveQueuedTurn?: (queuedId: string) => void
  onSteerQueuedTurn?: (queuedId: string) => void
  onEditQueuedTurn?: (queuedId: string, text: string) => void
  canSteerQueuedTurn?: boolean
  onOpenFile?: OpenFileDiff | null
  headerControls?: ReactNode
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
  isThreadDetailPending,
  interactiveRequests,
  onStartPairing,
  onInteractiveResponse,
  promptInputProps,
  onRemoveQueuedTurn,
  onSteerQueuedTurn,
  onEditQueuedTurn,
  canSteerQueuedTurn,
  onOpenFile,
  headerControls,
}: DesktopConversationPaneProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-1">
      <SessionHeader workspace={selectedWorkspace} thread={selectedThread}>
        <RemotePairingPopover
          remoteStatus={remoteStatus}
          pairingLink={pairingLink}
          onStartPairing={onStartPairing}
          isStartingRemote={isStartingRemote}
          remoteControlsDisabled={remoteControlsDisabled}
          remoteControlsUnavailableReason={remoteControlsUnavailableReason}
        />
        {headerControls}
      </SessionHeader>
      <Conversation
        threadKey={
          selectedThreadId
            ? `${selectedWorkspaceId ?? 'workspace'}:${selectedThreadId}`
            : selectedWorkspaceId
        }
        items={conversationItems}
        preferences={preferences}
        emptyState={conversationEmptyState}
        isThinking={isSending || selectedThread?.status === 'running'}
        isLoading={isThreadDetailPending}
        onOpenFile={onOpenFile}
      />
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
      <PromptInput {...promptInputProps} />
    </section>
  )
}
