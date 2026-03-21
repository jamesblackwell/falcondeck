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
import { Conversation, PromptInput } from '@falcondeck/chat-ui'

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
  conversationItems: ConversationItem[]
  preferences: FalconDeckPreferences | null
  conversationEmptyState: ReactNode
  isSending: boolean
  isThreadDetailPending: boolean
  interactiveRequests: InteractiveRequest[]
  onStartPairing: () => void
  onRefreshRemoteStatus: () => void
  onInteractiveResponse: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => void
  promptInputProps: ComponentProps<typeof PromptInput>
}

export function DesktopConversationPane({
  selectedWorkspace,
  selectedThread,
  selectedWorkspaceId,
  selectedThreadId,
  remoteStatus,
  pairingLink,
  isStartingRemote,
  conversationItems,
  preferences,
  conversationEmptyState,
  isSending,
  isThreadDetailPending,
  interactiveRequests,
  onStartPairing,
  onRefreshRemoteStatus,
  onInteractiveResponse,
  promptInputProps,
}: DesktopConversationPaneProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-1">
      <SessionHeader workspace={selectedWorkspace} thread={selectedThread}>
        <RemotePairingPopover
          remoteStatus={remoteStatus}
          pairingLink={pairingLink}
          onStartPairing={onStartPairing}
          onRefreshStatus={onRefreshRemoteStatus}
          isStartingRemote={isStartingRemote}
        />
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
      />
      <InteractiveRequestBar requests={interactiveRequests} onRespond={onInteractiveResponse} />
      <PromptInput {...promptInputProps} />
    </section>
  )
}
