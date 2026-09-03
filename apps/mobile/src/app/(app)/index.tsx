import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  View,
  type TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { FlashList } from "@shopify/flash-list";
import { ChevronLeft, MoreHorizontal, SquarePen } from "lucide-react-native";
import { DrawerActions } from "@react-navigation/native";
import { useNavigation } from "expo-router";
import {
  composerProviderFor,
  composerSelectionFor,
  conversationRenderBlockType,
  defaultProvider,
  deriveComposerSuggestions,
  draftKeyFor,
  handoffBlockedReason,
  imageAttachmentSendBlockReason,
  latestVisibleAssistantMessageId,
  operationalConditionDismissalKey,
  isDaemonRpcReady,
  workspaceOperationalConditions,
  orderedInteractiveRequestQueue,
  providerForThread,
  reuseRetrySourcesByAssistantId,
  resolvePersistedMode,
  resolvePermissionMode,
  resolveServiceTier,
  STANDARD_SERVICE_TIER,
  validateImageAttachmentBudget,
  workspaceAgentCapabilities,
  threadAgentCapabilities,
  workspaceModels,
  workspaceProviderOptions,
  wasTurnInterruptedByShutdown,
  type AgentProvider,
  type ComposerSuggestion,
  type ConversationPresentation,
  type ConversationRenderBlock,
  type InteractiveResponsePayload,
  type OperationalCondition,
  type QueuedTurnSummary,
} from "@falcondeck/client-core";
import { useShallow } from "zustand/react/shallow";

import {
  useConnectionLogStore,
  useInteractiveRequests,
  useRelayStore,
  useSessionStore,
  useSelectedThread,
  useSelectedThreadDetailError,
  useSelectedThreadHistory,
  useConversationItems,
  useSelectedWorkspace,
  useUIStore,
  openConnectionDebug,
} from "@/store";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useInterruptTurn } from "@/hooks/useInterruptTurn";
import { useAutoMarkThreadRead } from "@/hooks/useAutoMarkThreadRead";
import { useThreadActions } from "@/hooks/useThreadActions";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";
import { useConversationPresentation } from "@/hooks/useRenderBlocks";
import { useScrollToBottom } from "@/hooks/useScrollToBottom";
import { useResponseCompletionAnnouncement } from "@/hooks/useResponseCompletionAnnouncement";
import { useSessionSyncStatus } from "@/hooks/useSessionSyncStatus";
import {
  ActivityDiamond,
  Button,
  Text,
  EmptyState,
  ErrorBanner,
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
  QueuedTurns,
  ThinkingIndicator,
  OperationalNoticeBanner,
} from "@/components/chat";
import { ConnectionHeader, ThreadOptionsSheet } from "@/components/navigation";
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

