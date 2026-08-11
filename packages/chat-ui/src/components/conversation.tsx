import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  MessageSquare,
  ShieldQuestion,
} from "lucide-react";

import type {
  ConversationItem,
  ConversationRenderBlock,
  FalconDeckPreferences,
} from "@falcondeck/client-core";
import {
  advanceResponseCompletionTracker,
  deriveConversationPresentation,
  normalizePreferences,
  reuseConversationPresentation,
  reuseRetrySourcesByAssistantId,
  type ResponseCompletionTrackerState,
} from "@falcondeck/client-core";
import { ActivityDiamond, EmptyState, cn } from "@falcondeck/ui";

import { FileDiffProvider, type OpenFileDiff } from "../lib/file-diff-context";
import { ConversationExportButton } from "./conversation-export-button";
import {
  LiveActivityLane,
  MessageCard,
  ToolSummaryCard,
  WorkSessionCard,
} from "./message";

const AUTO_SCROLL_THRESHOLD = 40;
const JUMP_THRESHOLD = 200;
const MAX_THREAD_UI_STATE = 48;
// Keep the newest context fully laid out for streaming and bottom anchoring.
// Older blocks use browser-native layout/paint deferral once a transcript is
// long enough to benefit; `auto` retains find-in-page, focus, and accessibility.
const EAGER_RECENT_BLOCK_COUNT = 40;

type SavedScrollPosition = {
  scrollTop: number;
  stickToBottom: boolean;
};

type EditResendHandler = (
  item: Extract<ConversationItem, { kind: "user_message" }>,
) => void;

const ConversationHistoryRow = memo(function ConversationHistoryRow({
  block,
  deferred,
  expansionMode,
  thinkingDisplay,
  isStreamingReasoning,
  onEditResend,
  editResendUnavailableReason,
  retrySource,
  onRetryResponse,
}: {
  block: ConversationRenderBlock;
  deferred: boolean;
  expansionMode: "default" | "expanded" | "collapsed";
  thinkingDisplay: ReturnType<
    typeof normalizePreferences
  >["conversation"]["thinking_display"];
  isStreamingReasoning: boolean;
  onEditResend?: EditResendHandler;
  editResendUnavailableReason?: string | null;
  retrySource?: Extract<ConversationItem, { kind: "user_message" }> | null;
  onRetryResponse?: EditResendHandler;
}) {
  return (
    <div
      data-conversation-block-id={block.id}
      className={cn(
        "fd-conversation-block min-w-0",
        deferred && "fd-conversation-block--deferred",
      )}
    >
      {block.kind === "item" ? (
        <MessageCard
          item={block.item}
          defaultOpen={block.default_open}
          expansionMode={expansionMode}
          suppressReadOnlyDetail={block.suppress_read_only_detail}
          thinkingDisplay={thinkingDisplay}
          isStreamingReasoning={isStreamingReasoning}
          onEditResend={onEditResend}
          editResendUnavailableReason={editResendUnavailableReason}
          retrySource={
            block.item.kind === "assistant_message" ? retrySource : null
          }
          onRetryResponse={onRetryResponse}
        />
      ) : block.kind === "work_session" ? (
        <WorkSessionCard
          items={block.items}
          running={block.running}
          startedAt={block.started_at}
          completedAt={block.completed_at}
          expansionMode={expansionMode}
          thinkingDisplay={thinkingDisplay}
        />
      ) : (
        <ToolSummaryCard
          items={block.items}
          summary={block.summary}
          defaultOpen={block.default_open}
          expansionMode={expansionMode}
          suppressReadOnlyDetail={block.suppress_read_only_detail}
        />
      )}
    </div>
  );
});

function clampScrollTop(scrollTop: number, element: HTMLDivElement) {
  return Math.min(
    scrollTop,
    Math.max(0, element.scrollHeight - element.clientHeight),
  );
}

