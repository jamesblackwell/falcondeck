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
  Quote,
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
  latestVisibleAssistantMessageId,
  normalizePreferences,
  reuseConversationPresentation,
  reuseRetrySourcesByAssistantId,
  type ResponseCompletionTrackerState,
} from "@falcondeck/client-core";
import { ActivityDiamond, EmptyState, cn } from "@falcondeck/ui";

import { FileDiffProvider, type OpenFileDiff } from "../lib/file-diff-context";
import {
  LocalPathProvider,
  type LocalPathEditor,
  type LocalPathHandler,
  type LocalPathKindResolver,
} from "../lib/local-path-context";
import { normalizeQuotedSelection } from "../lib/quoted-selection";
import type { ReadAloudController } from "../lib/read-aloud";
import { WebLinkProvider, type WebLinkOpener } from "../lib/web-link-context";
import { ConversationExportButton } from "./conversation-export-button";
import {
  AGENT_STATUS_ROW_CLASS,
  LiveActivityLane,
  MessageCard,
  ToolSummaryCard,
  WorkSessionCard,
} from "./message";

const AUTO_SCROLL_THRESHOLD = 40;
const JUMP_THRESHOLD = 200;
const SMOOTH_SCROLL_DURATION_MS = 320;
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
  animateEnter,
  expansionMode,
  thinkingDisplay,
  collapseLongUserMessages,
  isStreamingReasoning,
  retrySource,
  onRetryResponse,
  readAloud,
  showReceivedAt,
}: {
  block: ConversationRenderBlock;
  deferred: boolean;
  /** Plays the slide-up entrance. Stays true for the whole mount once granted
      (the animation is one-shot anyway) so re-renders can't cancel it midway. */
  animateEnter: boolean;
  expansionMode: "default" | "expanded" | "collapsed";
  thinkingDisplay: ReturnType<
    typeof normalizePreferences
  >["conversation"]["thinking_display"];
  collapseLongUserMessages: boolean;
  isStreamingReasoning: boolean;
  retrySource?: Extract<ConversationItem, { kind: "user_message" }> | null;
  onRetryResponse?: EditResendHandler;
  readAloud?: ReadAloudController;
  showReceivedAt?: boolean;
}) {
  return (
    <div
      data-conversation-block-id={block.id}
      className={cn(
        "fd-conversation-block min-w-0",
        deferred && "fd-conversation-block--deferred",
        animateEnter && "fd-conversation-block--enter",
      )}
    >
      {block.kind === "item" ? (
        <MessageCard
          item={block.item}
          defaultOpen={block.default_open}
          expansionMode={expansionMode}
          suppressReadOnlyDetail={block.suppress_read_only_detail}
          thinkingDisplay={thinkingDisplay}
          collapseLongUserMessages={collapseLongUserMessages}
          isStreamingReasoning={isStreamingReasoning}
          retrySource={
            block.item.kind === "assistant_message" ? retrySource : null
          }
          onRetryResponse={onRetryResponse}
          readAloud={readAloud}
          showReceivedAt={showReceivedAt}
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
  onLocalPath = null,
  localPathEditors = null,
  describeLocalPath = null,
  onOpenExternalLink = null,
  onRetryResponse,
  exportTitle = null,
  pinnedPlanId = null,
  onQuoteSelection,
  readAloud,
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
  /** Opens or reveals an absolute local path; omit on clients without a local disk. */
  onLocalPath?: LocalPathHandler | null;
  /** Editors offered in the path context menu; omit where there is no local disk. */
  localPathEditors?: readonly LocalPathEditor[] | null;
  /** Reports file vs directory so the path menu can hide file-only actions. */
  describeLocalPath?: LocalPathKindResolver | null;
  /** Opens an external URL in the system browser; omit where links should
      keep native browser behaviour. */
  onOpenExternalLink?: WebLinkOpener | null;
  onRetryResponse?: EditResendHandler;
  /** Human thread title used for the Markdown export heading and filename. */
  exportTitle?: string | null;
  /** Plan item shown in the pinned plan bar; skipped here so the current plan
      renders once. Export still includes it — it reads `items`, not the
      filtered list. */
  pinnedPlanId?: string | null;
  /** Adds selected user/assistant message text to the host composer. */
  onQuoteSelection?: (text: string) => void;
  /** Shared playback controller for assistant-message Read Aloud actions. */
  readAloud?: ReadAloudController;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinToBottomFrameRef = useRef<number | null>(null);
  const scrollPositionsRef = useRef(new Map<string, SavedScrollPosition>());
  const activeThreadKeyRef = useRef<string | null>(threadKey);
  const readAloudRef = useRef(readAloud);
  const readAloudThreadKeyRef = useRef<string | null>(threadKey);
  const lastRestoredThreadKeyRef = useRef<string | null>(null);
  const stickyToBottomRef = useRef(true);
  const wasSendingRef = useRef(isSending);
  const smoothScrollFrameRef = useRef<number | null>(null);
  const prependAnchorRef = useRef<{
    blockId: string | null;
    blockTop: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const enterTrackerRef = useRef<{
    threadKey: string | null;
    hydrating: boolean;
    seenIds: Set<string>;
    enteringIds: Set<string>;
  } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [selectedExcerpt, setSelectedExcerpt] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);
  const [completionAnnouncement, setCompletionAnnouncement] = useState<{
    sequence: number;
    message: string;
  } | null>(null);
  const responseAnnouncementStateRef =
    useRef<ResponseCompletionTrackerState | null>(null);
  const [expansionMode, setExpansionMode] = useState<
    "default" | "expanded" | "collapsed"
  >("default");
  useEffect(() => {
    readAloudRef.current = readAloud;
  }, [readAloud]);
  useEffect(() => {
    if (readAloudThreadKeyRef.current !== threadKey) readAloud?.stop();
    readAloudThreadKeyRef.current = threadKey;
  }, [readAloud, threadKey]);
  useEffect(
    () => () => {
      readAloudRef.current?.stop();
    },
    [],
  );
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
  const lastAssistantMessageId = latestVisibleAssistantMessageId(renderBlocks);
  // A message sent into an on-screen thread slides up into place; everything
  // else must mount statically. Ids present at thread mount, arriving while
  // (or immediately after) history hydrates, or prepended by "load earlier"
  // are absorbed as seen — only user messages in the trailing run of unseen
  // blocks animate. Sets only grow while a thread stays mounted, so StrictMode
  // double-renders and memoized rows see a stable one-shot grant.
  let enterTracker = enterTrackerRef.current;
  if (!enterTracker || enterTracker.threadKey !== threadKey) {
    enterTracker = {
      threadKey,
      hydrating: isLoading,
      seenIds: new Set(renderBlocks.map((block) => block.id)),
      enteringIds: new Set<string>(),
    };
    enterTrackerRef.current = enterTracker;
  } else if (isLoading || enterTracker.hydrating) {
    enterTracker.hydrating = isLoading;
    for (const block of renderBlocks) enterTracker.seenIds.add(block.id);
  } else {
    let lastSeenIndex = -1;
    for (let index = renderBlocks.length - 1; index >= 0; index -= 1) {
      if (enterTracker.seenIds.has(renderBlocks[index].id)) {
        lastSeenIndex = index;
        break;
      }
    }
    for (let index = 0; index < renderBlocks.length; index += 1) {
      const block = renderBlocks[index];
      if (enterTracker.seenIds.has(block.id)) continue;
      enterTracker.seenIds.add(block.id);
      if (
        index > lastSeenIndex &&
        block.kind === "item" &&
        block.item.kind === "user_message"
      ) {
        enterTracker.enteringIds.add(block.id);
      }
    }
  }
  const enteringBlockIds = enterTracker.enteringIds;
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
  const collapseLongUserMessages =
    normalizedPreferences.conversation.collapse_long_user_messages;
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

  const cancelSmoothScroll = useCallback(() => {
    if (smoothScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(smoothScrollFrameRef.current);
    smoothScrollFrameRef.current = null;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    cancelSmoothScroll();
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    stickyToBottomRef.current = true;
    setShowJump(false);
    persistScrollPosition();
  }, [cancelSmoothScroll, persistScrollPosition]);

  /// Glides to the bottom instead of teleporting — for the send snap and the
  /// jump button, where the reader is watching. The target is re-read every
  /// frame so a tail that grows mid-glide is still caught, and following arms
  /// only on arrival, keeping the streaming pin from teleporting underneath a
  /// running glide. Wheel, touch, or a scrollbar grab cancels it — the glide
  /// must never wrestle the reader for the scroll position.
  const smoothScrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const target = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const from = el.scrollTop;
    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion || target() - from <= 1) {
      scrollToBottom();
      return;
    }

    cancelSmoothScroll();
    setShowJump(false);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / SMOOTH_SCROLL_DURATION_MS);
      const eased = 1 - (1 - t) ** 3;
      el.scrollTop = from + (target() - from) * eased;
      if (t < 1) {
        smoothScrollFrameRef.current = window.requestAnimationFrame(step);
        return;
      }
      smoothScrollFrameRef.current = null;
      stickyToBottomRef.current = true;
      persistScrollPosition();
    };
    smoothScrollFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelSmoothScroll, persistScrollPosition, scrollToBottom]);

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

    // A glide left over from the previous thread must not keep writing into
    // the restored position.
    cancelSmoothScroll();

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
  }, [
    cancelSmoothScroll,
    persistScrollPosition,
    schedulePinToBottom,
    scrollToBottom,
    threadKey,
  ]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A glide's own frame writes land here too; judging stickiness or the jump
    // button from those mid-flight positions would flash the button and record
    // a position the glide is about to leave. Arrival state is set by the
    // glide itself; user input cancels it first and re-enters normally.
    if (smoothScrollFrameRef.current !== null) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
    stickyToBottomRef.current = isNearBottom;
    setSelectedExcerpt(null);
    setShowJump(distanceFromBottom > JUMP_THRESHOLD);
    persistScrollPosition();
  }, [persistScrollPosition]);

  const captureSelectedExcerpt = useCallback(() => {
    if (!onQuoteSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectedExcerpt(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const elementForNode = (node: Node) =>
      node instanceof Element ? node : node.parentElement;
    const startContent = elementForNode(range.startContainer)?.closest(
      "[data-message-selectable-content]",
    );
    const endContent = elementForNode(range.endContainer)?.closest(
      "[data-message-selectable-content]",
    );
    if (!startContent || startContent !== endContent) {
      setSelectedExcerpt(null);
      return;
    }

    const text = normalizeQuotedSelection(selection.toString());
    const viewport = scrollRef.current?.parentElement;
    if (!text || !viewport) {
      setSelectedExcerpt(null);
      return;
    }
    const rangeRect = range.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const left = Math.min(
      Math.max(rangeRect.left + rangeRect.width / 2 - viewportRect.left, 64),
      Math.max(64, viewportRect.width - 64),
    );
    setSelectedExcerpt({
      text,
      left,
      top: Math.max(8, rangeRect.top - viewportRect.top - 44),
    });
  }, [onQuoteSelection]);

  useLayoutEffect(() => setSelectedExcerpt(null), [threadKey]);

  useEffect(() => {
    if (!selectedExcerpt) return;
    const dismissIfSelectionChanged = () => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        normalizeQuotedSelection(selection.toString()) !== selectedExcerpt.text
      ) {
        setSelectedExcerpt(null);
      }
    };
    const dismissOnResize = () => setSelectedExcerpt(null);
    document.addEventListener("selectionchange", dismissIfSelectionChanged);
    window.addEventListener("resize", dismissOnResize);
    return () => {
      document.removeEventListener(
        "selectionchange",
        dismissIfSelectionChanged,
      );
      window.removeEventListener("resize", dismissOnResize);
    };
  }, [selectedExcerpt]);

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

  // Sending re-arms bottom-following for a reader hovering just above the tail
  // (within the jump-button threshold, wider than the streaming stick), so
  // their own message lands in view; a reader deep in the history keeps their
  // place. Rising edge only — isSending holding true across a slow transport
  // must not fight someone who scrolls up mid-send.
  useLayoutEffect(() => {
    const wasSending = wasSendingRef.current;
    wasSendingRef.current = isSending;
    if (!isSending || wasSending) return;

    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > JUMP_THRESHOLD) return;

    smoothScrollToBottom();
  }, [isSending, smoothScrollToBottom]);

  useLayoutEffect(() => {
    if (isLoading) return;
    if (!renderBlocks.length && !isBusy && !isWaitingForInput) return;
    // ResizeObserver below runs after layout and before paint. Avoid doing the
    // same forced scroll-height read twice on every streaming update.
    if (typeof ResizeObserver !== "undefined") return;

    // A running glide already converges on the live bottom; teleporting from
    // under it would end the animation with a visible snap.
    if (!stickyToBottomRef.current || smoothScrollFrameRef.current !== null) {
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
    const scroll = scrollRef.current;
    if (!content || !scroll || typeof ResizeObserver === "undefined") return;

    // Resize callbacks are delivered after layout and before paint, so pin
    // synchronously here too — scheduling a frame would reintroduce the
    // paint-then-snap jitter for content that grows while streaming.
    // Observe the viewport as well as the transcript: a growing composer
    // shrinks clientHeight without changing content size, which would
    // otherwise leave a follower looking at a gap above the tail.
    const observer = new ResizeObserver(() => {
      if (!stickyToBottomRef.current || smoothScrollFrameRef.current !== null) {
        persistScrollPosition();
        return;
      }

      pinToBottomNow();
    });
    observer.observe(content);
    observer.observe(scroll);

    return () => {
      observer.disconnect();
    };
  }, [isLoading, persistScrollPosition, pinToBottomNow, threadKey]);

  // Any real scroll input takes the position back from a running glide.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const cancel = () => cancelSmoothScroll();
    el.addEventListener("wheel", cancel, { passive: true });
    el.addEventListener("touchstart", cancel, { passive: true });
    el.addEventListener("mousedown", cancel);
    return () => {
      el.removeEventListener("wheel", cancel);
      el.removeEventListener("touchstart", cancel);
      el.removeEventListener("mousedown", cancel);
    };
  }, [cancelSmoothScroll]);

  useEffect(() => {
    return () => {
      if (pinToBottomFrameRef.current !== null) {
        window.cancelAnimationFrame(pinToBottomFrameRef.current);
      }
      cancelSmoothScroll();
    };
  }, [cancelSmoothScroll]);

  const jumpToBottom = useCallback(() => {
    smoothScrollToBottom();
  }, [smoothScrollToBottom]);

  return (
    <FileDiffProvider onOpenFile={onOpenFile}>
      <WebLinkProvider onOpenLink={onOpenExternalLink}>
        <LocalPathProvider
          onLocalPath={onLocalPath}
          editors={localPathEditors ?? undefined}
          describePath={describeLocalPath}
        >
          <div className="fd-type-scope fd-scope-chat flex min-h-0 flex-1 flex-col">
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
                onMouseUp={captureSelectedExcerpt}
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
                      {isLoadingOlder ? <ActivityDiamond /> : null}
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
                        className={AGENT_STATUS_ROW_CLASS}
                      >
                        <ActivityDiamond />
                        <span className="font-medium">
                          {isSending ? (sendingLabel ?? "Sending…") : "Thinking…"}
                        </span>
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
                    animateEnter={enteringBlockIds.has(block.id)}
                    expansionMode={expansionMode}
                    thinkingDisplay={thinkingDisplay}
                    collapseLongUserMessages={collapseLongUserMessages}
                    isStreamingReasoning={
                      block.kind === "item" &&
                      block.item.id === streamingReasoningId
                    }
                    retrySource={
                      block.kind === "item" &&
                      block.item.kind === "assistant_message"
                        ? (retrySources?.get(block.item.id) ?? null)
                        : null
                    }
                    onRetryResponse={onRetryResponse}
                    readAloud={readAloud}
                    showReceivedAt={
                      block.kind === "item" &&
                      block.item.kind === "assistant_message" &&
                      block.item.id === lastAssistantMessageId
                    }
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
                    className={AGENT_STATUS_ROW_CLASS}
                  >
                    <ActivityDiamond />
                    <span className="font-medium">
                      {isSending ? (sendingLabel ?? "Sending…") : "Thinking…"}
                    </span>
                  </div>
                ) : null}

                {/* In-flight tool activity renders in the thread flow, where the
                  completed groups it becomes will also live. */}
                <LiveActivityLane groups={liveActivityGroups} />
              </div>
            </div>

            {selectedExcerpt ? (
              <button
                type="button"
                aria-label="Add selected text to chat"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onQuoteSelection?.(selectedExcerpt.text);
                  window.getSelection()?.removeAllRanges();
                  setSelectedExcerpt(null);
                }}
                className="fd-focus absolute z-30 inline-flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-border-default bg-surface-4 px-3 text-[length:var(--fd-text-sm)] font-medium text-fg-primary shadow-[var(--fd-shadow-lg)] transition-[transform,background-color] hover:scale-[1.03] hover:bg-surface-3"
                style={{ left: selectedExcerpt.left, top: selectedExcerpt.top }}
              >
                <Quote aria-hidden="true" className="h-3.5 w-3.5" />
                Add to chat
              </button>
            ) : null}

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
        </LocalPathProvider>
      </WebLinkProvider>
    </FileDiffProvider>
  );
});
