import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  ScrollView,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type TextInput,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { FlashList } from "@shopify/flash-list";
import { DrawerActions, useIsFocused } from "@react-navigation/native";
import { useDrawerStatus } from "@react-navigation/drawer";
import { useNavigation } from "expo-router";
import {
  composerProviderFor,
  composerSelectionFor,
  conversationRenderBlockType,
  defaultProvider,
  deriveComposerSuggestions,
  handoffBlockedReason,
  pendingHandoffContextNotice,
  imageAttachmentSendBlockReason,
  latestVisibleAssistantMessageId,
  isDaemonRpcReady,
  conversationOperationalConditions,
  orderedInteractiveRequestQueue,
  providerForThread,
  reuseRetrySourcesByAssistantId,
  resolvePersistedMode,
  resolvePermissionMode,
  resolveServiceTier,
  resolveModelOption,
  resolveThreadModelId,
  resolveReasoningEffort,
  threadComposerSelectionKey,
  STANDARD_SERVICE_TIER,
  validateImageAttachmentBudget,
  workspaceAgentCapabilities,
  threadAgentCapabilities,
  workspaceModels,
  workspaceCollaborationModes,
  workspaceProviderOptions,
  wasTurnInterruptedByShutdown,
  type AgentProvider,
  type ComposerSuggestion,
  type ConversationPresentation,
  type ConversationRenderBlock,
  type InteractiveResponsePayload,
} from "@falcondeck/client-core";
import { useOperationalNoticeStore } from "@/store/operational-notice-store";
import { useShallow } from "zustand/react/shallow";

import {
  useConnectionLogStore,
  useInteractiveRequests,
  useRelayStore,
  useSessionStore,
  useSelectedThread,
  useSelectedQueuedTurns,
  useSelectedThreadDetailError,
  useSelectedThreadHistory,
  useConversationItems,
  useSelectedWorkspace,
  useUIStore,
  openConnectionDebug,
  setConversationUpdatesPaused,
} from "@/store";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useInterruptTurn } from "@/hooks/useInterruptTurn";
import { useAutoMarkThreadRead } from "@/hooks/useAutoMarkThreadRead";
import { useThreadActions } from "@/hooks/useThreadActions";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useConversationPresentation } from "@/hooks/useRenderBlocks";
import { useScrollToBottom } from "@/hooks/useScrollToBottom";
import { useResponseCompletionAnnouncement } from "@/hooks/useResponseCompletionAnnouncement";
import { useSessionSyncStatus } from "@/hooks/useSessionSyncStatus";
import {
  Button,
  Text,
  EmptyState,
  ErrorBanner,
  LoadingState,
  ScrollEdge,
  SyncBanner,
} from "@/components/ui";
import {
  ChatInput,
  InteractiveRequestBanner,
  LiveActivityLane,
  MessageRouter,
  GoalBanner,
  InterruptedTurnNotice,
  ComposerSuggestionPill,
  ComposerSuggestionSheet,
  GoalSheet,
  JumpToBottomFab,
  TranscriptRefreshPill,
  QueuedTurns,
  ThinkingIndicator,
  OperationalNoticeBanner,
} from "@/components/chat";
import { ThreadOptionsSheet } from "@/components/navigation";
import { ThreadHeader } from "@/components/navigation/ThreadHeader";
import { estimatedFloatingHeaderHeight } from "@/components/navigation/FloatingHeader";
import { ConnectionDebugScreen } from "@/components/debug/ConnectionDebugScreen";
import { DemoBanner } from "@/features/demo/DemoBanner";
import {
  pasteImageInputFromClipboard,
  pickImageInputFromCamera,
  pickImageInputsFromLibrary,
} from "@/features/thread/imageInputs";
import {
  loadCachedModels,
  persistCachedModels,
} from "@/storage/model-catalog-cache";
import {
  getWorkspaceTitle,
  shouldShowThinkingIndicator,
} from "@/features/thread/threadScreen";
import {
  triggerAgentCompletionHaptic,
  triggerThreadSelectionHaptic,
} from "@/lib/haptics";
import { CONNECTION_COPY } from "@/lib/connection-copy";
import { sessionSendBlockReason } from "@/lib/session-status";
import { READING_MAX_WIDTH, useTabletLayout } from "@/hooks/useTabletLayout";
import { AnimationVisibility } from '@/components/ui/AnimationVisibility';

const keyExtractor = (block: ConversationRenderBlock) => block.id;
/** A one-line composer with its toolbar, before the dock has measured itself. */
const ESTIMATED_DOCK_HEIGHT = 112;

