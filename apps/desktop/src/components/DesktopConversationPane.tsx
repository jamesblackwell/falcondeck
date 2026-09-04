import { useMemo, type ComponentProps, type ReactNode } from "react";

import {
  currentTurnPlan,
  wasTurnInterruptedByShutdown,
} from "@falcondeck/client-core";
import type {
  ComposerSuggestion,
  ComposerSuggestionOffer,
  ConversationItem,
  FalconDeckPreferences,
  InteractiveRequest,
  InteractiveResponsePayload,
  OperationalCondition,
  RemoteStatusResponse,
  ThreadSummary,
  TrustedDevice,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import {
  Conversation,
  GoalBubble,
  InterruptedTurnNotice,
  OperationalNotice,
  PlanBar,
  PromptInput,
  ComposerSuggestionPill,
  QueuedTurns,
  type LocalPathEditor,
  type LocalPathHandler,
  type LocalPathKindResolver,
  type OpenFileDiff,
  type WorkspaceFileResolver,
  type QuotedSelection,
  type ReadAloudController,
  type WebLinkOpener,
} from "@falcondeck/chat-ui";
import { CollapseRegion, useLastPresent } from "@falcondeck/ui";

import { InteractiveRequestBar } from "./InteractiveRequestBar";
import { ConversationFindBar } from "./ConversationFindBar";
import { RemotePairingPopover } from "./RemotePairingPopover";
import { SessionHeader } from "./SessionHeader";

type DesktopConversationPaneProps = {
  selectedWorkspace: WorkspaceSummary | null;
  selectedThread: ThreadSummary | null;
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  remoteStatus: RemoteStatusResponse | null;
  pairingLink: string | null;
  isStartingRemote: boolean;
  remoteControlsDisabled: boolean;
  remoteControlsUnavailableReason: string | null;
  conversationItems: ConversationItem[];
  preferences: FalconDeckPreferences | null;
  conversationEmptyState: ReactNode;
  isSending: boolean;
  sendingLabel?: string | null;
  isThreadDetailPending: boolean;
  hasOlderMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  interactiveRequests: InteractiveRequest[];
  operationalConditions: readonly OperationalCondition[];
  onDismissOperationalCondition: (condition: OperationalCondition) => void;
  findRequestKey?: number;
  onStartPairing: () => void;
  onRevokeDevice?: (device: TrustedDevice) => void;
  revokingDeviceId?: string | null;
  onInteractiveResponse: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => void;
  promptInputKey?: string;
  promptInputProps: ComponentProps<typeof PromptInput>;
  onRemoveQueuedTurn?: (queuedId: string) => void;
  onSteerQueuedTurn?: (queuedId: string) => void;
  onEditQueuedTurn?: (queuedId: string, text: string) => void;
  onReorderQueuedTurns?: (queuedIds: string[]) => void;
  composerSuggestions?: ComposerSuggestionOffer | null;
  onSubmitComposerSuggestion?: (suggestion: ComposerSuggestion) => void;
  onDismissComposerSuggestions?: () => void;
  queuedAttachmentBaseUrl?: string | null;
  canSteerQueuedTurn?: boolean;
  onOpenFile?: OpenFileDiff | null;
  /** Absolute checkout path, so absolute paths inside it open in the rail. */
  workspaceRoot?: string | null;
  resolveWorkspaceFile?: WorkspaceFileResolver | null;
  workspaceFilesVersion?: number;
  onLocalPath?: LocalPathHandler | null;
  /** Editors offered in the local path context menu (desktop only). */
  localPathEditors?: readonly LocalPathEditor[] | null;
  /** File/directory lookup that gates the menu's file-only actions. */
  describeLocalPath?: LocalPathKindResolver | null;
  /** Opens external links in the system browser (desktop only). */
  onOpenExternalLink?: WebLinkOpener | null;
  headerControls?: ReactNode;
  /** Sits at the head of the header's trailing group, before New. */
  headerLeadingControls?: ReactNode;
  onNewThread?: () => void;
  onRetryResponse?: (
    item: Extract<ConversationItem, { kind: "user_message" }>,
  ) => void;
  onContinueInterruptedTurn?: () => void;
  onDismissInterruptedTurn?: () => void;
  quotedSelections?: readonly QuotedSelection[];
  onQuoteSelection?: (text: string) => void;
  onRemoveQuotedSelection?: (selectionId: string) => void;
  readAloud?: ReadAloudController;
};

const NO_QUOTED_SELECTIONS: readonly QuotedSelection[] = [];

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
  operationalConditions,
  onDismissOperationalCondition,
  findRequestKey = 0,
  onStartPairing,
  onRevokeDevice,
  revokingDeviceId,
  onInteractiveResponse,
  promptInputKey,
  promptInputProps,
  headerLeadingControls,
  onRemoveQueuedTurn,
  onSteerQueuedTurn,
  onEditQueuedTurn,
  onReorderQueuedTurns,
  composerSuggestions,
  onSubmitComposerSuggestion,
  onDismissComposerSuggestions,
  queuedAttachmentBaseUrl,
  canSteerQueuedTurn,
  onOpenFile,
  workspaceRoot = null,
  resolveWorkspaceFile = null,
  workspaceFilesVersion = 0,
  onLocalPath,
  localPathEditors,
  describeLocalPath,
  onOpenExternalLink,
  headerControls,
  onNewThread,
  onRetryResponse,
  onContinueInterruptedTurn,
  onDismissInterruptedTurn,
  quotedSelections = NO_QUOTED_SELECTIONS,
  onQuoteSelection,
  onRemoveQuotedSelection,
  readAloud,
}: DesktopConversationPaneProps) {
  // The live plan is pinned above the composer instead of scrolling away with
  // the rest of the turn; the transcript skips the same item.
  const pinnedPlan = useMemo(
    () => currentTurnPlan(conversationItems),
    [conversationItems],
  );
  // Notices collapse rather than vanish, so the outgoing content has to
  // survive the frame where its source data goes away.
  const lastOperationalConditions = useLastPresent(
    operationalConditions.length > 0 ? operationalConditions : null,
  );
  const showInterruptedNotice = Boolean(
    selectedThread &&
    wasTurnInterruptedByShutdown(selectedThread) &&
    onContinueInterruptedTurn,
  );
  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-1">
      <SessionHeader
        workspace={selectedWorkspace}
        thread={selectedThread}
        onNewThread={onNewThread}
        leadingActions={headerLeadingControls}
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
      <CollapseRegion open={operationalConditions.length > 0}>
        {lastOperationalConditions?.length ? (
          <OperationalNotice
            conditions={lastOperationalConditions}
            onDismiss={onDismissOperationalCondition}
          />
        ) : null}
      </CollapseRegion>
      <CollapseRegion open={showInterruptedNotice}>
        {onContinueInterruptedTurn ? (
          <InterruptedTurnNotice
            onContinue={onContinueInterruptedTurn}
            onDismiss={onDismissInterruptedTurn}
            isContinuing={isSending}
          />
        ) : null}
      </CollapseRegion>
      <ConversationFindBar requestKey={findRequestKey} />
      <Conversation
        threadKey={
          selectedThreadId
            ? `${selectedWorkspaceId ?? "workspace"}:${selectedThreadId}`
            : selectedWorkspaceId
        }
        items={conversationItems}
        exportTitle={selectedThread?.title}
        preferences={preferences}
        emptyState={conversationEmptyState}
        isSending={isSending}
        sendingLabel={sendingLabel}
        isThinking={selectedThread?.status === "running"}
        isWaitingForInput={selectedThread?.status === "waiting_for_input"}
        isLoading={isThreadDetailPending}
        hasOlder={hasOlderMessages}
        isLoadingOlder={isLoadingOlderMessages}
        onLoadOlder={onLoadOlderMessages}
        onOpenFile={onOpenFile}
        workspaceRoot={workspaceRoot}
        resolveWorkspaceFile={resolveWorkspaceFile}
        workspaceFilesVersion={workspaceFilesVersion}
        onLocalPath={onLocalPath}
        localPathEditors={localPathEditors}
        describeLocalPath={describeLocalPath}
        onOpenExternalLink={onOpenExternalLink}
        onRetryResponse={onRetryResponse}
        pinnedPlanId={pinnedPlan?.itemId ?? null}
        onQuoteSelection={onQuoteSelection}
        readAloud={readAloud}
      />
      {pinnedPlan ? (
        <PlanBar plan={pinnedPlan.plan} threadKey={selectedThreadId} />
      ) : null}
      <InteractiveRequestBar
        requests={interactiveRequests}
        onRespond={onInteractiveResponse}
      />
      {selectedThread && onRemoveQueuedTurn && onSteerQueuedTurn ? (
        <QueuedTurns
          queuedTurns={selectedThread.queued_turns}
          canSteer={canSteerQueuedTurn}
          onRemove={onRemoveQueuedTurn}
          onSteer={onSteerQueuedTurn}
          onEdit={onEditQueuedTurn}
          onReorder={onReorderQueuedTurns}
          getAttachmentPreviewUrl={
            queuedAttachmentBaseUrl && selectedWorkspaceId && selectedThreadId
              ? (queuedId) =>
                  `${queuedAttachmentBaseUrl}/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/threads/${encodeURIComponent(selectedThreadId)}/queue/${encodeURIComponent(queuedId)}/attachment-preview`
              : undefined
          }
        />
      ) : null}
      {promptInputProps.goal?.goal ? (
        <GoalBubble
          goal={promptInputProps.goal.goal}
          provider={promptInputProps.goal.provider}
          onClearGoal={promptInputProps.goal.onClearGoal}
          onSetGoalStatus={promptInputProps.goal.onSetGoalStatus}
        />
      ) : null}
      {onSubmitComposerSuggestion && onDismissComposerSuggestions ? (
        <ComposerSuggestionPill
          offer={composerSuggestions ?? null}
          onSubmit={onSubmitComposerSuggestion}
          onDismiss={onDismissComposerSuggestions}
        />
      ) : null}
      <PromptInput
        key={promptInputKey}
        {...promptInputProps}
        quotedSelections={quotedSelections}
        onRemoveQuotedSelection={onRemoveQuotedSelection}
      />
    </section>
  );
}