/** Pinned notice for a turn blocked on the user. The actionable card lives in
    the approval bar just below the transcript; this row makes the blocked
    state visible from within the conversation flow. */
function WaitingForApprovalNotice() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted"
    >
      <ShieldQuestion className="h-4 w-4 animate-pulse text-warning" />
      Waiting for approval — respond below to continue
    </div>
  );
}

export const Conversation = memo(function Conversation({
  threadKey = null,
  items,
  preferences = null,
  emptyState,
  isSending = false,
  sendingLabel = null,
  isThinking = false,
  isWaitingForInput = false,
  isLoading = false,
  hasOlder = false,
  isLoadingOlder = false,
  onLoadOlder,
  onOpenFile = null,
  onEditResend,
  editResendUnavailableReason = null,
  onRetryResponse,
  exportTitle = null,
  pinnedPlanId = null,
}: {
  threadKey?: string | null;
  items: ConversationItem[];
  preferences?: FalconDeckPreferences | null;
  emptyState?: React.ReactNode;
  /** A prompt has left the composer but the daemon has not surfaced agent
      activity yet. This optimistic state keeps slow transports responsive. */
  isSending?: boolean;
  /** Replaces the generic "Sending…" while a slower setup step runs first —
      e.g. "Setting up isolated copy…" during isolated-thread creation. */
  sendingLabel?: string | null;
  isThinking?: boolean;
  /** The turn is blocked on an approval or question. Renders a pinned notice
      so the thread can never look idle while the agent is waiting on the user. */
  isWaitingForInput?: boolean;
  isLoading?: boolean;
  /** Whether the daemon has history before the current oldest item. */
  hasOlder?: boolean;
  /** Whether an older history page is currently being fetched. */
  isLoadingOlder?: boolean;
  /** Requests the page immediately before the current oldest item. */
  onLoadOlder?: () => void;
  /** Opens a file's diff in the host's side panel; omit where there is none. */
  onOpenFile?: OpenFileDiff | null;
  onEditResend?: EditResendHandler;
  /** Thread-level explanation shown when provider-backed branching is unavailable. */
  editResendUnavailableReason?: string | null;
  onRetryResponse?: EditResendHandler;
  /** Human thread title used for the Markdown export heading and filename. */
  exportTitle?: string | null;
  /** Plan item shown in the pinned plan bar; skipped here so the current plan
      renders once. Export still includes it — it reads `items`, not the
      filtered list. */
  pinnedPlanId?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinToBottomFrameRef = useRef<number | null>(null);
  const scrollPositionsRef = useRef(new Map<string, SavedScrollPosition>());
  const activeThreadKeyRef = useRef<string | null>(threadKey);
  const lastRestoredThreadKeyRef = useRef<string | null>(null);
  const stickyToBottomRef = useRef(true);
  const prependAnchorRef = useRef<{
    blockId: string | null;
    blockTop: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [completionAnnouncement, setCompletionAnnouncement] = useState<{
    sequence: number;
    message: string;
  } | null>(null);
  const responseAnnouncementStateRef =
    useRef<ResponseCompletionTrackerState | null>(null);
  const [expansionMode, setExpansionMode] = useState<
    "default" | "expanded" | "collapsed"
  >("default");
  const presentationRef = useRef<ReturnType<
    typeof deriveConversationPresentation
  > | null>(null);
  const retrySourcesRef = useRef<ReturnType<
    typeof reuseRetrySourcesByAssistantId
  > | null>(null);
  // Unresolved requests live in the pinned approval bar, and the current plan
  // in the pinned plan bar — neither belongs in the transcript as well.
  // Reasoning stays in: it is rendered by the thinking-display rules below.
  const renderableItems = useMemo(
    () =>
      items.filter(
        (item) =>
          !(item.kind === "interactive_request" && !item.resolved) &&
          !(item.kind === "plan" && item.id === pinnedPlanId),
      ),
    [items, pinnedPlanId],
  );
  const normalizedPreferences = useMemo(
    () => normalizePreferences(preferences),
    [preferences],
  );
  const presentation = useMemo(() => {
    const next = deriveConversationPresentation(
      renderableItems,
      normalizedPreferences,
      {
        is_streaming: isThinking,
      },
    );
    const stable = reuseConversationPresentation(presentationRef.current, next);
    presentationRef.current = stable;
    return stable;
  }, [isThinking, normalizedPreferences, renderableItems]);
  const renderBlocks = presentation.history_blocks;
  const retrySources = useMemo(() => {
    if (!onRetryResponse) {
      retrySourcesRef.current = null;
      return null;
    }
    const stable = reuseRetrySourcesByAssistantId(
      retrySourcesRef.current,
      renderableItems,
    );
    retrySourcesRef.current = stable;
    return stable;
  }, [onRetryResponse, renderableItems]);
  const liveActivityGroups = presentation.live_activity_groups;
  // A running work-session block already shows its own "Working…" line, so
  // the standalone "Thinking…" indicator would be redundant next to it.
  const hasRunningWorkSession = renderBlocks.some(
    (block) => block.kind === "work_session" && block.running,
  );
  const thinkingDisplay = normalizedPreferences.conversation.thinking_display;
  // Only the trailing thought is still arriving; anything a later item follows
  // has finished, which is what `auto` keys its collapse off.
  const streamingReasoningId = useMemo(() => {
    if (!isThinking) return null;
    const last = renderableItems.at(-1);
    return last?.kind === "reasoning" ? last.id : null;
  }, [isThinking, renderableItems]);
  const hasHiddenOnlyItems = items.length > 0 && renderableItems.length === 0;
  const isBusy = isSending || isThinking;
  // "Ready for instructions" claims the thread is idle and empty, so any busy
  // signal outranks it: a just-submitted prompt hasn't echoed into `items` yet
  // (isSending covers that gap), a blocked turn is waiting on the user, and a
  // hydrating thread hasn't revealed whether it is empty at all.
  const showEmptyState =
    renderBlocks.length === 0 &&
    liveActivityGroups.length === 0 &&
    !hasHiddenOnlyItems &&
    !isBusy &&
    !isWaitingForInput &&
    !isLoading;

  useEffect(() => {
    const previousState = responseAnnouncementStateRef.current;
    const previousThreadKey = previousState?.threadKey;
    const responseStarted =
      previousState?.threadKey === threadKey &&
      !previousState.wasBusy &&
      isBusy;
    const result = advanceResponseCompletionTracker(previousState, {
      threadKey,
      busy: isBusy,
      ready: !isBusy && !isLoading && !isWaitingForInput,
      items: renderableItems,
    });
    responseAnnouncementStateRef.current = result.state;

    if (
      responseStarted ||
      (previousThreadKey !== undefined && previousThreadKey !== threadKey)
    ) {
      setCompletionAnnouncement(null);
    }
    if (result.completed) {
      setCompletionAnnouncement((current) => ({
        sequence: (current?.sequence ?? 0) + 1,
        message: "Response complete",
      }));
    }
  }, [isBusy, isLoading, isWaitingForInput, renderableItems, threadKey]);

  useEffect(() => {
    if (!threadKey) return;

    const savedPosition = scrollPositionsRef.current.get(threadKey);
    if (savedPosition) {
      scrollPositionsRef.current.delete(threadKey);
      scrollPositionsRef.current.set(threadKey, savedPosition);
    }

    while (scrollPositionsRef.current.size > MAX_THREAD_UI_STATE) {
      const oldestKey = scrollPositionsRef.current.keys().next().value;
      if (!oldestKey) break;
      scrollPositionsRef.current.delete(oldestKey);
    }
  }, [threadKey]);

  const persistScrollPosition = useCallback(
    (keyOverride?: string | null) => {
      const key = keyOverride ?? threadKey;
      const el = scrollRef.current;
      if (!key || !el) return;

      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      scrollPositionsRef.current.delete(key);
      scrollPositionsRef.current.set(key, {
        scrollTop: el.scrollTop,
        stickToBottom: distanceFromBottom <= AUTO_SCROLL_THRESHOLD,
      });
    },
    [threadKey],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    stickyToBottomRef.current = true;
    setShowJump(false);
    persistScrollPosition();
  }, [persistScrollPosition]);

  /// Pins to the bottom before the browser paints. Streaming must use this:
  /// deferring the scroll by even one frame paints the taller content at the
  /// old offset first, so every delta shows as a visible upward jump.
  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    stickyToBottomRef.current = true;
    if (threadKey) {
      scrollPositionsRef.current.delete(threadKey);
      scrollPositionsRef.current.set(threadKey, {
        scrollTop: el.scrollTop,
        stickToBottom: true,
      });
    }
  }, [threadKey]);

  /// Deferred pin, for thread switches only: restored content (images, code
  /// blocks, fonts) settles its height over the next couple of frames, so the
  /// final position is not knowable synchronously.
  const schedulePinToBottom = useCallback(() => {
    if (pinToBottomFrameRef.current !== null) {
      window.cancelAnimationFrame(pinToBottomFrameRef.current);
    }

    pinToBottomFrameRef.current = window.requestAnimationFrame(() => {
      pinToBottomFrameRef.current = window.requestAnimationFrame(() => {
        scrollToBottom();
        pinToBottomFrameRef.current = null;
      });
    });
  }, [scrollToBottom]);

  const restoreThreadPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const savedPosition = threadKey
      ? (scrollPositionsRef.current.get(threadKey) ?? null)
      : null;
    if (!savedPosition || savedPosition.stickToBottom) {
      scrollToBottom();
      schedulePinToBottom();
      return;
    }

    el.scrollTop = clampScrollTop(savedPosition.scrollTop, el);
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyToBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
    setShowJump(distanceFromBottom > JUMP_THRESHOLD);
    persistScrollPosition();
  }, [persistScrollPosition, schedulePinToBottom, scrollToBottom, threadKey]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
    stickyToBottomRef.current = isNearBottom;
    setShowJump(distanceFromBottom > JUMP_THRESHOLD);
    persistScrollPosition();
  }, [persistScrollPosition]);

  const loadOlder = useCallback(() => {
    if (!onLoadOlder || isLoadingOlder) return;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    const firstBlock =
      content?.querySelector<HTMLElement>("[data-conversation-block-id]") ??
      null;
    if (scroll) {
      prependAnchorRef.current = {
        blockId: firstBlock?.dataset.conversationBlockId ?? null,
        blockTop: firstBlock?.getBoundingClientRect().top ?? 0,
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
      };
    }
    onLoadOlder();
  }, [isLoadingOlder, onLoadOlder]);

  useEffect(() => {
    if (activeThreadKeyRef.current === threadKey) return;

    lastRestoredThreadKeyRef.current = null;
    activeThreadKeyRef.current = threadKey;
    setExpansionMode("default");
  }, [threadKey]);

  useLayoutEffect(() => {
    if (isLoading) return;
    if (lastRestoredThreadKeyRef.current === threadKey) return;

    restoreThreadPosition();
    lastRestoredThreadKeyRef.current = threadKey;
  }, [isLoading, restoreThreadPosition, threadKey]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!anchor || !scroll || !content) return;

    const anchoredBlock = anchor.blockId
      ? (Array.from(
          content.querySelectorAll<HTMLElement>("[data-conversation-block-id]"),
        ).find(
          (element) => element.dataset.conversationBlockId === anchor.blockId,
        ) ?? null)
      : null;
    const currentFirstBlock = content.querySelector<HTMLElement>(
      "[data-conversation-block-id]",
    );
    const heightDelta = scroll.scrollHeight - anchor.scrollHeight;
    const offsetDelta = anchoredBlock
      ? anchoredBlock.getBoundingClientRect().top - anchor.blockTop
      : heightDelta;

    const historyPrepended =
      currentFirstBlock?.dataset.conversationBlockId !== anchor.blockId;
    const needsAdjustment = anchoredBlock
      ? offsetDelta !== 0
      : heightDelta !== 0;

    if (needsAdjustment) {
      scroll.scrollTop = anchor.scrollTop + offsetDelta;
      stickyToBottomRef.current = false;
      persistScrollPosition();
      prependAnchorRef.current = null;
    } else if (historyPrepended) {
      // Native browser scroll anchoring may already have held the old block in
      // place. Clear our fallback without applying a second correction.
      prependAnchorRef.current = null;
    } else if (!isLoadingOlder) {
      // The request completed without adding a page (failure or end reached).
      prependAnchorRef.current = null;
    }
  }, [isLoadingOlder, persistScrollPosition, renderBlocks]);

  useLayoutEffect(() => {
    if (isLoading) return;
    if (!renderBlocks.length && !isBusy && !isWaitingForInput) return;
    // ResizeObserver below runs after layout and before paint. Avoid doing the
    // same forced scroll-height read twice on every streaming update.
    if (typeof ResizeObserver !== "undefined") return;

    if (!stickyToBottomRef.current) {
      persistScrollPosition();
      return;
    }

    pinToBottomNow();
  }, [
    isBusy,
    isLoading,
    isWaitingForInput,
    persistScrollPosition,
    renderBlocks,
    pinToBottomNow,
  ]);

  useEffect(() => {
    if (!threadKey || isLoading) return;

    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    // Resize callbacks are delivered after layout and before paint, so pin
    // synchronously here too — scheduling a frame would reintroduce the
    // paint-then-snap jitter for content that grows while streaming.
    const observer = new ResizeObserver(() => {
      if (!stickyToBottomRef.current) {
        persistScrollPosition();
        return;
      }

      pinToBottomNow();
    });
    observer.observe(content);

    return () => {
      observer.disconnect();
    };
  }, [isLoading, persistScrollPosition, pinToBottomNow, threadKey]);

  useEffect(() => {
    return () => {
      if (pinToBottomFrameRef.current !== null) {
        window.cancelAnimationFrame(pinToBottomFrameRef.current);
      }
    };
  }, []);

  const jumpToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <FileDiffProvider onOpenFile={onOpenFile}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            data-selectable
            role="log"
            aria-label="Conversation"
            aria-live="off"
            aria-busy={isBusy}
            className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
            onScroll={handleScroll}
          >
            <div
              ref={contentRef}
              data-conversation-transcript
              className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-3 pt-4 pb-10 md:px-6 md:pb-12"
            >
              {hasOlder && onLoadOlder ? (
                <div className="flex min-h-9 items-center justify-center px-1 pb-1">
                  <button
                    type="button"
                    onClick={loadOlder}
                    disabled={isLoadingOlder}
                    aria-label={
                      isLoadingOlder
                        ? "Loading earlier messages"
                        : "Load earlier messages"
                    }
                    className="fd-focus inline-flex min-h-8 items-center gap-2 rounded-full border border-border-subtle bg-surface-2 px-3 text-[length:var(--fd-text-xs)] font-medium text-fg-muted transition-colors hover:border-border-default hover:bg-surface-3 hover:text-fg-primary disabled:cursor-wait disabled:opacity-70"
                  >
                    {isLoadingOlder ? (
                      <ActivityDiamond />
                    ) : null}
                    {isLoadingOlder
                      ? "Loading earlier messages…"
                      : "Load earlier messages"}
                  </button>
                </div>
              ) : null}

              {showEmptyState ||
              (renderBlocks.length === 0 &&
                (isBusy || isWaitingForInput) &&
                liveActivityGroups.length === 0) ? (
                <div className="flex min-h-full flex-1 flex-col gap-3">
                  {showEmptyState
                    ? (emptyState ?? (
                        <EmptyState
                          icon={<MessageSquare className="h-6 w-6" />}
                          title="Ready for instructions"
                          description="Send a prompt to start a conversation."
                        />
                      ))
                    : null}
                  {isWaitingForInput && liveActivityGroups.length === 0 ? (
                    <WaitingForApprovalNotice />
                  ) : isBusy && liveActivityGroups.length === 0 ? (
                    <div
                      role="status"
                      className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted"
                    >
                      <ActivityDiamond size="md" />
                      {isSending ? (sendingLabel ?? "Sending…") : "Thinking…"}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {items.length > 0 ? (
                <div className="flex items-center justify-end gap-2 px-1">
                  {normalizedPreferences.conversation
                    .show_expand_all_controls ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setExpansionMode("expanded")}
                        className="fd-focus min-h-8 rounded-[var(--fd-radius-sm)] px-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-primary"
                      >
                        Expand all
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpansionMode("collapsed")}
                        className="fd-focus min-h-8 rounded-[var(--fd-radius-sm)] px-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-primary"
                      >
                        Collapse all
                      </button>
                    </>
                  ) : null}
                  <ConversationExportButton
                    items={items}
                    title={exportTitle}
                    partial={hasOlder}
                  />
                </div>
              ) : null}

              {renderBlocks.map((block, index) => (
                <ConversationHistoryRow
                  key={block.id}
                  block={block}
                  deferred={
                    index < renderBlocks.length - EAGER_RECENT_BLOCK_COUNT
                  }
                  expansionMode={expansionMode}
                  thinkingDisplay={thinkingDisplay}
                  isStreamingReasoning={
                    block.kind === "item" &&
                    block.item.id === streamingReasoningId
                  }
                  onEditResend={onEditResend}
                  editResendUnavailableReason={editResendUnavailableReason}
                  retrySource={
                    block.kind === "item" &&
                    block.item.kind === "assistant_message"
                      ? (retrySources?.get(block.item.id) ?? null)
                      : null
                  }
                  onRetryResponse={onRetryResponse}
                />
              ))}

              {/* A blocked turn outranks every indicator heuristic: whatever the
                transcript's tail looks like, the user must see that the agent
                is waiting on them. */}
              {renderBlocks.length > 0 && isWaitingForInput ? (
                <WaitingForApprovalNotice />
              ) : null}

              {/* Sending is purely optimistic, so show it even if stale live
                presentation data is still settling. A streaming thought
                already says "Thinking…" in its own header. */}
              {(renderBlocks.length > 0 || liveActivityGroups.length > 0) &&
              !isWaitingForInput &&
              (isSending ||
                (isThinking &&
                  liveActivityGroups.length === 0 &&
                  !hasRunningWorkSession &&
                  !streamingReasoningId)) ? (
                <div
                  role="status"
                  className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted"
                >
                  <ActivityDiamond size="md" />
                  {isSending ? (sendingLabel ?? "Sending…") : "Thinking…"}
                </div>
              ) : null}

              {/* In-flight tool activity renders in the thread flow, where the
                completed groups it becomes will also live. */}
              <LiveActivityLane groups={liveActivityGroups} />
            </div>
          </div>

          <div
            data-response-completion-announcer
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {completionAnnouncement ? (
              <span key={completionAnnouncement.sequence}>
                {completionAnnouncement.message}
              </span>
            ) : null}
          </div>

          {showJump ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3">
              <button
                type="button"
                onClick={jumpToBottom}
                aria-label="Jump to latest message"
                className="fd-focus pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border-default bg-surface-2 text-fg-muted shadow-md transition-colors hover:bg-surface-3 hover:text-fg-primary"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </FileDiffProvider>
  );
});