export default function HomeScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const navigation = useNavigation();
  const { hasPermanentSidebar, readingGutter } = useTabletLayout();
  // The full-width drawer covers the transcript but leaves it mounted.
  // Pause live item subscriptions so a streaming turn does not re-parse
  // Markdown under the sidebar; the store still applies events.
  // A sidebar that stays on screen covers nothing, so nothing pauses.
  const isDrawerOpen = useDrawerStatus() === "open";
  const pauseLiveTranscript = isDrawerOpen && !hasPermanentSidebar;

  const presentation: ConversationPresentation = useConversationPresentation({
    pause: pauseLiveTranscript,
  });
  const blocks = presentation.history_blocks;
  const liveActivityGroups = presentation.live_activity_groups;
  const interactiveRequests = useInteractiveRequests();
  const interactiveQueue = useMemo(
    () => orderedInteractiveRequestQueue(interactiveRequests),
    [interactiveRequests],
  );
  const activeInteractiveRequest = interactiveQueue[0] ?? null;
  const selectedThread = useSelectedThread();
  const selectedThreadHistory = useSelectedThreadHistory({
    pause: pauseLiveTranscript,
  });
  const selectedThreadDetailError = useSelectedThreadDetailError();
  const conversationItems = useConversationItems({ pause: pauseLiveTranscript });
  const workspace = useSelectedWorkspace();
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId);
  // Deliberately NOT `s.snapshot`: the store replaces that object on every
  // applied event batch, so subscribing to it re-rendered this whole screen at
  // relay frame rate for the four narrow fields actually read below.
  const hasSnapshot = useSessionStore((s) => !!s.snapshot);
  const operationalConditionSource = useSessionStore(
    (s) => s.snapshot?.operational_conditions,
  );
  const serviceNotices = useSessionStore((s) => s.snapshot?.service_notices);
  const extensionSnapshot = useSessionStore((s) => s.snapshot?.extensions);
  const dismissedConditionVersions = useOperationalNoticeStore((s) => s.dismissed);
  const dismissOperationalCondition = useOperationalNoticeStore((s) => s.dismiss);
  const operationalConditions = useMemo(
    () =>
      conversationOperationalConditions(
        operationalConditionSource,
        serviceNotices,
        selectedWorkspaceId,
        selectedThreadId,
        dismissedConditionVersions,
      ),
    [
      dismissedConditionVersions,
      selectedWorkspaceId,
      selectedThreadId,
      operationalConditionSource,
      serviceNotices,
    ],
  );
  const {
    connectionStatus,
    error,
    isEncrypted,
    machinePresence,
    sessionId,
  } = useRelayStore(
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      error: s.error,
      isEncrypted: s.isEncrypted,
      machinePresence: s.machinePresence,
      sessionId: s.sessionId,
    })),
  );
  const syncStatus = useSessionSyncStatus();
  // Connection detail is explicitly user-invoked from the header icon.
  const isConnectionDebugMounted = useConnectionLogStore((s) => s.visible);
  const daemonRpcReady = isDaemonRpcReady(machinePresence);
  const {
    attachments,
    draft,
    isSubmitting,
    persistedComposerSelections,
    selectedEffort,
    selectedModel,
    selectedPermissionMode,
    selectedCollaborationMode,
    selectedIsolation,
    selectedProvider,
    selectedSandboxMode,
    selectedServiceTier,
  } = useUIStore(
    useShallow((s) => ({
      attachments: s.attachments,
      draft: s.draft,
      isSubmitting: s.isSubmitting,
      persistedComposerSelections: s.persistedComposerSelections,
      selectedEffort: s.selectedEffort,
      selectedModel: s.selectedModel,
      selectedPermissionMode: s.selectedPermissionMode,
      selectedCollaborationMode: s.selectedCollaborationMode,
      selectedIsolation: s.selectedIsolation,
      selectedProvider: s.selectedProvider,
      selectedSandboxMode: s.selectedSandboxMode,
      selectedServiceTier: s.selectedServiceTier,
    })),
  );
  const {
    rememberComposerSelection,
    rememberWorkspaceProvider,
    setDraft,
    setSelectedModel,
    setSelectedEffort,
    setSelectedPermissionMode,
    setSelectedCollaborationMode,
    setSelectedIsolation,
    setSelectedProvider,
    setSelectedSandboxMode,
    setSelectedServiceTier,
    removeAttachment,
  } = useUIStore.getState();
  const {
    startThread,
    submitTurn,
    respondApproval,
    respondInteractive,
    loadThreadDetail,
    retryResponse,
    loadWorkspaceSkills,
    loadWorkspacePrompts,
    handoffToProvider,
    handoffPending,
  } = useSessionActions();
  const interruptTurn = useInterruptTurn();
  const {
    clearThreadGoal,
    editQueuedTurn,
    queuedTurnAttachmentPreview,
    removeQueuedTurn,
    setThreadGoal,
    setThreadMode,
    steerQueuedTurn,
  } = useThreadActions();
  const {
    listRef,
    showJumpButton,
    autoscrollToBottomThreshold,
    onContentSizeChange,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollEnd,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    resetScrollState,
    scrollToBottom,
    scrollToBottomIfFollowing,
    scrollToBottomIfNear,
  } = useScrollToBottom<ConversationRenderBlock>();
  // Validated against the window, unlike KeyboardAvoidingView, so the bogus
  // frame iOS reports while resuming with a focused composer cannot pad the
  // screen by its full height and stack the composer under the header.
  const keyboardInset = useKeyboardInset();
  const isKeyboardVisible = keyboardInset > 0;
  const { height: windowHeight } = useWindowDimensions();
  // The header and composer float over the transcript. Their measured
  // heights live in shared values so the list's spacers follow them on the
  // UI thread — typing a new line must not re-render this whole screen.
  const headerHeight = useSharedValue(estimatedFloatingHeaderHeight(insets.top));
  const dockHeight = useSharedValue(ESTIMATED_DOCK_HEIGHT + insets.bottom);
  const handleHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      headerHeight.set(event.nativeEvent.layout.height);
    },
    [headerHeight],
  );
  const handleDockLayout = useCallback(
    (event: LayoutChangeEvent) => {
      dockHeight.set(event.nativeEvent.layout.height);
    },
    [dockHeight],
  );
  // A pending question or plan never pushes the composer off the screen.
  const requestMaxHeight = Math.round(windowHeight * 0.42);
  const [appState, setAppState] = useState(AppState.currentState);
  const [detailLoadingThreadId, setDetailLoadingThreadId] = useState<
    string | null
  >(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isGoalSheetOpen, setIsGoalSheetOpen] = useState(false);
  const [isSuggestionSheetOpen, setIsSuggestionSheetOpen] = useState(false);
  // The offer each thread has waved away, by thread id. A new turn produces a
  // new offer key, so suggestions come back on their own; deliberately not
  // persisted, and bounded by the number of threads rather than by how many
  // times the user has dismissed something.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<
    Readonly<Record<string, string>>
  >({});
  const [isThreadOptionsOpen, setIsThreadOptionsOpen] = useState(false);
  const selectionSeedRef = useRef<string | null>(null);
  const composerInputRef = useRef<TextInput>(null);
  const retrySourcesRef = useRef<ReturnType<
    typeof reuseRetrySourcesByAssistantId
  > | null>(null);
  const previousThreadStateRef = useRef<{
    threadId: string | null;
    status: string | null;
    appState: string;
  } | null>(null);

  // Compute active provider: thread's provider if running, otherwise UI selection or workspace default
  const activeProvider: AgentProvider = selectedThread
    ? selectedThread.provider
    : (selectedProvider ?? defaultProvider(workspace));

  const providerOptions = useMemo(
    () => workspaceProviderOptions(workspace),
    [workspace],
  );
  const collaborationModes = workspaceCollaborationModes(workspace, activeProvider);

  useEffect(() => {
    setSelectedCollaborationMode(selectedThread?.agent.collaboration_mode_id ?? null);
  }, [selectedThread?.id, selectedThread?.agent.collaboration_mode_id, setSelectedCollaborationMode]);
  const handoffProviderOptions = useMemo(
    () =>
      selectedThread
        ? providerOptions.filter(
            (option) => option.provider !== selectedThread.provider,
          )
        : [],
    [providerOptions, selectedThread],
  );
  const handoffDisabledReason = handoffBlockedReason(selectedThread, {
    pending: handoffPending,
  });
  const handoffSourceThreadId = selectedThread?.handoff_from?.thread_id ?? null;
  const handoffSourceTitle = useSessionStore((s) =>
    handoffSourceThreadId
      ? (s.snapshot?.threads.find((entry) => entry.id === handoffSourceThreadId)
          ?.title ?? null)
      : null,
  );
  const handoffContextNotice = pendingHandoffContextNotice(
    selectedThread,
    handoffSourceTitle,
  );

  // Which mode pickers the composer shows, and whether a queued message can be
  // steered — both are per-provider, so they change with the active agent.
  const capabilities = useMemo(
    () => threadAgentCapabilities(workspace, activeProvider, selectedThread),
    [activeProvider, selectedThread, workspace],
  );
  const attachmentSendBlockReason = imageAttachmentSendBlockReason(
    capabilities,
    attachments,
  );
  const queuedTurns = useSelectedQueuedTurns();
  const composerSuggestionOffer = useMemo(() => {
    const offer = deriveComposerSuggestions(
      extensionSnapshot,
      selectedThreadId,
      selectedThread?.status,
    );
    if (!offer || !selectedThreadId) return offer;
    return dismissedSuggestions[selectedThreadId] === offer.key ? null : offer;
  }, [
    dismissedSuggestions,
    selectedThread?.status,
    selectedThreadId,
    extensionSnapshot,
  ]);
  // A chosen suggestion is its own turn: it submits the offered prompt and
  // leaves whatever the user was drafting untouched.
  const handleSubmitComposerSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      scrollToBottomIfNear();
      void submitTurn({ text: suggestion.prompt });
    },
    [scrollToBottomIfNear, submitTurn],
  );
  const handleContinueInterruptedTurn = useCallback(() => {
    void submitTurn({ text: "", resumeInterrupted: true });
  }, [submitTurn]);
  const handleDismissInterruptedTurn = useCallback(() => {
    const session = useSessionStore.getState();
    const workspaceId = session.selectedWorkspaceId;
    const threadId = session.selectedThreadId;
    if (!workspaceId || !threadId) return;
    void useRelayStore
      .getState()
      ._callRpc(
        "thread.update",
        {
          workspace_id: workspaceId,
          thread_id: threadId,
          acknowledge_interruption: true,
        },
        { requestIdPrefix: "mobile-thread" },
      )
      .catch(() => {});
  }, []);
  const handleDismissComposerSuggestions = useCallback(() => {
    const key = composerSuggestionOffer?.key;
    if (!key || !selectedThreadId) return;
    setDismissedSuggestions((current) => ({
      ...current,
      [selectedThreadId]: key,
    }));
  }, [composerSuggestionOffer?.key, selectedThreadId]);
  // A goal belongs to a thread, so there is nothing to set one on until one
  // exists — same gate as desktop.
  const showGoalControl = Boolean(workspace) && capabilities.supports_goals;
  const canRetryResponse = Boolean(
    selectedThread &&
    capabilities.supports_forking &&
    !selectedThread.variant &&
    selectedThread.status !== "running" &&
    selectedThread.status !== "waiting_for_input",
  );
  // Render-only structural sharing keeps this lookup stable while only an
  // assistant tail streams. React has no previous-value useMemo primitive;
  // the helper validates all source identities before returning the cache.
  /* eslint-disable react-hooks/refs */
  const retrySources = useMemo(() => {
    if (!canRetryResponse) {
      retrySourcesRef.current = null;
      return null;
    }
    const stable = reuseRetrySourcesByAssistantId(
      retrySourcesRef.current,
      conversationItems,
    );
    retrySourcesRef.current = stable;
    return stable;
  }, [canRetryResponse, conversationItems]);
  /* eslint-enable react-hooks/refs */
  const lastAssistantMessageId = latestVisibleAssistantMessageId(blocks);
  const renderBlock = useCallback(
    ({ item }: { item: ConversationRenderBlock }) => (
      <MessageRouter
        item={item}
        onApprovalDecision={respondApproval}
        canRetryResponse={canRetryResponse}
        retrySource={
          item.kind === "item" && item.item.kind === "assistant_message"
            ? (retrySources?.get(item.item.id) ?? null)
            : null
        }
        onRetryResponse={retryResponse}
        showReceivedAt={
          item.kind === "item" &&
          item.item.kind === "assistant_message" &&
          item.item.id === lastAssistantMessageId
        }
      />
    ),
    [
      canRetryResponse,
      lastAssistantMessageId,
      respondApproval,
      retryResponse,
      retrySources,
    ],
  );

  // Filter models by active provider (matches desktop behavior)
  const models = useMemo(
    () => workspaceModels(workspace, activeProvider),
    [activeProvider, workspace],
  );

  // While the live catalog is empty, fall back to the last known list for
  // this workspace+provider so the pickers are usable immediately. Fresh
  // non-empty lists always win and refresh the cache.
  const cachedModels = useMemo(
    () =>
      workspace && models.length === 0
        ? loadCachedModels(workspace.id, activeProvider)
        : [],
    [activeProvider, models.length, workspace],
  );
  const effectiveModels = models.length > 0 ? models : cachedModels;

  useEffect(() => {
    if (workspace && models.length > 0) {
      persistCachedModels(workspace.id, activeProvider, models);
    }
  }, [activeProvider, models, workspace]);

  // Compute effort options from the selected model's supported_reasoning_efforts
  const resolvedModel = useMemo(
    () => resolveModelOption(effectiveModels, selectedModel, activeProvider),
    [effectiveModels, selectedModel, activeProvider],
  );

  const effortOptions = useMemo(() => {
    const supported =
      resolvedModel?.supported_reasoning_efforts.map(
        (e) => e.reasoning_effort,
      ) ?? [];
    if (supported.length > 0) return supported;
    if (resolvedModel?.default_reasoning_effort)
      return [resolvedModel.default_reasoning_effort];
    // Models without advertised reasoning support have no effort picker.
    return [];
  }, [resolvedModel]);
  const isThreadRunning = selectedThread?.status === "running";
  const showThinking = shouldShowThinkingIndicator(
    presentation,
    isThreadRunning,
    isSubmitting && selectedThread?.status !== "waiting_for_input",
  );
  const isSelectedThreadLoading =
    !!selectedThreadId && detailLoadingThreadId === selectedThreadId;
  const isRefreshingSelectedThread =
    isSelectedThreadLoading && blocks.length > 0;

  // One soft pulse when the currently viewed agent turn finishes. Watching
  // the summary transition keeps this independent of token/tool events and
  // prevents replayed relay updates from producing notification spam.
  useEffect(() => {
    const status = selectedThread?.status ?? null;
    const previous = previousThreadStateRef.current;
    if (
      previous?.appState === "active" &&
      appState === "active" &&
      previous.threadId === selectedThreadId &&
      previous.status === "running" &&
      status === "idle"
    ) {
      triggerAgentCompletionHaptic();
    }
    previousThreadStateRef.current = {
      threadId: selectedThreadId,
      status,
      appState,
    };
  }, [appState, selectedThread?.status, selectedThreadId]);

  useResponseCompletionAnnouncement({
    threadKey: selectedThreadId,
    status: selectedThread?.status ?? null,
    items: conversationItems,
    appState,
  });

  // True during initial sync: session exists but snapshot hasn't loaded yet
  const isSyncing = !!sessionId && !hasSnapshot;

  // Transport loss gates sending, not drafting. A saved workspace is enough
  // to focus and edit the composer while relay encryption reconnects.
  const isComposerEnabled = !!workspace;

  // A new conversation focuses the composer so typing can start immediately.
  // Existing threads keep the keyboard down for reading. The short delay lets
  // the drawer-close/navigation animation finish before the keyboard rises.
  useEffect(() => {
    if (selectedThreadId || !isComposerEnabled) return;
    const timer = setTimeout(() => composerInputRef.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [isComposerEnabled, selectedThreadId]);

  // Seed provider/model/effort/mode from the current workspace selection.
  useEffect(() => {
    if (!workspace) {
      selectionSeedRef.current = null;
      setSelectedProvider(null);
      setSelectedModel(null);
      setSelectedEffort("medium");
      setSelectedServiceTier(null);
      setSelectedPermissionMode(null);
      setSelectedSandboxMode(null);
      return;
    }

    const seedKey = threadComposerSelectionKey(workspace.id, selectedThread);
    if (selectionSeedRef.current === seedKey) return;
    selectionSeedRef.current = seedKey;

    // An existing thread dictates its own provider; a new conversation starts
    // from the provider the user last picked here, so that choice sticks.
    const stickyProvider = composerProviderFor(
      persistedComposerSelections,
      workspace.path,
    );
    const nextProvider =
      !selectedThread &&
      stickyProvider &&
      workspaceProviderOptions(workspace).some(
        (option) => option.provider === stickyProvider,
      )
        ? stickyProvider
        : providerForThread(selectedThread, workspace);
    const preferredSelection = composerSelectionFor(
      persistedComposerSelections,
      workspace.path,
      nextProvider,
    );

    // A thread owns its modes; a new conversation gets the remembered choice
    // as long as the provider still offers it.
    const seededCapabilities = workspaceAgentCapabilities(
      workspace,
      nextProvider,
    );
    setSelectedPermissionMode(
      selectedThread
        ? (selectedThread.agent.permission_mode ?? null)
        : resolvePermissionMode(
            preferredSelection?.permissionMode,
            seededCapabilities.permission_modes,
          ),
    );
    setSelectedSandboxMode(
      selectedThread
        ? (selectedThread.agent.sandbox_mode ?? null)
        : resolvePersistedMode(
            preferredSelection?.sandboxMode,
            seededCapabilities.sandbox_modes,
          ),
    );

    setSelectedProvider(nextProvider);
    const providerModels = workspaceModels(workspace, nextProvider);
    const fallbackModel = resolveThreadModelId(
      selectedThread, workspace, preferredSelection?.modelId, nextProvider,
    );
    const fallbackModelSummary = resolveModelOption(providerModels, fallbackModel, nextProvider);
    setSelectedModel(fallbackModel);
    setSelectedEffort(resolveReasoningEffort(
      selectedThread, workspace, fallbackModel, preferredSelection?.effort, nextProvider,
    ));
    if (selectedThread) {
      setSelectedServiceTier(resolveServiceTier(
        selectedThread.agent.service_tier, fallbackModelSummary,
      ));
      return;
    }
    // Threads keep the tier they last ran with; new conversations take the
    // remembered choice, falling back to the model catalog's default tier.
    setSelectedServiceTier(
      resolveServiceTier(
        preferredSelection?.serviceTier ??
          fallbackModelSummary?.default_service_tier,
        fallbackModelSummary,
      ),
    );
  }, [
    persistedComposerSelections,
    selectedThread,
    setSelectedEffort,
    setSelectedModel,
    setSelectedPermissionMode,
    setSelectedProvider,
    setSelectedSandboxMode,
    setSelectedServiceTier,
    workspace,
  ]);

  // Reset effort when it's no longer valid for the current model
  useEffect(() => {
    if (effortOptions.length === 0 || selectedEffort === null ||
      (selectedThread && selectedModel === selectedThread.agent.model_id &&
        selectedEffort === selectedThread.agent.reasoning_effort)) return;
    if (!selectedEffort || !effortOptions.includes(selectedEffort)) {
      const fallback =
        resolvedModel?.default_reasoning_effort ?? effortOptions[0] ?? "medium";
      setSelectedEffort(fallback);
    }
  }, [effortOptions, resolvedModel, selectedEffort, selectedModel, selectedThread, setSelectedEffort]);

  // Optional providers start lazily in the daemon; a composer aimed at one
  // is the signal to warm its runtime so the model list fills in. A
  // new-thread composer always warms; an existing thread warms only while
  // its provider's live catalog is empty (ACP catalogs are not persisted,
  // so a handoff destination or a thread opened after a daemon restart
  // would otherwise offer no models until its first turn).
  const hydratedProvidersRef = useRef(new Set<string>());
  const composerProvider = selectedThread?.provider ?? selectedProvider;
  const liveCatalogEmpty = models.length === 0;
  useEffect(() => {
    if (!workspace || !composerProvider) return;
    if (selectedThread && !liveCatalogEmpty) return;
    if (!isEncrypted || !daemonRpcReady) return;
    const key = `${workspace.id}:${composerProvider}`;
    if (hydratedProvidersRef.current.has(key)) return;
    hydratedProvidersRef.current.add(key);
    void useRelayStore
      .getState()
      ._callRpc("provider.hydrate", {
        workspace_id: workspace.id,
        provider: composerProvider,
      })
      .catch(() => {});
  }, [
    composerProvider,
    daemonRpcReady,
    isEncrypted,
    liveCatalogEmpty,
    selectedThread,
    workspace,
  ]);

  const handleProviderChange = useCallback(
    (provider: AgentProvider) => {
      if (selectedThread) return; // locked
      setSelectedProvider(provider);
      setSelectedCollaborationMode(null);
      if (workspace) rememberWorkspaceProvider(workspace.path, provider);
      // Swap in the new provider's remembered model/effort/modes rather than
      // resetting; the seed and validity effects clean up anything stale.
      const preferredSelection = composerSelectionFor(
        persistedComposerSelections,
        workspace?.path,
        provider,
      );
      const providerModels = workspaceModels(workspace, provider);
      setSelectedModel(
        preferredSelection?.modelId &&
          providerModels.some(
            (model) => model.id === preferredSelection.modelId,
          )
          ? preferredSelection.modelId
          : null,
      );
      setSelectedEffort(preferredSelection?.effort ?? null);
      const providerCapabilities = workspaceAgentCapabilities(
        workspace,
        provider,
      );
      setSelectedPermissionMode(
        resolvePermissionMode(
          preferredSelection?.permissionMode,
          providerCapabilities.permission_modes,
        ),
      );
      setSelectedSandboxMode(
        resolvePersistedMode(
          preferredSelection?.sandboxMode,
          providerCapabilities.sandbox_modes,
        ),
      );
      const providerDefaultModel =
        providerModels.find(
          (model) => model.id === preferredSelection?.modelId,
        ) ??
        providerModels.find((model) => model.is_default) ??
        providerModels[0] ??
        null;
      setSelectedServiceTier(
        resolveServiceTier(
          preferredSelection?.serviceTier ??
            providerDefaultModel?.default_service_tier,
          providerDefaultModel,
        ),
      );
    },
    [
      persistedComposerSelections,
      rememberWorkspaceProvider,
      selectedThread,
      setSelectedEffort,
      setSelectedModel,
      setSelectedPermissionMode,
      setSelectedProvider,
      setSelectedCollaborationMode,
      setSelectedSandboxMode,
      setSelectedServiceTier,
      workspace,
    ],
  );

  const handleModelChange = useCallback(
    (modelId: string | null) => {
      setSelectedModel(modelId);
      if (workspace && modelId) {
        rememberComposerSelection(workspace.path, activeProvider, { modelId });
      }
    },
    [activeProvider, rememberComposerSelection, setSelectedModel, workspace],
  );

  const handleEffortChange = useCallback(
    (effort: string | null) => {
      setSelectedEffort(effort);
      if (workspace && effort) {
        rememberComposerSelection(workspace.path, activeProvider, { effort });
      }
    },
    [activeProvider, rememberComposerSelection, setSelectedEffort, workspace],
  );

  const handleCollaborationModeChange = useCallback(
    (mode: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) {
        setSelectedCollaborationMode(mode);
        return;
      }
      void setThreadMode(selectedWorkspaceId, selectedThreadId, "collaboration_mode_id", mode)
        .then(() => {
          const selection = useSessionStore.getState();
          if (selection.selectedWorkspaceId === selectedWorkspaceId && selection.selectedThreadId === selectedThreadId) {
            setSelectedCollaborationMode(mode);
          }
        })
        .catch(() => {});
    },
    [selectedWorkspaceId, selectedThreadId, setSelectedCollaborationMode, setThreadMode],
  );

  // Local state moves first so the chip responds to the tap; with a thread
  // selected the choice is also persisted, matching desktop. Before the thread
  // exists there is nothing to persist to — submitTurn carries it instead.
  const handlePermissionModeChange = useCallback(
    (mode: string | null) => {
      setSelectedPermissionMode(mode);
      if (workspace) {
        rememberComposerSelection(workspace.path, activeProvider, {
          permissionMode: mode ?? "default",
        });
      }
      if (!selectedWorkspaceId || !selectedThreadId) return;
      void setThreadMode(
        selectedWorkspaceId,
        selectedThreadId,
        "permission_mode",
        mode,
      ).catch(() => {});
    },
    [
      activeProvider,
      rememberComposerSelection,
      selectedThreadId,
      selectedWorkspaceId,
      setSelectedPermissionMode,
      setThreadMode,
      workspace,
    ],
  );

  const handleSandboxModeChange = useCallback(
    (mode: string | null) => {
      setSelectedSandboxMode(mode);
      if (workspace) {
        rememberComposerSelection(workspace.path, activeProvider, {
          sandboxMode: mode,
        });
      }
      if (!selectedWorkspaceId || !selectedThreadId) return;
      void setThreadMode(
        selectedWorkspaceId,
        selectedThreadId,
        "sandbox_mode",
        mode,
      ).catch(() => {});
    },
    [
      activeProvider,
      rememberComposerSelection,
      selectedThreadId,
      selectedWorkspaceId,
      setSelectedSandboxMode,
      setThreadMode,
      workspace,
    ],
  );

  const handleServiceTierChange = useCallback(
    (tier: string | null) => {
      setSelectedServiceTier(tier);
      if (workspace) {
        // Turning fast off is an explicit choice, distinct from never having
        // touched the toggle — only the latter follows the catalog default.
        rememberComposerSelection(workspace.path, activeProvider, {
          serviceTier: tier ?? STANDARD_SERVICE_TIER,
        });
      }
      if (!selectedWorkspaceId || !selectedThreadId) return;
      void setThreadMode(
        selectedWorkspaceId,
        selectedThreadId,
        "service_tier",
        tier ?? STANDARD_SERVICE_TIER,
      ).catch(() => {});
    },
    [
      activeProvider,
      rememberComposerSelection,
      selectedThreadId,
      selectedWorkspaceId,
      setSelectedServiceTier,
      setThreadMode,
      workspace,
    ],
  );

  const handleRemoveQueuedTurn = useCallback(
    (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve();
      return removeQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId);
    },
    [removeQueuedTurn, selectedThreadId, selectedWorkspaceId],
  );

  const handleSteerQueuedTurn = useCallback(
    (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve();
      return steerQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId);
    },
    [selectedThreadId, selectedWorkspaceId, steerQueuedTurn],
  );

  const handleEditQueuedTurn = useCallback(
    (queuedId: string, text: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve();
      return editQueuedTurn(
        selectedWorkspaceId,
        selectedThreadId,
        queuedId,
        text,
      );
    },
    [editQueuedTurn, selectedThreadId, selectedWorkspaceId],
  );

  const handleQueuedTurnAttachmentPreview = useCallback(
    (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve(null);
      return queuedTurnAttachmentPreview(
        selectedWorkspaceId,
        selectedThreadId,
        queuedId,
      );
    },
    [queuedTurnAttachmentPreview, selectedThreadId, selectedWorkspaceId],
  );

  const handleSetGoal = useCallback(
    async (objective: string, tokenBudget: number | null) => {
      if (!selectedWorkspaceId) throw new Error("Select a project first");
      const threadId = selectedThreadId ?? (await startThread()).thread.id;
      return setThreadGoal(selectedWorkspaceId, threadId, {
        objective,
        token_budget: tokenBudget,
      });
    },
    [selectedThreadId, selectedWorkspaceId, setThreadGoal, startThread],
  );

  const handleClearGoal = useCallback(() => {
    if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve();
    return clearThreadGoal(selectedWorkspaceId, selectedThreadId);
  }, [clearThreadGoal, selectedThreadId, selectedWorkspaceId]);

  const handleSetGoalStatus = useCallback(
    (status: "active" | "paused") => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve();
      return setThreadGoal(selectedWorkspaceId, selectedThreadId, { status });
    },
    [selectedThreadId, selectedWorkspaceId, setThreadGoal],
  );

  const handleDismissError = useCallback(() => {
    useRelayStore.getState()._setError(null);
  }, []);

  const handleOpenDrawer = useCallback(() => {
    triggerThreadSelectionHaptic();
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  const handleOpenThreadOptions = useCallback(() => {
    setIsThreadOptionsOpen(true);
  }, []);

  const handleCloseThreadOptions = useCallback(() => {
    setIsThreadOptionsOpen(false);
  }, []);

  const handleNewThreadFromCurrent = useCallback(async () => {
    if (!workspace) return;

    if (workspace.kind === "casual") {
      try {
        const next = await useRelayStore
          .getState()
          ._callRpc<{ id: string }>("chat.create", { create: true });
        triggerThreadSelectionHaptic();
        useSessionStore.getState().selectNewThread(next.id);
      } catch (error) {
        useRelayStore
          .getState()
          ._setError(error instanceof Error ? error.message : "Failed to create chat");
      }
      return;
    }

    // Keep the current project and agent setup, but start with an empty transcript.
    rememberWorkspaceProvider(workspace.path, activeProvider);
    rememberComposerSelection(workspace.path, activeProvider, {
      modelId: selectedModel,
      effort: selectedEffort,
      permissionMode: selectedPermissionMode,
      sandboxMode: selectedSandboxMode,
    });
    setIsGoalSheetOpen(false);
    triggerThreadSelectionHaptic();
    useSessionStore.getState().selectNewThread(workspace.id);
  }, [
    activeProvider,
    rememberComposerSelection,
    rememberWorkspaceProvider,
    selectedEffort,
    selectedModel,
    selectedPermissionMode,
    selectedSandboxMode,
    workspace,
  ]);

  const activeInteractiveWorkspaceId =
    activeInteractiveRequest?.workspace_id ?? null;
  const activeInteractiveRequestId =
    activeInteractiveRequest?.request_id ?? null;
  const handleActiveInteractiveResponse = useCallback(
    (response: InteractiveResponsePayload) => {
      if (!activeInteractiveWorkspaceId || !activeInteractiveRequestId) return;
      return respondInteractive(
        activeInteractiveWorkspaceId,
        activeInteractiveRequestId,
        response,
      );
    },
    [
      activeInteractiveRequestId,
      activeInteractiveWorkspaceId,
      respondInteractive,
    ],
  );

  const handleLoadOlder = useCallback(() => {
    if (
      !selectedWorkspaceId ||
      !selectedThreadId ||
      isLoadingOlder ||
      !selectedThreadHistory.hasOlder
    ) {
      return;
    }

    // maintainVisibleContentPosition keeps the viewport anchored while the
    // older page prepends above it; no scroll bookkeeping needed here.
    setIsLoadingOlder(true);
    void loadThreadDetail(selectedWorkspaceId, selectedThreadId, {
      older: true,
    }).finally(() => {
      setIsLoadingOlder(false);
    });
  }, [
    isLoadingOlder,
    loadThreadDetail,
    selectedThreadHistory.hasOlder,
    selectedThreadId,
    selectedWorkspaceId,
  ]);

  const handleRetryThreadLoad = useCallback(() => {
    if (!selectedWorkspaceId || !selectedThreadId) return;
    setDetailLoadingThreadId(selectedThreadId);
    void loadThreadDetail(selectedWorkspaceId, selectedThreadId).finally(() => {
      setDetailLoadingThreadId((current) =>
        current === selectedThreadId ? null : current,
      );
    });
  }, [loadThreadDetail, selectedThreadId, selectedWorkspaceId]);

  const appendImageAttachments = useCallback(
    (
      conversationKey: string,
      nextAttachments: ReturnType<typeof useUIStore.getState>["attachments"],
    ) => {
      if (nextAttachments.length === 0) return;
      const state = useUIStore.getState();
      const currentAttachments =
        state.attachmentsByConversation[conversationKey] ?? [];
      validateImageAttachmentBudget([
        ...currentAttachments,
        ...nextAttachments,
      ]);
      const currentDraft =
        state.conversationKey === conversationKey
          ? state.draft
          : (state.drafts[conversationKey]?.text ?? "");
      state.setComposerForConversation(conversationKey, currentDraft, [
        ...currentAttachments,
        ...nextAttachments,
      ]);
      useRelayStore.getState()._setError(null);
    },
    [],
  );

  const handlePickImages = useCallback(() => {
    if (!capabilities.supports_images) {
      useRelayStore
        .getState()
        ._setError("The selected agent does not support image attachments.");
      return;
    }
    const conversationKey = useUIStore.getState().conversationKey;
    void pickImageInputsFromLibrary()
      .then((pickedAttachments) => {
        appendImageAttachments(conversationKey, pickedAttachments);
      })
      .catch((error) => {
        useRelayStore
          .getState()
          ._setError(
            error instanceof Error ? error.message : "Failed to pick images",
          );
      });
  }, [appendImageAttachments, capabilities.supports_images]);

  const handleTakePhoto = useCallback(() => {
    if (!capabilities.supports_images) {
      useRelayStore
        .getState()
        ._setError("The selected agent does not support image attachments.");
      return;
    }
    const conversationKey = useUIStore.getState().conversationKey;
    void pickImageInputFromCamera()
      .then((pickedAttachments) => {
        appendImageAttachments(conversationKey, pickedAttachments);
      })
      .catch((error) => {
        useRelayStore
          .getState()
          ._setError(
            error instanceof Error ? error.message : "Failed to take photo",
          );
      });
  }, [appendImageAttachments, capabilities.supports_images]);

  const handlePasteImage = useCallback(() => {
    if (!capabilities.supports_images) {
      useRelayStore
        .getState()
        ._setError("The selected agent does not support image attachments.");
      return;
    }
    const conversationKey = useUIStore.getState().conversationKey;
    void pasteImageInputFromClipboard()
      .then((pastedAttachments) => {
        appendImageAttachments(conversationKey, pastedAttachments);
      })
      .catch((error) => {
        useRelayStore
          .getState()
          ._setError(
            error instanceof Error
              ? error.message
              : "Failed to paste clipboard image",
          );
      });
  }, [appendImageAttachments, capabilities.supports_images]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    setConversationUpdatesPaused(pauseLiveTranscript);
    return () => setConversationUpdatesPaused(false);
  }, [pauseLiveTranscript]);

  useEffect(() => {
    if (pauseLiveTranscript) {
      setDetailLoadingThreadId(null);
      setIsLoadingOlder(false);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !selectedThreadId ||
      !isEncrypted ||
      !daemonRpcReady
    ) {
      setDetailLoadingThreadId(null);
      setIsLoadingOlder(false);
      useSessionStore.getState().setThreadDetail(null);
      return;
    }

    let cancelled = false;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    setIsLoadingOlder(false);
    // Tracked for every load, cached or not: an uncached thread gets the
    // full-pane "Loading task…", a cached one a refresh pill over the
    // transcript, so a page that takes seconds never looks like the thread
    // simply ends at the cached messages.
    setDetailLoadingThreadId(selectedThreadId);

    void loadThreadDetail(selectedWorkspaceId, selectedThreadId).finally(() => {
      if (cancelled) return;
      setDetailLoadingThreadId((current) =>
        current === selectedThreadId ? null : current,
      );
      // Snap to the true bottom once the fresh page lands. Opening from cache
      // renders at the *cached* bottom, and anything the agent produced while
      // the app was closed appends below the anchored viewport, so nothing else
      // brings the reader down. The delay lets the merged items commit and lay
      // out before the scroll measures content height.
      //
      // Only for a reader who is still following the tail: this effect re-runs
      // for a reconnect or a workspace reselect too, and an unconditional snap
      // there yanks someone mid-way through the history back to the bottom.
      snapTimer = setTimeout(() => {
        if (!cancelled) scrollToBottomIfFollowing(false);
      }, 80);
    });

    return () => {
      cancelled = true;
      if (snapTimer) clearTimeout(snapTimer);
    };
  }, [
    daemonRpcReady,
    isEncrypted,
    loadThreadDetail,
    pauseLiveTranscript,
    scrollToBottomIfFollowing,
    selectedThreadId,
    selectedWorkspaceId,
  ]);

  // Opening a thread starts at the bottom of the cached items via the list's
  // startRenderingFromBottom (the detail-load effect snaps past any newer
  // items once they land); only the jump-button state needs resetting.
  useEffect(() => {
    resetScrollState();
  }, [resetScrollState, selectedThreadId]);

  useAutoMarkThreadRead({
    appState,
    isEncrypted,
    workspaceId: workspace?.id,
    thread: selectedThread,
  });

  // Gutters go on the scroll content rather than the list itself so the whole
  // pane still takes scroll and drag gestures on a wide screen.
  const listContentStyle = useMemo(
    () => ({
      paddingHorizontal: readingGutter,
    }),
    [readingGutter],
  );

  const projectLabel =
    workspace?.kind === "casual" ? "Chat" : getWorkspaceTitle(workspace?.path);
  const headerTitle = selectedThread
    ? selectedThread.title || "New task"
    : workspace?.kind === "casual"
      ? "New chat"
      : "New task";
  const headerAccessibilityLabel =
    workspace?.kind === "casual"
      ? `Casual chat${selectedThread ? `: ${selectedThread.title || "New thread"}` : ""}`
      : `Project: ${getWorkspaceTitle(workspace?.path)}${selectedThread ? `. Thread: ${selectedThread.title || "New thread"}` : ""}`;
  // Keyboard up: the dock rides on the keyboard. Keyboard down: it floats
  // just above the home indicator, the way iOS 26 seats its floating bars.
  const dockBottomPadding = isKeyboardVisible
    ? theme.spacing[2]
    : Math.max(insets.bottom - 10, theme.spacing[3]);

  const emptyStateFrame = (content: React.ReactNode) => (
    <ChromeInsetFrame top={headerHeight} bottom={dockHeight}>
      {content}
    </ChromeInsetFrame>
  );

  return (
    <AnimationVisibility active={isFocused && !pauseLiveTranscript}>
    <View style={styles.container}>
      <View style={[styles.listContainer, { marginBottom: keyboardInset }]}>
        {isSyncing ? (
          // The sync banner above already names this wait, so the pane only
          // shows motion — a second copy of the same sentence read as a bug.
          emptyStateFrame(<LoadingState fill />)
        ) : !selectedThread && blocks.length === 0 && !showThinking ? (
          emptyStateFrame(
            <View style={styles.newThreadState}>
              <Text variant="heading" size="2xl" weight="semibold" color="primary">
                {workspace?.kind === "casual" ? "What’s on your mind?" : "Let's build"}
              </Text>
              <Text variant="body" size="md" color="muted">
                {workspace?.kind === "casual"
                  ? "This chat isn’t attached to a project"
                  : (workspace?.path.split("/").pop() ?? "Select a project")}
              </Text>
            </View>,
          )
        ) : blocks.length === 0 &&
          isSelectedThreadLoading &&
          !showThinking ? (
          emptyStateFrame(<LoadingState fill label="Loading task…" />)
        ) : blocks.length === 0 &&
          liveActivityGroups.length === 0 &&
          !isThreadRunning &&
          !showThinking &&
          selectedThreadDetailError ? (
          emptyStateFrame(
            <View style={styles.syncState}>
              <Text variant="label" color="secondary" weight="semibold">
                Couldn&apos;t sync this conversation
              </Text>
              <Text variant="caption" color="muted" style={styles.syncErrorText}>
                {selectedThreadDetailError}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                label="Try again"
                onPress={handleRetryThreadLoad}
              />
            </View>,
          )
        ) : blocks.length === 0 &&
          liveActivityGroups.length === 0 &&
          !isThreadRunning &&
          !showThinking ? (
          emptyStateFrame(
            <EmptyState
              title="No messages yet"
              description="Send a message to get started"
            />,
          )
        ) : (
          <FlashList
            key={selectedThreadId}
            ref={listRef}
            data={blocks}
            renderItem={renderBlock}
            extraData={lastAssistantMessageId}
            keyExtractor={keyExtractor}
            getItemType={conversationRenderBlockType}
            accessibilityLabel="Conversation"
            showsVerticalScrollIndicator={false}
            // Drag the transcript down to put the keyboard away, as Messages does.
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // Anchoring and open-at-the-bottom stay with FlashList; the pin to
            // the tail does not (see useScrollToBottom — its sticky near-bottom
            // flag drags readers back down while content streams).
            maintainVisibleContentPosition={{
              autoscrollToBottomThreshold,
              startRenderingFromBottom: true,
            }}
            onContentSizeChange={onContentSizeChange}
            onScroll={onScroll}
            onScrollBeginDrag={onScrollBeginDrag}
            onScrollEndDrag={onScrollEndDrag}
            onMomentumScrollEnd={onMomentumScrollEnd}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
            onResponderRelease={onTouchEnd}
            scrollEventThrottle={16}
            contentContainerStyle={listContentStyle}
            ListHeaderComponent={
              <>
                {/* The transcript runs under the floating header; this keeps
                    its first message clear of the glass at rest. */}
                <ChromeSpacer height={headerHeight} />
                {selectedThreadHistory.hasOlder ? (
                  <View style={styles.loadOlderContainer}>
                    <Button
                      variant="ghost"
                      size="sm"
                      label="Load older messages"
                      accessibilityLabel="Load older messages"
                      onPress={handleLoadOlder}
                      loading={isLoadingOlder}
                    />
                  </View>
                ) : null}
              </>
            }
            ListFooterComponent={
              <>
                {showThinking ? <ThinkingIndicator submitting={isSubmitting && !isThreadRunning} /> : null}
                <View style={styles.listBottomSpacer} />
                {/* Same for the composer dock: the newest message rests just
                    above the glass and scrolls on underneath it. */}
                <ChromeSpacer height={dockHeight} />
              </>
            }
          />
        )}
      </View>

      <ThreadHeader
        onLayout={handleHeaderLayout}
        title={headerTitle}
        subtitle={projectLabel}
        accessibilityLabel={headerAccessibilityLabel}
        // With the sidebar already on screen there is nothing to open.
        onOpenSidebar={hasPermanentSidebar ? undefined : handleOpenDrawer}
        onPressTitle={selectedThread ? handleOpenThreadOptions : undefined}
        onNewThread={selectedThread ? handleNewThreadFromCurrent : undefined}
        onOpenOptions={selectedThread ? handleOpenThreadOptions : undefined}
        connectionStatus={connectionStatus}
        isEncrypted={isEncrypted}
        machinePresence={machinePresence}
        onPressConnection={openConnectionDebug}
      >
        <DemoBanner floating />
        <SyncBanner status={syncStatus} floating />
        <ErrorBanner message={error} onDismiss={handleDismissError} floating />
        {operationalConditions.length > 0 ? (
          <OperationalNoticeBanner
            conditions={operationalConditions}
            onDismiss={dismissOperationalCondition}
          />
        ) : null}
        <View style={styles.refreshPillAnchor} pointerEvents="box-none">
          <TranscriptRefreshPill visible={isRefreshingSelectedThread} />
        </View>
      </ThreadHeader>

      <View
        style={[styles.dock, { bottom: keyboardInset }]}
        pointerEvents="box-none"
        onLayout={handleDockLayout}
      >
        <ScrollEdge
          edge="bottom"
          height={(isKeyboardVisible ? 0 : insets.bottom) + theme.spacing[10]}
          solid={isKeyboardVisible ? 0 : insets.bottom * 0.5}
        />
        <View
          style={[styles.composerColumn, { paddingBottom: dockBottomPadding }]}
          pointerEvents="box-none"
        >
          <View style={styles.jumpAnchor} pointerEvents="box-none">
            <JumpToBottomFab visible={showJumpButton} onPress={scrollToBottom} />
          </View>

          <LiveActivityLane groups={liveActivityGroups} />

          {selectedThread && wasTurnInterruptedByShutdown(selectedThread) ? (
            <InterruptedTurnNotice
              onContinue={handleContinueInterruptedTurn}
              onDismiss={handleDismissInterruptedTurn}
              isContinuing={isSubmitting}
            />
          ) : null}

          <GoalBanner
            goal={selectedThread?.goal ?? null}
            onPress={() => setIsGoalSheetOpen(true)}
          />

          <ComposerSuggestionPill
            offer={composerSuggestionOffer}
            onSubmit={handleSubmitComposerSuggestion}
            onShowAlternatives={() => setIsSuggestionSheetOpen(true)}
            onDismiss={handleDismissComposerSuggestions}
          />

          {activeInteractiveRequest ? (
            // A request is answered where the thumb already is, right above
            // the composer. Long plans and question sets scroll in place
            // rather than pushing the dock up under the header.
            <ScrollView
              style={[styles.requestScroll, { maxHeight: requestMaxHeight }]}
              contentContainerStyle={styles.requestScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <InteractiveRequestBanner
                key={activeInteractiveRequest.request_id}
                request={activeInteractiveRequest}
                pendingCount={interactiveQueue.length}
                onRespond={handleActiveInteractiveResponse}
              />
            </ScrollView>
          ) : null}

          <QueuedTurns
            queuedTurns={queuedTurns}
            canSteer={capabilities.supports_steering}
            onRemove={handleRemoveQueuedTurn}
            onSteer={handleSteerQueuedTurn}
            onEdit={handleEditQueuedTurn}
            getAttachmentPreview={handleQueuedTurnAttachmentPreview}
          />

          <ChatInput
            textInputRef={composerInputRef}
            value={draft}
            onChangeText={setDraft}
            onSubmit={() => {
              // Sending from just above the tail means the reader wants to see
              // their message land; only a reader far enough up for the jump
              // button keeps their place.
              scrollToBottomIfNear();
              void submitTurn();
            }}
            onStop={() => {
              if (isStopping) return;
              setIsStopping(true);
              void interruptTurn().finally(() => setIsStopping(false));
            }}
            onPickImages={handlePickImages}
            onPasteImage={handlePasteImage}
            onTakePhoto={handleTakePhoto}
            onRemoveAttachment={removeAttachment}
            disabled={!workspace}
            sendDisabled={
              isSubmitting ||
              !isEncrypted ||
              Boolean(attachmentSendBlockReason)
            }
            statusNotice={
              handoffPending
                ? "Preparing handoff… copying this conversation to the new thread"
                : (handoffContextNotice ?? undefined)
            }
            sendDisabledReason={
              // Submitting is transient and self-evident; only surface a reason
              // when the block is something the user has to act on.
              isSubmitting
                ? undefined
                : !isEncrypted
                  ? (sessionSendBlockReason(syncStatus) ?? CONNECTION_COPY.reconnecting)
                  : (attachmentSendBlockReason ?? undefined)
            }
            attachments={attachments}
            skills={workspace?.skills ?? []}
            loadSkills={loadWorkspaceSkills}
            loadPrompts={loadWorkspacePrompts}
            // An empty catalog after sync is an empty state, not an active load.
            modelsLoading={isSyncing && effectiveModels.length === 0}
            models={effectiveModels}
            selectedModel={selectedModel}
            selectedEffort={selectedEffort}
            effortOptions={effortOptions}
            selectedProvider={activeProvider}
            providers={providerOptions}
            selectedIsolation={selectedIsolation}
            onSelectIsolation={setSelectedIsolation}
            showProviderSelector={!selectedThread}
            onSelectModel={handleModelChange}
            onSelectEffort={handleEffortChange}
            selectedServiceTier={selectedServiceTier}
            onSelectServiceTier={handleServiceTierChange}
            onSelectProvider={handleProviderChange}
            handoffProviders={handoffProviderOptions}
            onHandoffProviderSelect={
              selectedThread ? handoffToProvider : undefined
            }
            handoffDisabledReason={handoffDisabledReason}
            isRunning={isThreadRunning || selectedThread?.status === "waiting_for_input"}
            isStopping={isStopping}
            capabilities={capabilities}
            compactCommandAvailable={
              Boolean(selectedThread) &&
              capabilities.supports_compaction &&
              !isThreadRunning
            }
            selectedPermissionMode={selectedPermissionMode}
            collaborationModes={collaborationModes}
            selectedCollaborationMode={selectedCollaborationMode}
            onSelectCollaborationMode={handleCollaborationModeChange}
            selectedSandboxMode={selectedSandboxMode}
            onSelectPermissionMode={handlePermissionModeChange}
            onSelectSandboxMode={handleSandboxModeChange}
            onGoalCommand={() => setIsGoalSheetOpen(true)}
          />
        </View>
      </View>

      {isSuggestionSheetOpen && composerSuggestionOffer ? (
        <ComposerSuggestionSheet
          offer={composerSuggestionOffer}
          onSubmit={handleSubmitComposerSuggestion}
          onClose={() => setIsSuggestionSheetOpen(false)}
        />
      ) : null}

      {isGoalSheetOpen && showGoalControl ? (
        <GoalSheet
          goal={selectedThread?.goal ?? null}
          provider={activeProvider}
          onSetGoal={handleSetGoal}
          onClearGoal={handleClearGoal}
          onSetGoalStatus={handleSetGoalStatus}
          onClose={() => setIsGoalSheetOpen(false)}
        />
      ) : null}

      {isThreadOptionsOpen && selectedThread ? (
        <ThreadOptionsSheet
          workspaceId={selectedThread.workspace_id}
          thread={selectedThread}
          onClose={handleCloseThreadOptions}
        />
      ) : null}

      {isConnectionDebugMounted ? <ConnectionDebugScreen /> : null}
    </View>
    </AnimationVisibility>
  );
}

/** Holds space for floating chrome inside the transcript's scroll content.
    Driven from a shared value so the composer growing a line, or a banner
    arriving under the header, never re-renders the whole thread screen. */
function ChromeSpacer({ height }: { height: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({ height: height.value }));
  return <Animated.View style={style} />;
}

/** Centres an empty or loading pane in the space the chrome leaves visible. */
function ChromeInsetFrame({
  top,
  bottom,
  children,
}: {
  top: SharedValue<number>;
  bottom: SharedValue<number>;
  children: React.ReactNode;
}) {
  const style = useAnimatedStyle(() => ({
    paddingTop: top.value,
    paddingBottom: bottom.value,
  }));
  return <Animated.View style={[{ flex: 1 }, style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  listContainer: {
    flex: 1,
    minHeight: 2,
  },
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
  },
  // Keeps the composer on the same reading column as the transcript above it.
  composerColumn: {
    width: "100%",
    maxWidth: READING_MAX_WIDTH,
    alignSelf: "center",
  },
  // The jump button floats a little above whatever tops the dock.
  jumpAnchor: {
    position: "absolute",
    top: -(theme.spacing[12] + theme.spacing[1]),
    left: 0,
    right: 0,
    alignItems: "center",
  },
  // Zero-height anchor so the refresh pill hangs just under the header
  // without adding to the height the transcript reserves for it.
  refreshPillAnchor: {
    height: 0,
  },
  requestScroll: {
    flexGrow: 0,
  },
  requestScrollContent: {
    paddingBottom: theme.spacing[1],
  },
  listBottomSpacer: {
    height: theme.spacing[4],
  },
  syncState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  syncErrorText: {
    textAlign: "center",
    maxWidth: 260,
  },
  newThreadState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
  },
  loadOlderContainer: {
    alignItems: "center",
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
}));