const keyExtractor = (block: ConversationRenderBlock) => block.id;
const EMPTY_QUEUED_TURNS: QueuedTurnSummary[] = [];

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const navigation = useNavigation();

  const presentation: ConversationPresentation = useConversationPresentation();
  const blocks = presentation.history_blocks;
  const liveActivityGroups = presentation.live_activity_groups;
  const interactiveRequests = useInteractiveRequests();
  const interactiveQueue = useMemo(
    () => orderedInteractiveRequestQueue(interactiveRequests),
    [interactiveRequests],
  );
  const activeInteractiveRequest = interactiveQueue[0] ?? null;
  const selectedThread = useSelectedThread();
  const selectedThreadHistory = useSelectedThreadHistory();
  const selectedThreadDetailError = useSelectedThreadDetailError();
  const conversationItems = useConversationItems();
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
  const [dismissedConditionVersions, setDismissedConditionVersions] = useState<
    Set<string>
  >(() => new Set());
  const operationalConditions = useMemo(
    () =>
      workspaceOperationalConditions(
        operationalConditionSource,
        serviceNotices,
        selectedWorkspaceId,
        dismissedConditionVersions,
      ),
    [
      dismissedConditionVersions,
      selectedWorkspaceId,
      operationalConditionSource,
      serviceNotices,
    ],
  );
  const dismissOperationalCondition = useCallback(
    (condition: OperationalCondition) => {
      const dismissalKey = operationalConditionDismissalKey(condition);
      setDismissedConditionVersions((current) => {
        if (current.has(dismissalKey)) return current;
        const next = new Set(current);
        next.add(dismissalKey);
        return next;
      });
    },
    [],
  );
  const {
    connectionStatus,
    error,
    isEncrypted,
    hasSyncedOnce,
    machinePresence,
    sessionId,
  } = useRelayStore(
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      error: s.error,
      isEncrypted: s.isEncrypted,
      hasSyncedOnce: s.hasSyncedOnce,
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
    prefetchRecentThreadDetails,
    retryResponse,
    loadWorkspaceSkills,
    handoffToProvider,
    handoffPending,
    handoffPendingThreadKey,
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
    onTouchEnd,
    resetScrollState,
    scrollToBottom,
    scrollToBottomIfFollowing,
    scrollToBottomIfNear,
  } = useScrollToBottom<ConversationRenderBlock>();
  const isKeyboardVisible = useKeyboardVisible();
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
  const handoffProviderOptions = useMemo(
    () =>
      selectedThread
        ? providerOptions.filter(
            (option) => option.provider !== selectedThread.provider,
          )
        : [],
    [providerOptions, selectedThread],
  );
  const isPreparingSelectedHandoff =
    handoffPendingThreadKey ===
    draftKeyFor(selectedWorkspaceId, selectedThreadId);
  const handoffDisabledReason = handoffBlockedReason(selectedThread, {
    pending: handoffPending,
  });

  // Which mode pickers the composer shows, and whether a queued message can be
  // steered — both are per-provider, so they change with the active agent.
  const capabilities = useMemo(
    () => threadAgentCapabilities(workspace, activeProvider, selectedThread),
    [activeProvider, selectedThread, workspace],
  );
  const attachmentSendBlockReason = imageAttachmentSendBlockReason(
    capabilities,
    attachments.length,
  );
  const queuedTurns = selectedThread?.queued_turns ?? EMPTY_QUEUED_TURNS;
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
  const resolvedModel = useMemo(() => {
    if (selectedModel)
      return effectiveModels.find((m) => m.id === selectedModel) ?? null;
    return (
      effectiveModels.find((m) => m.is_default) ?? effectiveModels[0] ?? null
    );
  }, [effectiveModels, selectedModel]);

  const effortOptions = useMemo(() => {
    const supported =
      resolvedModel?.supported_reasoning_efforts.map(
        (e) => e.reasoning_effort,
      ) ?? [];
    if (supported.length > 0) return supported;
    if (resolvedModel?.default_reasoning_effort)
      return [resolvedModel.default_reasoning_effort];
    // A resolved model that advertises no efforts has none (several OpenCode
    // models cannot reason at all); only an unresolved model keeps the
    // historic fallback.
    return resolvedModel ? [] : ["medium"];
  }, [resolvedModel]);
  const isThreadRunning = selectedThread?.status === "running";
  const showThinking = shouldShowThinkingIndicator(
    presentation,
    isThreadRunning || isPreparingSelectedHandoff,
  );
  const isSelectedThreadLoading =
    !!selectedThreadId && detailLoadingThreadId === selectedThreadId;

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

    const seedKey = `${workspace.id}:${selectedThread?.id ?? "workspace"}`;
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
    const preferredModel =
      preferredSelection?.modelId &&
      providerModels.some((model) => model.id === preferredSelection.modelId)
        ? preferredSelection.modelId
        : null;
    const fallbackModel =
      preferredModel ??
      providerModels.find((model) => model.is_default)?.id ??
      providerModels[0]?.id ??
      null;

    if (selectedThread) {
      const nextModel = selectedThread.agent.model_id ?? fallbackModel;
      const nextModelSummary = nextModel
        ? (providerModels.find((model) => model.id === nextModel) ?? null)
        : null;
      const supportedEfforts =
        nextModelSummary?.supported_reasoning_efforts.map(
          (entry) => entry.reasoning_effort,
        ) ?? [];
      setSelectedModel(nextModel);
      setSelectedEffort(
        selectedThread.agent.reasoning_effort ??
          nextModelSummary?.default_reasoning_effort ??
          supportedEfforts[0] ??
          "medium",
      );
      setSelectedServiceTier(
        resolveServiceTier(selectedThread.agent.service_tier, nextModelSummary),
      );
      return;
    }

    const fallbackModelSummary = fallbackModel
      ? (providerModels.find((model) => model.id === fallbackModel) ?? null)
      : null;
    const supportedEfforts =
      fallbackModelSummary?.supported_reasoning_efforts.map(
        (entry) => entry.reasoning_effort,
      ) ?? [];
    setSelectedModel(fallbackModel);
    setSelectedEffort(
      (preferredSelection?.effort &&
      supportedEfforts.includes(preferredSelection.effort)
        ? preferredSelection.effort
        : null) ??
        fallbackModelSummary?.default_reasoning_effort ??
        supportedEfforts[0] ??
        "medium",
    );
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
    if (effortOptions.length === 0) return;
    if (!selectedEffort || !effortOptions.includes(selectedEffort)) {
      const fallback =
        resolvedModel?.default_reasoning_effort ?? effortOptions[0] ?? "medium";
      setSelectedEffort(fallback);
    }
  }, [effortOptions, resolvedModel, selectedEffort, setSelectedEffort]);

  // Optional providers start lazily in the daemon; picking one on a new-thread
  // composer is the signal to warm its runtime so the model list fills in.
  const hydratedProvidersRef = useRef(new Set<string>());
  useEffect(() => {
    if (selectedThread || !workspace || !selectedProvider) return;
    if (!isEncrypted || !daemonRpcReady) return;
    const key = `${workspace.id}:${selectedProvider}`;
    if (hydratedProvidersRef.current.has(key)) return;
    hydratedProvidersRef.current.add(key);
    void useRelayStore
      .getState()
      ._callRpc("provider.hydrate", {
        workspace_id: workspace.id,
        provider: selectedProvider,
      })
      .catch(() => {});
  }, [
    daemonRpcReady,
    isEncrypted,
    selectedProvider,
    selectedThread,
    workspace,
  ]);

  const handleProviderChange = useCallback(
    (provider: AgentProvider) => {
      if (selectedThread) return; // locked
      setSelectedProvider(provider);
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
    // Read the item count imperatively: subscribing to it would refire this
    // effect (and a full thread.detail RPC) for every streamed item.
    if (
      (useSessionStore.getState().threadItems[selectedThreadId]?.length ??
        0) === 0
    ) {
      setDetailLoadingThreadId(selectedThreadId);
    }

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
    scrollToBottomIfFollowing,
    selectedThreadId,
    selectedWorkspaceId,
  ]);

  // Warm the handful of most recently updated threads in the background once
  // the session is encrypted and synced, so tapping between them renders from
  // cache instantly instead of "Loading thread…".
  useEffect(() => {
    if (!isEncrypted || !hasSyncedOnce || !daemonRpcReady) return;
    void prefetchRecentThreadDetails();
  }, [daemonRpcReady, hasSyncedOnce, isEncrypted, prefetchRecentThreadDetails]);

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

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <Pressable
          style={styles.headerLeft}
          onPress={handleOpenDrawer}
          hitSlop={theme.spacing[2]}
          accessibilityRole="button"
          accessibilityLabel={
            workspace?.kind === "casual"
              ? `Casual chat${selectedThread ? `: ${selectedThread.title || "New thread"}` : ""}`
              : `Project: ${getWorkspaceTitle(workspace?.path)}${selectedThread ? `. Thread: ${selectedThread.title || "New thread"}` : ""}`
          }
          accessibilityHint="Opens the project and thread list"
        >
          <ChevronLeft size={theme.iconSize.md} color={theme.colors.fg.muted} />
          <View style={styles.headerLabels}>
            <Text
              variant="label"
              color="primary"
              weight="semibold"
              numberOfLines={1}
            >
              {workspace?.kind === "casual" ? "Chat" : getWorkspaceTitle(workspace?.path)}
            </Text>
            {selectedThread ? (
              <Text variant="caption" color="muted" numberOfLines={1}>
                {selectedThread.title || "New thread"}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <View style={styles.headerRight}>
          {selectedThread ? (
            <>
              <Pressable
                onPress={handleNewThreadFromCurrent}
                accessibilityRole="button"
                accessibilityLabel="New thread with current settings"
                style={({ pressed }) => [
                  styles.headerIconButton,
                  pressed && styles.headerIconButtonPressed,
                ]}
              >
                <SquarePen
                  size={theme.iconSize.md}
                  color={theme.colors.fg.secondary}
                />
              </Pressable>
              <Pressable
                onPress={handleOpenThreadOptions}
                accessibilityRole="button"
                accessibilityLabel="Thread options"
                style={({ pressed }) => [
                  styles.headerIconButton,
                  pressed && styles.headerIconButtonPressed,
                ]}
              >
                <MoreHorizontal
                  size={theme.iconSize.md}
                  color={theme.colors.fg.secondary}
                />
              </Pressable>
            </>
          ) : null}
          <ConnectionHeader
            connectionStatus={connectionStatus}
            isEncrypted={isEncrypted}
            machinePresence={machinePresence}
            onPress={openConnectionDebug}
          />
        </View>
      </View>

      <DemoBanner />

      <SyncBanner status={syncStatus} />

      <ErrorBanner message={error} onDismiss={handleDismissError} />

      {operationalConditions.length > 0 ? (
        <OperationalNoticeBanner
          conditions={operationalConditions}
          onDismiss={dismissOperationalCondition}
        />
      ) : null}

      {activeInteractiveRequest ? (
        <InteractiveRequestBanner
          key={activeInteractiveRequest.request_id}
          request={activeInteractiveRequest}
          pendingCount={interactiveQueue.length}
          onRespond={handleActiveInteractiveResponse}
        />
      ) : null}

      <View style={styles.listContainer}>
        {isSyncing ? (
          // The sync banner above already names this wait, so the pane only
          // shows motion — a second copy of the same sentence read as a bug.
          <View style={styles.syncState}>
            <ActivityDiamond
              size={theme.iconSize.md}
              color={theme.colors.accent.default}
            />
          </View>
        ) : !selectedThread && blocks.length === 0 ? (
          <View style={styles.newThreadState}>
            <Text variant="heading" color="primary">
              {workspace?.kind === "casual" ? "What’s on your mind?" : "Let's build"}
            </Text>
            <Text variant="body" size="lg" color="muted">
              {workspace?.kind === "casual"
                ? "This chat isn’t attached to a project"
                : (workspace?.path.split("/").pop() ?? "Select a project")}
            </Text>
          </View>
        ) : blocks.length === 0 &&
          isSelectedThreadLoading &&
          !isPreparingSelectedHandoff ? (
          <View style={styles.syncState}>
            <ActivityDiamond
              size={theme.iconSize.md}
              color={theme.colors.accent.default}
            />
            <Text variant="caption" color="muted">
              Loading thread…
            </Text>
          </View>
        ) : blocks.length === 0 &&
          liveActivityGroups.length === 0 &&
          !isThreadRunning &&
          !isPreparingSelectedHandoff &&
          selectedThreadDetailError ? (
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
          </View>
        ) : blocks.length === 0 &&
          liveActivityGroups.length === 0 &&
          !isThreadRunning &&
          !isPreparingSelectedHandoff ? (
          <EmptyState
            title="No messages yet"
            description="Send a message to get started"
          />
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
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
            onResponderRelease={onTouchEnd}
            scrollEventThrottle={16}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              selectedThreadHistory.hasOlder ? (
                <View style={styles.loadOlderContainer}>
                  <Button
                    variant="ghost"
                    size="sm"
                    label={
                      isLoadingOlder
                        ? "Loading older messages..."
                        : "Load older messages"
                    }
                    onPress={handleLoadOlder}
                    loading={isLoadingOlder}
                  />
                </View>
              ) : null
            }
            ListFooterComponent={
              <>
                {showThinking ? <ThinkingIndicator /> : null}
                <View style={styles.listBottomSpacer} />
              </>
            }
          />
        )}
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

      <QueuedTurns
        queuedTurns={queuedTurns}
        canSteer={capabilities.supports_steering}
        onRemove={handleRemoveQueuedTurn}
        onSteer={handleSteerQueuedTurn}
        onEdit={handleEditQueuedTurn}
        getAttachmentPreview={handleQueuedTurnAttachmentPreview}
      />

      {/* The keyboard already covers the home indicator, so keeping the inset
          while it is up would float the composer above the keyboard. */}
      <View style={{ paddingBottom: isKeyboardVisible ? 0 : insets.bottom }}>
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
            Boolean(attachmentSendBlockReason) ||
            isPreparingSelectedHandoff
          }
          sendDisabledReason={
            // Submitting is transient and self-evident; only surface a reason
            // when the block is something the user has to act on.
            isSubmitting
              ? undefined
              : isPreparingSelectedHandoff
                ? "Wait for the handoff turn to start"
                : !isEncrypted
                  ? (sessionSendBlockReason(syncStatus) ?? CONNECTION_COPY.reconnecting)
                  : (attachmentSendBlockReason ?? undefined)
          }
          attachments={attachments}
          skills={workspace?.skills ?? []}
          loadSkills={loadWorkspaceSkills}
          // No live or cached models means the harness catalog is still
          // hydrating (the daemon fills OpenCode's list via a later snapshot).
          modelsLoading={Boolean(workspace) && effectiveModels.length === 0}
          models={effectiveModels}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          effortOptions={effortOptions}
          selectedProvider={activeProvider}
          providers={providerOptions}
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
          isRunning={isThreadRunning}
          isStopping={isStopping}
          capabilities={capabilities}
          compactCommandAvailable={
            Boolean(selectedThread) &&
            capabilities.supports_compaction &&
            !isThreadRunning
          }
          selectedPermissionMode={selectedPermissionMode}
          selectedSandboxMode={selectedSandboxMode}
          onSelectPermissionMode={handlePermissionModeChange}
          onSelectSandboxMode={handleSandboxModeChange}
          onGoalCommand={() => setIsGoalSheetOpen(true)}
        />
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  headerLeft: {
    flex: 1,
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginRight: theme.spacing[3],
  },
  headerLabels: {
    flex: 1,
    minWidth: 0,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerIconButton: {
    minWidth: theme.minTouchTarget,
    minHeight: theme.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
  },
  headerIconButtonPressed: {
    backgroundColor: theme.colors.surface[2],
  },
  listContainer: {
    flex: 1,
    minHeight: 2,
  },
  listContent: {
    paddingBottom: theme.spacing[4],
  },
  listBottomSpacer: {
    height: theme.spacing[6],
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
  },
  loadOlderContainer: {
    alignItems: "center",
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
}));
