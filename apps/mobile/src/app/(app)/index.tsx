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
import { useNavigation, useRouter } from "expo-router";
import {
  composerProviderFor,
  composerSelectionFor,
  conversationRenderBlockType,
  defaultProvider,
  editResendUnavailableReason,
  encryptJson,
  imageAttachmentSendBlockReason,
  operationalConditionDismissalKey,
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
  workspaceModels,
  workspaceProviderLabel,
  workspaceProviderOptions,
  type AgentProvider,
  type ConversationPresentation,
  type ConversationRenderBlock,
  type InteractiveResponsePayload,
  type OperationalCondition,
  type QueuedTurnSummary,
} from "@falcondeck/client-core";
import { useShallow } from "zustand/react/shallow";

import {
  useInteractiveRequests,
  useRelayStore,
  useSessionStore,
  useSelectedThread,
  useSelectedThreadHistory,
  useConversationItems,
  useSelectedWorkspace,
  useUIStore,
} from "@/store";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useInterruptTurn } from "@/hooks/useInterruptTurn";
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
  GoalSheet,
  JumpToBottomFab,
  QueuedTurns,
  ThinkingIndicator,
  OperationalNoticeBanner,
} from "@/components/chat";
import { ConnectionHeader, ThreadOptionsSheet } from "@/components/navigation";
import {
  pasteImageInputFromClipboard,
  pickImageInputFromCamera,
  pickImageInputsFromLibrary,
} from "@/features/thread/imageInputs";
import {
  getWorkspaceTitle,
  shouldShowThinkingIndicator,
} from "@/features/thread/threadScreen";
import {
  triggerAgentCompletionHaptic,
  triggerThreadSelectionHaptic,
} from "@/lib/haptics";
import { sessionSendBlockReason } from "@/lib/session-status";

const keyExtractor = (block: ConversationRenderBlock) => block.id;
const EMPTY_QUEUED_TURNS: QueuedTurnSummary[] = [];

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const navigation = useNavigation();
  const router = useRouter();

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
  const conversationItems = useConversationItems();
  const workspace = useSelectedWorkspace();
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId);
  const snapshot = useSessionStore((s) => s.snapshot);
  const [dismissedConditionVersions, setDismissedConditionVersions] = useState<
    Set<string>
  >(() => new Set());
  const operationalConditions = useMemo(
    () =>
      workspaceOperationalConditions(
        snapshot?.operational_conditions,
        snapshot?.service_notices,
        selectedWorkspaceId,
        dismissedConditionVersions,
      ),
    [
      dismissedConditionVersions,
      selectedWorkspaceId,
      snapshot?.operational_conditions,
      snapshot?.service_notices,
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
    machinePresence,
    relayUrl,
    sessionId,
  } = useRelayStore(
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      error: s.error,
      isEncrypted: s.isEncrypted,
      machinePresence: s.machinePresence,
      relayUrl: s.relayUrl,
      sessionId: s.sessionId,
    })),
  );
  const syncStatus = useSessionSyncStatus();
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
    editResend,
    retryResponse,
  } = useSessionActions();
  const interruptTurn = useInterruptTurn();
  const {
    clearThreadGoal,
    editQueuedTurn,
    removeQueuedTurn,
    setThreadGoal,
    setThreadMode,
    steerQueuedTurn,
  } = useThreadActions();
  const {
    listRef,
    showJumpButton,
    autoscrollToBottomThreshold,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollEnd,
    resetScrollState,
    scrollToBottom,
  } = useScrollToBottom<ConversationRenderBlock>();
  const isKeyboardVisible = useKeyboardVisible();
  const [appState, setAppState] = useState(AppState.currentState);
  const [detailLoadingThreadId, setDetailLoadingThreadId] = useState<
    string | null
  >(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isGoalSheetOpen, setIsGoalSheetOpen] = useState(false);
  const [isThreadOptionsOpen, setIsThreadOptionsOpen] = useState(false);
  const selectionSeedRef = useRef<string | null>(null);
  const composerInputRef = useRef<TextInput>(null);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentReadSeqRef = useRef<{
    threadId: string;
    readSeq: number;
  } | null>(null);
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

  // Which mode pickers the composer shows, and whether a queued message can be
  // steered — both are per-provider, so they change with the active agent.
  const capabilities = useMemo(
    () => workspaceAgentCapabilities(workspace, activeProvider),
    [activeProvider, workspace],
  );
  const attachmentSendBlockReason = imageAttachmentSendBlockReason(
    capabilities,
    attachments.length,
  );
  const queuedTurns = selectedThread?.queued_turns ?? EMPTY_QUEUED_TURNS;
  // A goal belongs to a thread, so there is nothing to set one on until one
  // exists — same gate as desktop.
  const showGoalControl = Boolean(workspace) && capabilities.supports_goals;
  const canEditResend = Boolean(
    selectedThread &&
    capabilities.supports_forking &&
    !selectedThread.variant &&
    selectedThread.status !== "running" &&
    selectedThread.status !== "waiting_for_input",
  );
  const editResendReason = selectedThread
    ? editResendUnavailableReason({
        providerLabel: workspaceProviderLabel(
          workspace,
          selectedThread.provider,
        ),
        supportsForking: capabilities.supports_forking,
        isIsolated: Boolean(selectedThread.variant),
        threadStatus: selectedThread.status,
      })
    : null;
  // Render-only structural sharing keeps this lookup stable while only an
  // assistant tail streams. React has no previous-value useMemo primitive;
  // the helper validates all source identities before returning the cache.
  /* eslint-disable react-hooks/refs */
  const retrySources = useMemo(() => {
    if (!canEditResend) {
      retrySourcesRef.current = null;
      return null;
    }
    const stable = reuseRetrySourcesByAssistantId(
      retrySourcesRef.current,
      conversationItems,
    );
    retrySourcesRef.current = stable;
    return stable;
  }, [canEditResend, conversationItems]);
  /* eslint-enable react-hooks/refs */
  const renderBlock = useCallback(
    ({ item }: { item: ConversationRenderBlock }) => (
      <MessageRouter
        item={item}
        onApprovalDecision={respondApproval}
        canEditResend={canEditResend}
        editResendUnavailableReason={editResendReason}
        onEditResend={editResend}
        retrySource={
          item.kind === "item" && item.item.kind === "assistant_message"
            ? (retrySources?.get(item.item.id) ?? null)
            : null
        }
        onRetryResponse={retryResponse}
      />
    ),
    [
      canEditResend,
      editResend,
      editResendReason,
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

  // Compute effort options from the selected model's supported_reasoning_efforts
  const resolvedModel = useMemo(() => {
    if (selectedModel)
      return models.find((m) => m.id === selectedModel) ?? null;
    return models.find((m) => m.is_default) ?? models[0] ?? null;
  }, [models, selectedModel]);

  const effortOptions = useMemo(() => {
    const supported =
      resolvedModel?.supported_reasoning_efforts.map(
        (e) => e.reasoning_effort,
      ) ?? [];
    if (supported.length > 0) return supported;
    return resolvedModel?.default_reasoning_effort
      ? [resolvedModel.default_reasoning_effort]
      : ["medium"];
  }, [resolvedModel]);
  const isThreadRunning = selectedThread?.status === "running";
  const showThinking = shouldShowThinkingIndicator(
    presentation,
    isThreadRunning,
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
  const isSyncing = !!sessionId && !snapshot;

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
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  const handleOpenSettings = useCallback(() => {
    router.push("/(app)/settings");
  }, [router]);

  const handleOpenThreadOptions = useCallback(() => {
    setIsThreadOptionsOpen(true);
  }, []);

  const handleCloseThreadOptions = useCallback(() => {
    setIsThreadOptionsOpen(false);
  }, []);

  const handleNewThreadFromCurrent = useCallback(() => {
    if (!workspace) return;

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
    if (!selectedWorkspaceId || !selectedThreadId || !isEncrypted) {
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
      // the app was closed appends below the anchored viewport — outside
      // maintainVisibleContentPosition's autoscroll threshold, so nothing else
      // brings the reader down. The delay lets the merged items commit and lay
      // out before the scroll measures content height.
      snapTimer = setTimeout(() => {
        if (!cancelled) scrollToBottom(false);
      }, 80);
    });

    return () => {
      cancelled = true;
      if (snapTimer) clearTimeout(snapTimer);
    };
  }, [
    isEncrypted,
    loadThreadDetail,
    scrollToBottom,
    selectedThreadId,
    selectedWorkspaceId,
  ]);

  // Opening a thread starts at the bottom of the cached items via the list's
  // startRenderingFromBottom (the detail-load effect snaps past any newer
  // items once they land); only the jump-button state needs resetting.
  useEffect(() => {
    resetScrollState();
  }, [resetScrollState, selectedThreadId]);

  useEffect(() => {
    // The cleanup below cancels any pending debounce whenever the deps change
    // (or the screen unmounts), so an early return — switching threads,
    // backgrounding, losing encryption — can never let a stale timer mark the
    // previous thread read with captured values.
    if (
      appState !== "active" ||
      !workspace ||
      !selectedThread ||
      !sessionId ||
      !isEncrypted
    )
      return;

    const readSeq = selectedThread.attention.last_agent_activity_seq;
    if (!readSeq || readSeq <= selectedThread.attention.last_read_seq) return;

    // Streamed events refire this effect long before the summary reflects the
    // send, so suppress duplicates locally and debounce the action itself.
    const lastSent = lastSentReadSeqRef.current;
    if (
      lastSent &&
      lastSent.threadId === selectedThread.id &&
      lastSent.readSeq >= readSeq
    )
      return;

    const workspaceId = workspace.id;
    const threadId = selectedThread.id;

    markReadTimerRef.current = setTimeout(() => {
      markReadTimerRef.current = null;
      const relay = useRelayStore.getState();
      const clientToken = relay._getClientToken();
      const sessionCrypto = relay._getSessionCrypto();
      if (!clientToken || !sessionCrypto) return;

      lastSentReadSeqRef.current = { threadId, readSeq };
      void encryptJson(sessionCrypto.dataKey, {
        workspace_id: workspaceId,
        thread_id: threadId,
        read_seq: readSeq,
      })
        .then((payload) =>
          fetch(
            `${relayUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${clientToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                idempotency_key:
                  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
                action_type: "thread.mark_read",
                payload,
              }),
            },
          ),
        )
        .catch(() => {});
    }, 1_000);

    return () => {
      if (markReadTimerRef.current) {
        clearTimeout(markReadTimerRef.current);
        markReadTimerRef.current = null;
      }
    };
  }, [appState, isEncrypted, relayUrl, selectedThread, sessionId, workspace]);

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
          accessibilityRole="button"
          accessibilityLabel={`Project: ${getWorkspaceTitle(workspace?.path)}`}
          accessibilityHint="Opens the project and thread list"
        >
          <ChevronLeft size={18} color={theme.colors.fg.muted} />
          <Text
            variant="label"
            color="primary"
            weight="semibold"
            numberOfLines={1}
            style={styles.headerTitle}
          >
            {getWorkspaceTitle(workspace?.path)}
          </Text>
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
            onPress={handleOpenSettings}
          />
        </View>
      </View>

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
          <View style={styles.syncState}>
            <ActivityDiamond
              size={theme.iconSize.md}
              color={theme.colors.accent.default}
            />
            <Text variant="caption" color="muted">
              {connectionStatus === "encrypted"
                ? "Syncing..."
                : connectionStatus === "connected"
                  ? "Securing session..."
                  : "Connecting..."}
            </Text>
          </View>
        ) : !selectedThread && blocks.length === 0 ? (
          <View style={styles.newThreadState}>
            <Text variant="heading" color="primary">
              Let's build
            </Text>
            <Text variant="body" size="lg" color="muted">
              {workspace?.path.split("/").pop() ?? "Select a project"}
            </Text>
          </View>
        ) : blocks.length === 0 && isSelectedThreadLoading ? (
          <View style={styles.syncState}>
            <ActivityDiamond
              size={theme.iconSize.md}
              color={theme.colors.accent.default}
            />
            <Text variant="caption" color="muted">
              Loading thread...
            </Text>
          </View>
        ) : blocks.length === 0 &&
          liveActivityGroups.length === 0 &&
          !isThreadRunning ? (
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
            keyExtractor={keyExtractor}
            getItemType={conversationRenderBlockType}
            accessibilityLabel="Conversation"
            showsVerticalScrollIndicator={false}
            // Native bottom-pinning: chat opens at the bottom and follows
            // streaming output, but only while the user hasn't scrolled away —
            // the threshold is stateful (see useScrollToBottom) because a
            // fixed one lets each streamed chunk's autoscroll cancel an
            // in-progress upward drag, making the list unscrollable while
            // streaming.
            maintainVisibleContentPosition={{
              autoscrollToBottomThreshold,
              startRenderingFromBottom: true,
            }}
            onScroll={onScroll}
            onScrollBeginDrag={onScrollBeginDrag}
            onScrollEndDrag={onScrollEndDrag}
            onMomentumScrollEnd={onMomentumScrollEnd}
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

      <GoalBanner
        goal={selectedThread?.goal ?? null}
        onPress={() => setIsGoalSheetOpen(true)}
      />

      <QueuedTurns
        queuedTurns={queuedTurns}
        canSteer={capabilities.supports_steering}
        onRemove={handleRemoveQueuedTurn}
        onSteer={handleSteerQueuedTurn}
        onEdit={handleEditQueuedTurn}
      />

      {/* The keyboard already covers the home indicator, so keeping the inset
          while it is up would float the composer above the keyboard. */}
      <View style={{ paddingBottom: isKeyboardVisible ? 0 : insets.bottom }}>
        <ChatInput
          textInputRef={composerInputRef}
          value={draft}
          onChangeText={setDraft}
          onSubmit={() => void submitTurn()}
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
            isSubmitting || !isEncrypted || Boolean(attachmentSendBlockReason)
          }
          sendDisabledReason={
            isSubmitting
              ? "Message is being sent"
              : !isEncrypted
                ? (sessionSendBlockReason(syncStatus) ?? "Reconnect to send")
                : (attachmentSendBlockReason ?? undefined)
          }
          attachments={attachments}
          skills={workspace?.skills ?? []}
          models={models}
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
          isRunning={isThreadRunning}
          isStopping={isStopping}
          capabilities={capabilities}
          selectedPermissionMode={selectedPermissionMode}
          selectedSandboxMode={selectedSandboxMode}
          onSelectPermissionMode={handlePermissionModeChange}
          onSelectSandboxMode={handleSandboxModeChange}
          onGoalCommand={() => setIsGoalSheetOpen(true)}
        />
      </View>

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
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  headerLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginRight: theme.spacing[3],
  },
  headerTitle: {
    flex: 1,
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
