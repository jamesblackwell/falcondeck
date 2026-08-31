import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  approvalPolicyForProvider,
  base64ToBytes,
  bootstrapSessionCrypto,
  buildPairingPublicKeyBundle,
  buildProjectGroups,
  bytesToBase64,
  captureRelayDisplayFrame,
  countAwaitingResponseThreads,
  conversationItemsForSelection,
  currentTurnPlan,
  wasTurnInterruptedByShutdown,
  DEFAULT_REMOTE_RELAY_URL,
  decryptJson,
  decryptUtf8Batch,
  encryptedPayloadIsSoleSnapshotEvent,
  decodeSecurePairingCode,
  deriveThreadAttentionPresentation,
  deriveExtensionPanels,
  deriveExtensionSidebarFilters,
  deriveComposerSuggestions,
  deriveThreadTags,
  THREAD_TAGS_ACTION_ID,
  THREAD_TAGS_EXTENSION_ID,
  deriveIdentityKeyPair,
  encryptJson,
  fetchWithTimeout,
  filesToImageInputs,
  forkThread,
  HandoffIncompleteError,
  handoffBlockedReason,
  handoffDestinationSettings,
  handoffThread,
  generateBoxKeyPair,
  generateUserItemId,
  imageAttachmentSendBlockReason,
  isDaemonRpcReady,
  identityPublicKeyToBase64,
  operationalConditionDismissalKey,
  parseCompactThreadCommand,
  workspaceOperationalConditions,
  mergeFailedComposerAttachments,
  mergeFailedComposerDraft,
  missionCommandAvailable,
  mergeThreadDetailPage,
  normalizeDaemonSnapshot,
  normalizeRelayUrl,
  normalizePreferences,
  normalizeThreadDetail,
  normalizeThreadHandle,
  normalizeThreadSummary,
  composerProviderFor,
  composerSelectionFor,
  draftKeyFor,
  providerForThread,
  publicKeyToBase64,
  relayBacklogWouldOverflow,
  relayRpcFailureMessage,
  RELAY_RPC_TIMEOUT_MS,
  WEBSOCKET_CONNECT_TIMEOUT_MS,
  reconcileSnapshotSelection,
  resolvePersistedMode,
  resolvePermissionMode,
  resolveRelayTruncationCursor,
  resolveServiceTier,
  restoreBoxKeyPair,
  tryNormalizeRelayUrl,
  RELAY_DISPLAY_FRAME_MAX_ENCRYPTED,
  relayReconnectDelayMs,
  returnUnprocessedRelayUpdates,
  selectPresenceFromRelayBatch,
  shouldIgnoreReplaySnapshotEvent,
  shouldYieldBeforeRelayDisplayFlush,
  shouldYieldRelayDisplayFrame,
  yieldRelayDisplayFrame,
  composerSkillCatalog,
  normalizeSkillSummaries,
  selectedSkillsFromText,
  serviceTierForTurn,
  speechSynthesisBlob,
  STANDARD_SERVICE_TIER,
  THREAD_DETAIL_OLDER_PAGE_LIMIT,
  THREAD_DETAIL_TAIL_LIMIT,
  upsertComposerDraft,
  updateAttachmentPreparationCount,
  validateImageAttachmentBudget,
  withComposerProvider,
  withComposerSelection,
  secretKeyToBase64,
  shouldReusePersistedRemoteSession,
  signPairingClaimChallenge,
  signPairingAuthorityClientBundle,
  REMOTE_SESSION_STORAGE_VERSION,
  verifyPairingPublicKeyBundle,
  verifyPairingAuthorityDaemonBundle,
  verifySessionKeyMaterial,
  workspaceAgentCapabilities,
  threadAgentCapabilities,
  workspaceCollaborationModes,
  workspaceModels,
  workspaceProviderOptions,
  threadForSelection,
  type AgentProvider,
  type LiveSkillCatalog,
  type SkillSummary,
  type AttachmentPreparationCounts,
  type ClaimPairingRequest,
  type ClaimPairingResponse,
  type ComposerDrafts,
  type ConversationItem,
  type DaemonSnapshot,
  type ComposerSuggestion,
  type EncryptedEnvelope,
  type EventEnvelope,
  type ExtensionActionResponse,
  type ExtensionUiActionBinding,
  type ForkThreadApi,
  type GitStatusResponse,
  type ImageInput,
  type InteractiveResponsePayload,
  type MachinePresence,
  type OperationalCondition,
  type PairingChallengeRequest,
  type PairingChallengeResponse,
  type PersistedComposerSelection,
  type PersistedComposerState,
  type PersistedRemoteSession,
  type ProjectGroup,
  type QueuedRemoteAction,
  type RelayServerMessage,
  type RelayRpcFailureCode,
  type RelayWebSocketTicketResponse,
  type RelayUpdate,
  type SessionCryptoState,
  type ShipThreadMode,
  type ShipThreadResponse,
  type ThreadDetail,
  type ThreadHandle,
  type ThreadSortMode,
  type ThreadSummary,
  type ThreadTag,
  type UpdatePreferencesPayload,
  type WorkspaceColorId,
  optimisticallySetThreadStage,
  encryptedDaemonEventEnvelope,
} from "@falcondeck/client-core";
import {
  Conversation,
  InterruptedTurnNotice,
  ComposerSuggestionPill,
  GoalBubble,
  GoalControl,
  InteractiveRequestBar,
  PlanBar,
  PromptInput,
  QueuedTurns,
  SessionHeader,
  ShipMenu,
  OperationalNotice,
  ExtensionPanel,
  ExtensionAppPanel,
  ExtensionPanelNavigation,
  WorkspaceSidebar,
  realtimeAudioPlayer,
  useReadAloud,
  useShipThread,
} from "@falcondeck/chat-ui";
import { useExtensionApps } from "@falcondeck/extension-sdk/app-host";
import type { ExtensionAppViewScope } from "@falcondeck/extension-sdk/app";
import {
  ActivityDiamond,
  Badge,
  Button,
  PANEL_TRANSITION_MS,
  ToastProvider,
  TooltipProvider,
  useToast,
  usePresence,
} from "@falcondeck/ui";

import { PanelLeft, Settings, X } from "lucide-react";

import { RemoteConnectionHelpCard } from "./components/RemoteConnectionHelpCard";
import { RemotePairingScreen } from "./components/RemotePairingScreen";
import {
  applyDaemonEventsToSnapshot,
  applyDaemonEventsToThreadDetail,
  applyDaemonEventsToThreadItems,
  AwaitedActionTimeoutError,
  AWAITED_ACTION_TIMEOUT_MS,
  bufferSnapshotRaceEvent,
  clearSnapshotRaceBuffer,
  canWarmStartFromSnapshotCache,
  canPostNotifications,
  clearClientKeyPairSecret,
  clearPairingParamsFromUrl,
  clearPersistedRemoteSession,
  clearPersistedRemoteSnapshot,
  clearPendingActionIds,
  collectConversationItemUpdates,
  connectionBadgeState,
  boundRetainedThreadItems,
  createSnapshotCacheScheduler,
  deriveConnectionHelpState,
  encryptedRpcErrorMessage,
  forgetPendingActionAfterError,
  getDeviceLabel,
  isAbortError,
  isInvalidSavedSessionError,
  loadNotificationPreference,
  loadOrCreateClientKeyPair,
  loadPendingActionIds,
  loadPersistedRemoteSession,
  loadPersistedRemoteSnapshot,
  loadPersistedSelection,
  loadThreadSortMode,
  markInteractiveRequestResolved,
  maskIdentifier,
  parseDaemonEvents,
  persistClientKeyPairSecret,
  persistNotificationPreference,
  persistPendingActionIds,
  persistRemoteSession,
  persistRemoteSnapshot,
  persistSelection,
  persistThreadSortMode,
  postThreadNotification,
  reasoningOptions,
  relayHostLabel,
  resolveRestoredSelection,
  resumePendingActions,
  scheduleVisibilityAwareFlush,
  sendRelayMessage,
  shouldApplyReplayPresence,
  snapshotRetryDelayMs,
  waitForPollInterval,
  type NotificationPreference,
  type SnapshotCacheScheduler,
} from "./lib/remoteAppUtils";
import { extensionFrontendLoaders } from "virtual:falcondeck-extension-frontends";

import {
  readPersistedComposerState,
  readStoredDrafts,
  writePersistedComposerState,
  writeStoredDrafts,
} from "./lib/composer-persistence";

const loadRemotePreferencesModal = () =>
  import("./components/RemotePreferencesModal");
const RemotePreferencesModal = lazy(() =>
  loadRemotePreferencesModal().then((module) => ({
    default: module.RemotePreferencesModal,
  })),
);
const CommandPalette = lazy(() =>
  import("@falcondeck/chat-ui/command-palette").then((module) => ({
    default: module.CommandPalette,
  })),
);

const DEFAULT_RELAY_URL = DEFAULT_REMOTE_RELAY_URL;
// The relay disconnects peers silent for 45s; the daemon pings every 15s.
const RELAY_PING_INTERVAL_MS = 15_000;
// Only treat a connection as healthy (and reset backoff) after it stays open this long.
const RELAY_BACKOFF_RESET_MS = 10_000;
const MAX_PENDING_ENCRYPTED_UPDATES = 1_000;
const MAX_PENDING_SNAPSHOT_EVENTS = 1_000;
// Stable empty array so conversations without attachments don't bust the
// memoized PromptInput on every render.
const NO_ATTACHMENTS: ImageInput[] = [];
const NO_CONVERSATION_ITEMS: ConversationItem[] = [];
// Retry cadence for asking the daemon to republish the session bootstrap
// while the connection is up but the session data key is missing.
const BOOTSTRAP_REQUEST_RETRY_MS = 30_000;

function rememberPendingAction(sessionId: string, actionId: string) {
  const ids = new Set(loadPendingActionIds(sessionId));
  ids.add(actionId);
  persistPendingActionIds(sessionId, [...ids]);
}

function forgetPendingAction(sessionId: string, actionId: string) {
  const ids = loadPendingActionIds(sessionId).filter(
    (value) => value !== actionId,
  );
  persistPendingActionIds(sessionId, ids);
}

function lastAgentItemId(items: ConversationItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item.kind !== "user_message") return item.id;
  }
  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <div className="flex h-[100dvh] flex-col overflow-hidden bg-surface-0">
          <aside
            aria-label="Alpha notice"
            className="shrink-0 border-b border-warning/25 bg-warning-muted px-3 py-1 text-center text-[length:var(--fd-text-xs)] text-warning"
          >
            <span className="font-semibold uppercase tracking-[0.12em]">
              Alpha
            </span>
            <span aria-hidden="true"> · </span>
            FalconDeck Remote is largely untested. We recommend the iOS or Mac
            app for primary use.
          </aside>
          <div className="min-h-0 flex-1">
            <RemoteApp />
          </div>
        </div>
      </TooltipProvider>
    </ToastProvider>
  );
}

function RemoteApp() {
  const { toast } = useToast();
  const params = new URLSearchParams(window.location.search);
  const persistedSession = shouldReusePersistedRemoteSession(
    params,
    loadPersistedRemoteSession(),
  );
  const [initialPersistedSession] = useState(persistedSession);
  const [initialPersistedSnapshot] = useState(() =>
    loadPersistedRemoteSnapshot(persistedSession?.sessionId ?? null),
  );
  const canWarmStart =
    !!persistedSession &&
    !!initialPersistedSnapshot &&
    canWarmStartFromSnapshotCache(
      initialPersistedSnapshot.lastReceivedSeq,
      persistedSession.lastReceivedSeq ?? 0,
    );
  // The snapshot cache is only a UI warm-start hint. It does not contain all
  // durable relay state, so the persisted relay cursor remains authoritative
  // for replay and prevents skipped conversation/action updates.
  const initialReplayCursor = persistedSession?.lastReceivedSeq ?? 0;
  const [relayUrl, setRelayUrl] = useState(
    () =>
      tryNormalizeRelayUrl(
        params.get("relay") ??
          persistedSession?.relayUrl ??
          import.meta.env.VITE_FALCONDECK_RELAY_URL ??
          DEFAULT_REMOTE_RELAY_URL,
      ) ?? DEFAULT_REMOTE_RELAY_URL,
  );
  const [pairingCode, setPairingCode] = useState(
    params.get("code") ?? persistedSession?.pairingCode ?? "",
  );
  const [pairingId, setPairingId] = useState<string | null>(
    persistedSession?.pairingId ?? null,
  );
  const [sessionId, setSessionId] = useState<string | null>(
    persistedSession?.sessionId ?? null,
  );
  const [deviceId, setDeviceId] = useState<string | null>(
    persistedSession?.deviceId ?? null,
  );
  const [clientToken, setClientToken] = useState<string | null>(
    persistedSession?.clientToken ?? null,
  );
  const [connectionStatus, setConnectionStatus] = useState("not connected");
  const [machinePresence, setMachinePresence] =
    useState<MachinePresence | null>(null);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(() =>
    canWarmStart ? (initialPersistedSnapshot?.snapshot ?? null) : null,
  );
  const threadTags = useMemo(
    () => deriveThreadTags(snapshot?.extensions),
    [snapshot?.extensions],
  );
  // The offer each thread has waved away, by thread id. A new turn produces a
  // new offer key, so suggestions come back on their own; deliberately not
  // persisted, and bounded by the number of threads rather than by how many
  // times the user has dismissed something.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<
    Readonly<Record<string, string>>
  >({});
  const extensionSidebarFilters = useMemo(
    () => deriveExtensionSidebarFilters(snapshot?.extensions),
    [snapshot?.extensions],
  );
  const extensionPanels = useMemo(
    () => deriveExtensionPanels(snapshot?.extensions),
    [snapshot?.extensions],
  );
  const extensionApps = useExtensionApps(
    snapshot?.extensions.catalog
      .filter((extension) => extension.enabled)
      .map((extension) => extension.id) ?? [],
    extensionFrontendLoaders,
  );
  const threadTagsEnabled =
    snapshot?.extensions.catalog.some(
      (extension) =>
        extension.id === THREAD_TAGS_EXTENSION_ID && extension.enabled,
    ) ?? false;
  const [threadItems, setThreadItems] = useState<
    Record<string, ConversationItem[]>
  >({});
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const threadDetailRef = useRef<ThreadDetail | null>(null);
  const [loadingOlderThreadKey, setLoadingOlderThreadKey] = useState<
    string | null
  >(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeExtensionPanelKey, setActiveExtensionPanelKey] = useState<
    string | null
  >(null);
  const activeExtensionPanel = useMemo(
    () =>
      extensionPanels.find((panel) => panel.key === activeExtensionPanelKey) ??
      null,
    [activeExtensionPanelKey, extensionPanels],
  );
  const activeExtension = activeExtensionPanel
    ? (snapshot?.extensions.catalog.find(
        (extension) => extension.id === activeExtensionPanel.extensionId,
      ) ?? null)
    : null;
  const activeExtensionRegistration = activeExtensionPanel
    ? (extensionApps
        .get(activeExtensionPanel.extensionId)
        ?.panels.find(
          (panel) => panel.id === activeExtensionPanel.contributionId,
        ) ?? null)
    : null;
  useEffect(() => {
    if (activeExtensionPanelKey && !activeExtensionPanel) {
      setActiveExtensionPanelKey(null);
    }
  }, [activeExtensionPanel, activeExtensionPanelKey]);
  const [windowFocused, setWindowFocused] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [dismissedConditionVersions, setDismissedConditionVersions] = useState<
    Set<string>
  >(() => new Set());
  const [drafts, setDrafts] = useState<ComposerDrafts>(() =>
    readStoredDrafts(),
  );
  const [attachmentsByConversation, setAttachmentsByConversation] = useState<
    Record<string, ImageInput[]>
  >({});
  const [attachmentPreparationCounts, setAttachmentPreparationCounts] =
    useState<AttachmentPreparationCounts>({});
  const [selectedProvider, setSelectedProvider] =
    useState<AgentProvider>("codex");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<
    string | null
  >(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>("medium");
  // Tier id while fast mode is on; null is the provider's standard tier.
  const [selectedServiceTier, setSelectedServiceTier] = useState<string | null>(
    null,
  );
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<
    string | null
  >(null);
  const [selectedSandboxMode, setSelectedSandboxMode] = useState<string | null>(
    null,
  );
  const [persistedComposerSelections, setPersistedComposerSelections] =
    useState<PersistedComposerState>(() => readPersistedComposerState());
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffPendingThreadKey, setHandoffPendingThreadKey] = useState<
    string | null
  >(null);
  const handoffPendingRef = useRef(false);

  // Each conversation keeps its own unsent input, keyed by workspace + thread
  // ('new' for a thread not yet created), so navigating never carries text or
  // attachments across. Draft text is device-local persistent; attachments
  // follow their conversation for the session only.
  const conversationKey = draftKeyFor(selectedWorkspaceId, selectedThreadId);
  const isPreparingSelectedHandoff =
    handoffPendingThreadKey === conversationKey;
  const conversationKeyRef = useRef(conversationKey);
  const draft = drafts[conversationKey]?.text ?? "";
  const attachments =
    attachmentsByConversation[conversationKey] ?? NO_ATTACHMENTS;
  const preparingAttachmentCount =
    attachmentPreparationCounts[conversationKey] ?? 0;
  const attachmentsByConversationRef = useRef(attachmentsByConversation);
  const attachmentPreparationCountsRef = useRef(attachmentPreparationCounts);

  useLayoutEffect(() => {
    conversationKeyRef.current = conversationKey;
  }, [conversationKey]);

  const setDraftForConversation = useCallback((key: string, value: string) => {
    setDrafts((current) => {
      const next = upsertComposerDraft(current, key, value);
      if (next !== current) writeStoredDrafts(next);
      return next;
    });
  }, []);

  const setDraft = useCallback(
    (value: string) => setDraftForConversation(conversationKey, value),
    [conversationKey, setDraftForConversation],
  );

  const setAttachmentsForConversation = useCallback(
    (key: string, updater: (current: ImageInput[]) => ImageInput[]) => {
      const current = attachmentsByConversationRef.current;
      const nextAttachments = updater(current[key] ?? NO_ATTACHMENTS);
      let next = current;
      if (nextAttachments.length === 0) {
        if (key in current) {
          next = { ...current };
          delete next[key];
        }
      } else if (nextAttachments !== current[key]) {
        next = { ...current, [key]: nextAttachments };
      }
      if (next === current) return;
      attachmentsByConversationRef.current = next;
      setAttachmentsByConversation(next);
    },
    [],
  );
  const updateAttachmentPreparation = useCallback(
    (key: string, delta: number) => {
      const current = attachmentPreparationCountsRef.current;
      const next = updateAttachmentPreparationCount(current, key, delta);
      if (next === current) return;
      attachmentPreparationCountsRef.current = next;
      setAttachmentPreparationCounts(next);
    },
    [],
  );
  const restoreFailedSubmission = useCallback(
    (key: string, failedDraft: string, failedAttachments: ImageInput[]) => {
      setDrafts((current) => {
        const restored = mergeFailedComposerDraft(
          failedDraft,
          current[key]?.text ?? "",
        );
        const next = upsertComposerDraft(current, key, restored);
        if (next !== current) writeStoredDrafts(next);
        return next;
      });
      setAttachmentsForConversation(key, (current) =>
        mergeFailedComposerAttachments(failedAttachments, current),
      );
    },
    [setAttachmentsForConversation],
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isClaimingPairing, setIsClaimingPairing] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  // Keeps the projects drawer in the tree long enough to slide back out.
  const projectsDrawer = usePresence(showProjects, PANEL_TRANSITION_MS);
  const [showPreferences, setShowPreferences] = useState(false);
  const [paletteRequestKey, setPaletteRequestKey] = useState(0);
  const [notificationPreference, setNotificationPreference] =
    useState<NotificationPreference>(() => loadNotificationPreference());
  const [threadSort, setThreadSort] = useState<ThreadSortMode>(() =>
    loadThreadSortMode(),
  );
  // Distinguishes the very first connect from a retry after a drop so the
  // offline banner can stay put across the whole backoff cycle.
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const selectionSeedRef = useRef<string | null>(null);
  const sendingConversationKeyRef = useRef<string | null>(null);
  const sendingBaselineAgentItemIdRef = useRef<string | null>(null);
  const threadSettingsRequestRef = useRef(0);
  const notifiedAttentionRef = useRef(new Map<string, string>());
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const suppressReconnectRef = useRef(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [snapshotRetryGeneration, setSnapshotRetryGeneration] = useState(0);
  const snapshotRetryAttemptRef = useRef(0);

  useLayoutEffect(() => {
    threadDetailRef.current = threadDetail;
  }, [threadDetail]);

  const requestCounter = useRef(1);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionCryptoRef = useRef<SessionCryptoState | null>(null);
  const clientKeyPairRef = useRef<ReturnType<typeof generateBoxKeyPair> | null>(
    null,
  );
  const trustedDaemonPublicKeyRef = useRef<string | null>(
    persistedSession?.daemonPublicKey ?? null,
  );
  const trustedDaemonIdentityPublicKeyRef = useRef<string | null>(
    persistedSession?.daemonIdentityPublicKey ?? null,
  );
  const pendingEncryptedUpdatesRef = useRef<RelayUpdate[]>([]);
  const evictedWhileParkedRef = useRef(false);
  const pendingTruncationNextSeqRef = useRef<number | null>(null);
  const syncedPresenceFloorRef = useRef<number | null>(null);
  const pendingSnapshotEventsRef = useRef<EventEnvelope[]>([]);
  const pendingSnapshotSeqsRef = useRef(new Set<number>());
  const pendingSnapshotOverflowedRef = useRef(false);
  const pendingSnapshotCursorRef = useRef<number | null>(null);
  const snapshotPresentRef = useRef(false);
  const snapshotRequestInFlightRef = useRef(false);
  const lastReceivedSeqRef = useRef(initialReplayCursor);
  const pendingSessionPersistRef =
    useRef<Partial<PersistedRemoteSession> | null>(null);
  const sessionPersistTimerRef = useRef<number | null>(null);
  const pendingSnapshotCacheRef = useRef<{
    sessionId: string;
    snapshot: DaemonSnapshot;
    lastReceivedSeq: number;
  } | null>(null);
  const snapshotCacheSchedulerRef = useRef<SnapshotCacheScheduler | null>(null);
  const pendingRelayUpdatesRef = useRef<RelayUpdate[]>([]);
  const ephemeralAudioChainRef = useRef<Promise<void>>(Promise.resolve());
  // Cancels whichever scheduling mechanism the pending flush was booked on
  // (rAF when visible, a timer when the tab is hidden).
  const cancelRelayFlushRef = useRef<(() => void) | null>(null);
  const relayFlushInProgressRef = useRef(false);
  const relayFlushGenerationRef = useRef(0);
  // The relay socket closes over the scheduler from the render that opened
  // it; routing through a ref keeps a long-lived socket calling the current
  // flush rather than one pinned to stale state.
  const flushRelayUpdatesRef = useRef<() => void>(() => {});
  const restoredSelectionRef = useRef(false);
  const desktopOnlineRef = useRef(false);
  const pendingActionPollsRef = useRef(new Set<AbortController>());
  const pendingRpc = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timeout: number;
        method: string;
      }
    >(),
  );

  const isConnected = !!sessionId;

  useEffect(() => {
    if (!isConnected) return;
    const handleCommandPaletteShortcut = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      event.preventDefault();
      setPaletteRequestKey((current) => current + 1);
    };
    window.addEventListener("keydown", handleCommandPaletteShortcut);
    return () =>
      window.removeEventListener("keydown", handleCommandPaletteShortcut);
  }, [isConnected]);
  const relayConnected = connectionStatus.startsWith("connected");
  const hasSessionKey = !!sessionCryptoRef.current;
  const isEncrypted = relayConnected && hasSessionKey;
  const desktopOnline = machinePresence?.daemon_connected ?? false;
  const daemonPresenceKnown = machinePresence !== null;
  const daemonRpcReady = isDaemonRpcReady(machinePresence);
  const selectedThreadItems = useMemo(
    () =>
      selectedThreadId
        ? (threadItems[selectedThreadId] ?? NO_CONVERSATION_ITEMS)
        : NO_CONVERSATION_ITEMS,
    [selectedThreadId, threadItems],
  );
  const connectionHelp = useMemo(
    () =>
      deriveConnectionHelpState({
        connectionStatus,
        desktopOnline,
        error,
        hasSessionKey,
        isConnected,
        isReconnecting: hasConnectedOnce,
      }),
    [
      connectionStatus,
      desktopOnline,
      error,
      hasConnectedOnce,
      hasSessionKey,
      isConnected,
    ],
  );
  const connectionDebugRows = useMemo(
    () =>
      [
        ["Relay", relayHostLabel(relayUrl.trim() || DEFAULT_RELAY_URL)],
        ["Pairing code", pairingCode.trim() ? "present in browser" : "not set"],
        ["Session", isConnected ? "claimed" : "not claimed"],
        [
          "Desktop",
          !daemonPresenceKnown
            ? "waiting for presence"
            : desktopOnline
              ? "online"
              : "offline or retrying",
        ],
        [
          "Snapshot RPC",
          !daemonPresenceKnown
            ? "waiting for presence"
            : daemonRpcReady
              ? "ready"
              : "not registered",
        ],
        ["Encryption", hasSessionKey ? "ready" : "waiting"],
        ["Connection", connectionStatus],
        ["Session ID", maskIdentifier(sessionId)],
        ["Device ID", maskIdentifier(deviceId)],
        ["Last seq", String(lastReceivedSeqRef.current)],
      ] as const,
    [
      connectionStatus,
      daemonPresenceKnown,
      daemonRpcReady,
      desktopOnline,
      deviceId,
      hasSessionKey,
      isConnected,
      pairingCode,
      relayUrl,
      sessionId,
    ],
  );

  const abortPendingActionPolls = useCallback(() => {
    for (const controller of pendingActionPollsRef.current) {
      controller.abort();
    }
    pendingActionPollsRef.current.clear();
  }, []);

  const cancelRelayFlush = useCallback(() => {
    cancelRelayFlushRef.current?.();
    cancelRelayFlushRef.current = null;
  }, []);

  const writePendingSnapshotCache = useCallback(() => {
    const pending = pendingSnapshotCacheRef.current;
    pendingSnapshotCacheRef.current = null;
    if (!pending) return;

    persistRemoteSnapshot(
      pending.sessionId,
      pending.snapshot,
      pending.lastReceivedSeq,
    );
  }, []);

  // Created once; the write closure reads refs, so the scheduler survives
  // every render without re-arming its timer.
  if (snapshotCacheSchedulerRef.current === null) {
    snapshotCacheSchedulerRef.current = createSnapshotCacheScheduler(
      writePendingSnapshotCache,
    );
  }
  const snapshotCacheScheduler = snapshotCacheSchedulerRef.current;

  const resetSavedRemoteConnection = useCallback(() => {
    suppressReconnectRef.current = true;
    abortPendingActionPolls();
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sessionPersistTimerRef.current !== null) {
      window.clearTimeout(sessionPersistTimerRef.current);
      sessionPersistTimerRef.current = null;
    }
    snapshotCacheScheduler.cancel();
    pendingSnapshotCacheRef.current = null;
    clearPersistedRemoteSnapshot(sessionId);
    cancelRelayFlush();
    relayFlushGenerationRef.current += 1;
    for (const pending of pendingRpc.current.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Remote connection was reset"));
    }
    pendingRpc.current.clear();
    socketRef.current?.close();
    socketRef.current = null;
    sessionCryptoRef.current = null;
    clientKeyPairRef.current = null;
    trustedDaemonPublicKeyRef.current = null;
    trustedDaemonIdentityPublicKeyRef.current = null;
    pendingEncryptedUpdatesRef.current = [];
    evictedWhileParkedRef.current = false;
    pendingTruncationNextSeqRef.current = null;
    syncedPresenceFloorRef.current = null;
    snapshotRetryAttemptRef.current = 0;
    pendingSnapshotEventsRef.current = [];
    pendingSnapshotSeqsRef.current.clear();
    pendingSnapshotOverflowedRef.current = false;
    pendingSnapshotCursorRef.current = null;
    pendingSessionPersistRef.current = null;
    pendingRelayUpdatesRef.current = [];
    lastReceivedSeqRef.current = 0;
    clearPersistedRemoteSession(sessionId);
    persistSelection(sessionId, null);
    restoredSelectionRef.current = false;
    clearPendingActionIds(sessionId);
    clearClientKeyPairSecret();
    setPairingId(null);
    setSessionId(null);
    setDeviceId(null);
    setClientToken(null);
    setConnectionStatus("not connected");
    setMachinePresence(null);
    setSnapshot(null);
    setThreadItems({});
    setThreadDetail(null);
    setSelectedWorkspaceId(null);
    setSelectedThreadId(null);
    setError(null);
  }, [
    abortPendingActionPolls,
    cancelRelayFlush,
    snapshotCacheScheduler,
    sessionId,
  ]);

  const persistCurrentSession = useCallback(
    (overrides?: Partial<PersistedRemoteSession>) => {
      if (!sessionId || !clientToken || !deviceId || !clientKeyPairRef.current)
        return;
      persistRemoteSession({
        version: REMOTE_SESSION_STORAGE_VERSION,
        relayUrl: relayUrl.trim(),
        pairingCode: pairingCode.trim(),
        pairingId,
        sessionId,
        deviceId,
        clientToken,
        clientSecretKey: secretKeyToBase64(clientKeyPairRef.current),
        daemonPublicKey: trustedDaemonPublicKeyRef.current,
        daemonIdentityPublicKey: trustedDaemonIdentityPublicKeyRef.current,
        dataKey: sessionCryptoRef.current
          ? bytesToBase64(sessionCryptoRef.current.dataKey)
          : null,
        lastReceivedSeq: lastReceivedSeqRef.current,
        ...overrides,
      });
    },
    [clientToken, deviceId, pairingCode, pairingId, relayUrl, sessionId],
  );

  const flushPersistedSession = useCallback(() => {
    if (sessionPersistTimerRef.current !== null) {
      window.clearTimeout(sessionPersistTimerRef.current);
      sessionPersistTimerRef.current = null;
    }

    const pending = pendingSessionPersistRef.current;
    pendingSessionPersistRef.current = null;
    if (!pending) return;

    persistCurrentSession(pending);
  }, [persistCurrentSession]);

  const flushPersistedSnapshotCache = useCallback(() => {
    snapshotCacheScheduler.flush();
  }, [snapshotCacheScheduler]);

  const schedulePersistCurrentSession = useCallback(
    (
      overrides?: Partial<PersistedRemoteSession>,
      options?: {
        immediate?: boolean;
      },
    ) => {
      pendingSessionPersistRef.current = {
        ...(pendingSessionPersistRef.current ?? {}),
        ...(overrides ?? {}),
      };

      if (options?.immediate) {
        flushPersistedSession();
        return;
      }

      if (sessionPersistTimerRef.current !== null) {
        return;
      }

      sessionPersistTimerRef.current = window.setTimeout(() => {
        flushPersistedSession();
      }, 400);
    },
    [flushPersistedSession],
  );

  // Snapshot writes are intentionally trailing and spaced at least
  // SNAPSHOT_CACHE_MIN_INTERVAL_MS apart: a stream can produce many state
  // updates per second, and each write stringifies the whole snapshot, so the
  // pending image keeps refreshing while localStorage only sees stable
  // warm-start images instead of becoming part of the hot path.
  useEffect(() => {
    if (!sessionId || !snapshot) return;

    pendingSnapshotCacheRef.current = {
      sessionId,
      snapshot,
      lastReceivedSeq: lastReceivedSeqRef.current,
    };
    snapshotCacheScheduler.schedule();
  }, [snapshotCacheScheduler, sessionId, snapshot]);

  const failCurrentConnection = useCallback(
    (message: string) => {
      // Transient failures (malformed frames, socket errors) must NOT strip
      // the session data key — a keyless client can only recover through an
      // explicit bootstrap request. Key material is cleared only when the
      // relay invalidates the saved session (isInvalidSavedSessionError) or
      // the user resets the saved connection.
      pendingEncryptedUpdatesRef.current = [];
      evictedWhileParkedRef.current = false;
      pendingTruncationNextSeqRef.current = null;
      syncedPresenceFloorRef.current = null;
      pendingRelayUpdatesRef.current = [];
      cancelRelayFlush();
      schedulePersistCurrentSession(
        {
          lastReceivedSeq: lastReceivedSeqRef.current,
        },
        { immediate: true },
      );
      setError(message);
      socketRef.current?.close();
    },
    [cancelRelayFlush, schedulePersistCurrentSession],
  );

  useEffect(() => {
    if (initialPersistedSession?.clientSecretKey) {
      try {
        clientKeyPairRef.current = restoreBoxKeyPair(
          initialPersistedSession.clientSecretKey,
        );
        persistClientKeyPairSecret(initialPersistedSession.clientSecretKey);
        if (initialPersistedSession.dataKey) {
          sessionCryptoRef.current = {
            dataKey: base64ToBytes(initialPersistedSession.dataKey),
            material: null,
          };
        }
      } catch {
        clearPersistedRemoteSession(initialPersistedSession.sessionId);
      }
    } else {
      clientKeyPairRef.current = loadOrCreateClientKeyPair();
    }
  }, [initialPersistedSession]);

  useEffect(() => {
    if (sessionId && clientToken) {
      suppressReconnectRef.current = false;
    }
  }, [clientToken, sessionId]);

  const pollQueuedAction = useCallback(
    async <T = unknown,>(
      actionId: string,
      options?: {
        signal?: AbortSignal;
        sessionIdOverride?: string | null;
        clientTokenOverride?: string | null;
        /** Stop waiting after this long; background polls intentionally omit it. */
        timeoutMs?: number;
      },
    ) => {
      const currentSessionId = options?.sessionIdOverride ?? sessionId;
      const currentClientToken = options?.clientTokenOverride ?? clientToken;
      if (!currentSessionId || !currentClientToken) {
        throw new Error("Remote session is not ready");
      }
      const deadline = options?.timeoutMs
        ? Date.now() + options.timeoutMs
        : null;
      let pollAttempt = 0;

      for (;;) {
        if (options?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (deadline !== null && Date.now() > deadline) {
          throw new AwaitedActionTimeoutError(desktopOnlineRef.current);
        }

        const response = await fetch(
          `${relayUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(currentSessionId)}/actions/${encodeURIComponent(actionId)}`,
          {
            headers: { authorization: `Bearer ${currentClientToken}` },
            signal: options?.signal,
          },
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            payload?.error ?? `Failed with status ${response.status}`,
          );
        }
        const action = (await response.json()) as QueuedRemoteAction;
        if (action.status === "completed") {
          const sc = sessionCryptoRef.current;
          if (!sc) return null as T;
          return action.result
            ? await decryptJson<T>(sc.dataKey, action.result)
            : (null as T);
        }
        if (action.status === "failed") {
          throw new Error(action.error ?? "Remote action failed");
        }
        // An answered action usually completes within the first few polls, so
        // keep the snappy 800ms cadence there, then ease off toward a 3s cap —
        // the deadline below still bounds the total wait.
        await waitForPollInterval(
          Math.min(800 * 2 ** Math.floor(pollAttempt / 4), 3_000),
          options?.signal,
        );
        pollAttempt += 1;
      }
    },
    [clientToken, relayUrl, sessionId],
  );

  useEffect(() => {
    if (!sessionId || !clientToken || !isEncrypted) return;
    return resumePendingActions({
      actionIds: loadPendingActionIds(sessionId),
      clientToken,
      sessionId,
      pendingPolls: pendingActionPollsRef.current,
      poll: pollQueuedAction,
      forget: (actionId) => forgetPendingAction(sessionId, actionId),
    });
  }, [clientToken, isEncrypted, pollQueuedAction, sessionId]);

  useEffect(() => {
    return () => {
      abortPendingActionPolls();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (sessionPersistTimerRef.current !== null) {
        window.clearTimeout(sessionPersistTimerRef.current);
      }
      flushPersistedSession();
      flushPersistedSnapshotCache();
      cancelRelayFlush();
    };
  }, [
    abortPendingActionPolls,
    cancelRelayFlush,
    flushPersistedSession,
    flushPersistedSnapshotCache,
  ]);

  useEffect(() => {
    return () => {
      abortPendingActionPolls();
    };
  }, [abortPendingActionPolls, clientToken, sessionId]);

  useEffect(() => {
    const flushOnHide = () => {
      flushPersistedSession();
      flushPersistedSnapshotCache();
    };
    const handleVisibilityChange = () => {
      setWindowFocused(
        document.visibilityState !== "hidden" && document.hasFocus(),
      );
      if (document.visibilityState === "hidden") {
        flushPersistedSession();
        flushPersistedSnapshotCache();
      }
    };
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);

    window.addEventListener("pagehide", flushOnHide);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushPersistedSession, flushPersistedSnapshotCache]);

  useEffect(() => {
    // A truncated relay history drops the snapshot and refetches it. Holding
    // the selection through that gap keeps the user on the thread they were
    // reading instead of bouncing them to the daemon's default.
    if (!snapshot) return;

    if (!restoredSelectionRef.current) {
      restoredSelectionRef.current = true;
      const restored = resolveRestoredSelection(
        snapshot,
        loadPersistedSelection(sessionId),
      );
      if (restored) {
        setSelectedWorkspaceId(restored.workspaceId);
        setSelectedThreadId(restored.threadId);
        return;
      }
    }

    const nextSelection = reconcileSnapshotSelection(
      snapshot,
      selectedWorkspaceId,
      selectedThreadId,
      {
        preserveEmptyThreadSelection: true,
      },
    );
    if (nextSelection.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(nextSelection.workspaceId);
    }
    if (nextSelection.threadId !== selectedThreadId) {
      setSelectedThreadId(nextSelection.threadId);
    }
  }, [sessionId, snapshot, selectedThreadId, selectedWorkspaceId]);

  // Survives a browser reload; the daemon has no idea which thread this
  // particular browser was looking at.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    persistSelection(sessionId, {
      workspaceId: selectedWorkspaceId,
      threadId: selectedThreadId,
    });
  }, [selectedThreadId, selectedWorkspaceId, sessionId]);

  useEffect(() => {
    desktopOnlineRef.current = desktopOnline;
  }, [desktopOnline]);

  const relayWsUrl = useMemo(() => {
    const trimmed = relayUrl.trim().replace(/\/$/, "");
    if (trimmed.startsWith("https://"))
      return `wss://${trimmed.slice("https://".length)}`;
    if (trimmed.startsWith("http://"))
      return `ws://${trimmed.slice("http://".length)}`;
    return trimmed;
  }, [relayUrl]);

  const selectedWorkspace = useMemo(
    () =>
      snapshot?.workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, snapshot?.workspaces],
  );
  const selectedThread = useMemo(
    () =>
      threadForSelection(
        snapshot?.threads ?? [],
        selectedWorkspaceId,
        selectedThreadId,
      ),
    [selectedThreadId, selectedWorkspaceId, snapshot?.threads],
  );
  const composerSuggestionOffer = useMemo(() => {
    const offer = deriveComposerSuggestions(
      snapshot?.extensions,
      selectedThreadId,
      selectedThread?.status,
    );
    if (!offer || !selectedThreadId) return offer;
    return dismissedSuggestions[selectedThreadId] === offer.key ? null : offer;
  }, [
    dismissedSuggestions,
    selectedThread?.status,
    selectedThreadId,
    snapshot?.extensions,
  ]);
  // A chosen suggestion is its own turn: it submits the offered prompt and
  // leaves whatever the user was drafting untouched.
  const handleSubmitComposerSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      void handleSubmit({ text: suggestion.prompt });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedThreadId, selectedWorkspaceId],
  );
  const handleDismissComposerSuggestions = useCallback(() => {
    const key = composerSuggestionOffer?.key;
    if (!key || !selectedThreadId) return;
    setDismissedSuggestions((current) => ({
      ...current,
      [selectedThreadId]: key,
    }));
  }, [composerSuggestionOffer?.key, selectedThreadId]);
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
  // Feeding the last build back lets buildProjectGroups return identical
  // group/thread objects while snapshot content is unchanged, so the memoized
  // sidebar sections hold still across streaming-driven snapshot churn.
  const previousGroupsRef = useRef<ProjectGroup[] | null>(null);
  const groups = useMemo(() => {
    const nextGroups = buildProjectGroups(
      snapshot?.workspaces ?? [],
      snapshot?.threads ?? [],
      snapshot?.preferences.workspace_order,
      previousGroupsRef.current,
    );
    previousGroupsRef.current = nextGroups;
    return nextGroups;
  }, [
    snapshot?.preferences.workspace_order,
    snapshot?.threads,
    snapshot?.workspaces,
  ]);
  const interactiveRequests = useMemo(
    () =>
      selectedThreadId
        ? (snapshot?.interactive_requests ?? []).filter(
            (request) =>
              request.workspace_id === selectedWorkspaceId &&
              request.thread_id === selectedThreadId,
          )
        : [],
    [selectedThreadId, selectedWorkspaceId, snapshot?.interactive_requests],
  );
  const items = useMemo(
    () =>
      conversationItemsForSelection(
        selectedWorkspaceId,
        selectedThreadId,
        threadDetail,
        selectedThreadItems,
      ),
    [selectedThreadId, selectedThreadItems, selectedWorkspaceId, threadDetail],
  );
  // The current turn's plan is pinned above the composer, not left to scroll
  // away in the transcript.
  const pinnedPlan = useMemo(() => currentTurnPlan(items), [items]);

  // Relay acceptance only means the prompt is queued for the daemon. Preserve
  // immediate feedback until the selected thread exposes real agent activity.
  useEffect(() => {
    if (!isSubmitting) return;
    if (sendingConversationKeyRef.current !== conversationKey) {
      sendingConversationKeyRef.current = null;
      setIsSubmitting(false);
      return;
    }
    const hasAgentActivity =
      lastAgentItemId(items) !== sendingBaselineAgentItemIdRef.current;
    if (
      selectedThread?.status === "running" ||
      selectedThread?.status === "waiting_for_input" ||
      selectedThread?.status === "error" ||
      hasAgentActivity
    ) {
      sendingConversationKeyRef.current = null;
      setIsSubmitting(false);
    }
  }, [conversationKey, isSubmitting, items, selectedThread?.status]);

  // ── WebSocket relay connection ─────────────────────────────────────

  useEffect(() => {
    if (!sessionId || !clientToken) return;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    relayFlushGenerationRef.current += 1;
    let isCurrent = true;
    let socket: WebSocket | null = null;
    let pingInterval: number | null = null;
    let backoffResetTimer: number | null = null;
    let connectTimeout: number | null = null;
    socketRef.current = null;
    pendingEncryptedUpdatesRef.current = [];
    evictedWhileParkedRef.current = false;
    pendingTruncationNextSeqRef.current = null;
    syncedPresenceFloorRef.current = null;
    snapshotRetryAttemptRef.current = 0;
    pendingSnapshotEventsRef.current = [];
    pendingSnapshotSeqsRef.current.clear();
    pendingSnapshotOverflowedRef.current = false;
    pendingSnapshotCursorRef.current = null;
    pendingRelayUpdatesRef.current = [];
    setConnectionStatus("connecting");
    setMachinePresence(null);
    setError(null);

    const clearSocketTimers = () => {
      if (pingInterval !== null) {
        window.clearInterval(pingInterval);
        pingInterval = null;
      }
      if (backoffResetTimer !== null) {
        window.clearTimeout(backoffResetTimer);
        backoffResetTimer = null;
      }
      if (connectTimeout !== null) {
        window.clearTimeout(connectTimeout);
        connectTimeout = null;
      }
    };

    const scheduleReconnect = () => {
      clearSocketTimers();
      if (!isCurrent) return;
      if (suppressReconnectRef.current) return;
      if (reconnectTimerRef.current !== null) return;
      setConnectionStatus("disconnected");
      setMachinePresence(null);
      for (const [reqId, pending] of pendingRpc.current.entries()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error("Relay connection closed"));
        pendingRpc.current.delete(reqId);
      }
      pendingEncryptedUpdatesRef.current = [];
      evictedWhileParkedRef.current = false;
      pendingTruncationNextSeqRef.current = null;
      syncedPresenceFloorRef.current = null;
      pendingSnapshotEventsRef.current = [];
      pendingSnapshotSeqsRef.current.clear();
      pendingSnapshotOverflowedRef.current = false;
      pendingSnapshotCursorRef.current = null;
      pendingRelayUpdatesRef.current = [];
      cancelRelayFlush();
      if (sessionId && clientToken) {
        const delay = relayReconnectDelayMs(reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          setConnectionGeneration((value) => value + 1);
        }, delay);
      }
    };

    const abandonInvalidSavedSession = (message: string) => {
      resetSavedRemoteConnection();
      setError(message);
    };

    void fetchWithTimeout(
      `${relayUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/ws-ticket`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
        },
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            payload?.error ?? `Failed with status ${response.status}`,
          );
        }
        return response.json() as Promise<RelayWebSocketTicketResponse>;
      })
      .then((ticket) => {
        if (!isCurrent) return;
        socket = new WebSocket(
          `${relayWsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket.ticket)}`,
        );
        socketRef.current = socket;
        connectTimeout = window.setTimeout(() => {
          connectTimeout = null;
          if (isCurrent && socket?.readyState === WebSocket.CONNECTING) {
            setError("Relay connection timed out; retrying");
            socket.close();
            scheduleReconnect();
          }
        }, WEBSOCKET_CONNECT_TIMEOUT_MS);

        socket.onopen = () => {
          if (!isCurrent || !socket) return;
          if (connectTimeout !== null) {
            window.clearTimeout(connectTimeout);
            connectTimeout = null;
          }
          const openSocket = socket;
          // The relay drops peers that stay silent for 45s.
          pingInterval = window.setInterval(() => {
            if (openSocket.readyState === WebSocket.OPEN) {
              sendRelayMessage(openSocket, { type: "ping" });
            }
          }, RELAY_PING_INTERVAL_MS);
          // Resetting backoff immediately would defeat it when the relay
          // closes the socket right after the handshake.
          backoffResetTimer = window.setTimeout(() => {
            backoffResetTimer = null;
            reconnectAttemptRef.current = 0;
          }, RELAY_BACKOFF_RESET_MS);
          setConnectionStatus("connected");
          setHasConnectedOnce(true);
          sendRelayMessage(openSocket, {
            type: "sync",
            after_seq: lastReceivedSeqRef.current,
          });
        };

        socket.onmessage = (message) => {
          if (!isCurrent) return;
          let payload: RelayServerMessage;
          try {
            payload = JSON.parse(message.data) as RelayServerMessage;
          } catch {
            if (isCurrent) {
              failCurrentConnection("Received malformed relay message");
            }
            return;
          }
          switch (payload.type) {
            case "ready":
              setConnectionStatus(`connected as ${payload.role}`);
              break;
            case "sync":
              if (
                relayBacklogWouldOverflow(
                  pendingRelayUpdatesRef.current.length,
                  payload.updates.length,
                )
              ) {
                failCurrentConnection(
                  "Remote event backlog exceeded the safe limit",
                );
                return;
              }
              if (payload.presence) {
                syncedPresenceFloorRef.current = payload.next_seq;
                setMachinePresence(payload.presence);
              }
              if (payload.history_truncated) {
                // Updates were lost server-side; rebuild derived state from a
                // fresh snapshot. The cursor is NOT advanced or persisted
                // here: this sync's updates have not been consumed yet (a
                // keyless browser parks them, and a disconnect clears the
                // parked buffer — advancing up front would skip them
                // permanently). The truncation's next_seq is adopted at flush
                // end instead, once nothing is parked.
                pendingTruncationNextSeqRef.current = Math.max(
                  pendingTruncationNextSeqRef.current ?? 0,
                  payload.next_seq,
                );
                snapshotPresentRef.current = false;
                setSnapshot(null);
                setThreadDetail(null);
                setThreadItems({});
              }
              pendingRelayUpdatesRef.current.push(...payload.updates);
              flushRelayUpdatesRef.current();
              break;
            case "update":
              if (
                relayBacklogWouldOverflow(
                  pendingRelayUpdatesRef.current.length,
                  1,
                )
              ) {
                failCurrentConnection(
                  "Remote event backlog exceeded the safe limit",
                );
                return;
              }
              pendingRelayUpdatesRef.current.push(payload.update);
              flushRelayUpdatesRef.current();
              break;
            case "presence":
              setMachinePresence(payload.presence);
              break;
            case "action-updated":
              break;
            case "ephemeral": {
              const envelope = encryptedDaemonEventEnvelope(payload.body);
              if (!envelope) break;
              const ephemeralGeneration = relayFlushGenerationRef.current;
              ephemeralAudioChainRef.current = ephemeralAudioChainRef.current
                .then(async () => {
                  const crypto = sessionCryptoRef.current;
                  if (
                    !crypto ||
                    !isCurrent ||
                    ephemeralGeneration !== relayFlushGenerationRef.current
                  )
                    return;
                  const events = parseDaemonEvents(
                    await decryptJson(crypto.dataKey, envelope),
                  );
                  if (
                    !isCurrent ||
                    ephemeralGeneration !== relayFlushGenerationRef.current ||
                    crypto !== sessionCryptoRef.current
                  )
                    return;
                  for (const event of events) {
                    realtimeAudioPlayer.handleEvent(event);
                    if (
                      event.event.type === "realtime-item-added" &&
                      event.thread_id
                    ) {
                      const updatesByThread = new Map([
                        [event.thread_id, [event]],
                      ]);
                      setThreadItems((current) =>
                        applyDaemonEventsToThreadItems(
                          current,
                          updatesByThread,
                        ),
                      );
                      setThreadDetail((current) =>
                        applyDaemonEventsToThreadDetail(
                          current,
                          [event],
                          updatesByThread,
                        ),
                      );
                    }
                  }
                })
                .catch((cause: unknown) => {
                  if (
                    isCurrent &&
                    ephemeralGeneration === relayFlushGenerationRef.current
                  ) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Failed to decrypt live audio event",
                    );
                  }
                });
              break;
            }
            case "rpc-result":
              if (
                payload.request_id &&
                pendingRpc.current.has(payload.request_id)
              ) {
                void resolvePendingRpc(
                  payload.request_id,
                  payload.ok,
                  payload.result ?? null,
                  payload.error ?? null,
                  payload.failure,
                );
                return;
              }
              if (!payload.ok) setError("Remote action failed");
              break;
            case "error":
              setError(payload.message);
              if (isInvalidSavedSessionError(payload.message)) {
                abandonInvalidSavedSession(payload.message);
              }
              break;
          }
        };

        socket.onclose = () => {
          scheduleReconnect();
        };
      })
      .catch((error) => {
        if (!isCurrent) return;
        const message =
          error instanceof Error ? error.message : "Could not reach the relay";
        setError(message);
        if (isInvalidSavedSessionError(message)) {
          abandonInvalidSavedSession(message);
          return;
        }
        scheduleReconnect();
      });

    return () => {
      isCurrent = false;
      relayFlushGenerationRef.current += 1;
      clearSocketTimers();
      socket?.close();
    };
  }, [
    clientToken,
    cancelRelayFlush,
    connectionGeneration,
    failCurrentConnection,
    relayUrl,
    relayWsUrl,
    resetSavedRemoteConnection,
    sessionId,
  ]);

  // ── Data-key recovery ──────────────────────────────────────────────
  // A trusted browser that still holds its client token and local key pair
  // but lost the session data key cannot use the encrypted channel. Ask the
  // daemon for a fresh bootstrap over the relay's plaintext ephemeral
  // channel; the reply arrives as a durable session-bootstrap update through
  // the normal replay path and the existing processing installs the key.
  useEffect(() => {
    if (!relayConnected || hasSessionKey || !sessionId || !clientToken) return;

    const requestBootstrap = () => {
      if (sessionCryptoRef.current) return;
      const keyPair = clientKeyPairRef.current;
      const socket = socketRef.current;
      if (!keyPair || !socket || socket.readyState !== WebSocket.OPEN) return;
      sendRelayMessage(socket, {
        type: "ephemeral",
        body: {
          kind: "request-bootstrap",
          device_id: deviceId ?? "",
          client_bundle: buildPairingPublicKeyBundle(keyPair),
        },
      });
    };

    requestBootstrap();
    const retryTimer = window.setInterval(
      requestBootstrap,
      BOOTSTRAP_REQUEST_RETRY_MS,
    );
    return () => {
      window.clearInterval(retryTimer);
    };
  }, [clientToken, deviceId, hasSessionKey, relayConnected, sessionId]);

  async function resolvePendingRpc(
    requestId: string,
    ok: boolean,
    result: EncryptedEnvelope | null,
    errorEnvelope: EncryptedEnvelope | null,
    failure: RelayRpcFailureCode | null | undefined,
  ) {
    const pending = pendingRpc.current.get(requestId);
    if (!pending) return;
    pendingRpc.current.delete(requestId);
    window.clearTimeout(pending.timeout);
    try {
      const sc = sessionCryptoRef.current;
      if (!sc) throw new Error("Encrypted relay session is not ready");
      if (ok) {
        pending.resolve(result ? await decryptJson(sc.dataKey, result) : null);
        return;
      }
      if (!errorEnvelope) {
        pending.reject(
          new Error(relayRpcFailureMessage(failure, pending.method)),
        );
        return;
      }
      const dec = await decryptJson<unknown>(sc.dataKey, errorEnvelope);
      pending.reject(new Error(encryptedRpcErrorMessage(dec)));
    } catch (e) {
      pending.reject(
        e instanceof Error ? e : new Error("Remote action failed"),
      );
    }
  }

  const bufferPendingSnapshotEvents = useCallback((events: EventEnvelope[]) => {
    const buffer = pendingSnapshotEventsRef.current;
    const seenSeqs = pendingSnapshotSeqsRef.current;
    for (const event of events) {
      if (
        bufferSnapshotRaceEvent(
          buffer,
          seenSeqs,
          event,
          MAX_PENDING_SNAPSHOT_EVENTS,
        )
      ) {
        pendingSnapshotOverflowedRef.current = true;
      }
    }
  }, []);

  const checkpointPendingSnapshotCursor = useCallback(() => {
    if (
      !snapshotPresentRef.current ||
      pendingEncryptedUpdatesRef.current.length > 0 ||
      pendingSnapshotEventsRef.current.length > 0 ||
      pendingSnapshotOverflowedRef.current
    ) {
      return;
    }

    const snapshotCursor = pendingSnapshotCursorRef.current;
    const truncationNextSeq = pendingTruncationNextSeqRef.current;
    const truncationCursor =
      truncationNextSeq === null ? null : Math.max(truncationNextSeq - 1, 0);
    if (snapshotCursor === null && truncationCursor === null) return;

    lastReceivedSeqRef.current = Math.max(
      lastReceivedSeqRef.current,
      snapshotCursor ?? 0,
      truncationCursor ?? 0,
    );
    pendingSnapshotCursorRef.current = null;
    if (truncationCursor !== null) {
      pendingTruncationNextSeqRef.current = null;
    }
    schedulePersistCurrentSession({
      lastReceivedSeq: lastReceivedSeqRef.current,
    });
  }, [schedulePersistCurrentSession]);

  // Mirrors whether a snapshot is loaded so the relay flush (which runs from
  // rAF callbacks with stale closures) can decide to buffer or apply without
  // reaching into a setState updater. If the mirror briefly lags a snapshot
  // arrival, events buffered in that window are drained here.
  useLayoutEffect(() => {
    snapshotPresentRef.current = snapshot !== null;
    if (snapshot && pendingSnapshotEventsRef.current.length > 0) {
      const buffered = pendingSnapshotEventsRef.current;
      pendingSnapshotEventsRef.current = [];
      pendingSnapshotSeqsRef.current.clear();
      pendingSnapshotOverflowedRef.current = false;
      const { passthroughEvents, updatesByThread } =
        collectConversationItemUpdates(buffered);
      setSnapshot((current) => {
        if (!current) return current;
        const next: DaemonSnapshot | null = current;
        return applyDaemonEventsToSnapshot(next, passthroughEvents) ?? current;
      });
      if (updatesByThread.size > 0) {
        setThreadItems((current) =>
          applyDaemonEventsToThreadItems(current, updatesByThread),
        );
      }
      setThreadDetail((current) =>
        applyDaemonEventsToThreadDetail(
          current,
          passthroughEvents,
          updatesByThread,
        ),
      );
    }
    checkpointPendingSnapshotCursor();
  }, [checkpointPendingSnapshotCursor, snapshot]);

  const flushRelayUpdates = useCallback(async () => {
    if (relayFlushInProgressRef.current) {
      return;
    }

    const flushGeneration = relayFlushGenerationRef.current;
    relayFlushInProgressRef.current = true;

    try {
      if (pendingRelayUpdatesRef.current.length === 0) return;
      if (flushGeneration !== relayFlushGenerationRef.current) return;
      // Capture one paint-frame batch. Updates that arrive while async
      // decryption is running stay queued for the next scheduled frame.
      const batch = captureRelayDisplayFrame(pendingRelayUpdatesRef.current);
      const daemonEvents: EventEnvelope[] = [];
      let nextPresence: MachinePresence | null | undefined;
      let highestConsumedSeq: number | null = null;
      let deferredBootstrapSeq: number | null = null;
      const flushStartedAt = Date.now();

      const batchPresence = selectPresenceFromRelayBatch(
        batch,
        syncedPresenceFloorRef.current,
      );
      if (batchPresence !== undefined) {
        nextPresence = batchPresence;
        setMachinePresence(batchPresence);
      }

      if (shouldYieldBeforeRelayDisplayFlush(batch.length)) {
        await yieldRelayDisplayFrame();
        if (flushGeneration !== relayFlushGenerationRef.current) return;
      }

      // The cursor may only advance for updates that were actually consumed;
      // otherwise a parked or failed update can never be replayed by a later
      // sync. While updates are parked the cursor must stay before them.
      const advanceCursor = (seq: number) => {
        if (pendingEncryptedUpdatesRef.current.length > 0) return;
        highestConsumedSeq = Math.max(highestConsumedSeq ?? 0, seq);
      };

      for (let index = 0; index < batch.length; index += 1) {
        const update = batch[index];

        if (update.body.t === "session-bootstrap") {
          const kp = clientKeyPairRef.current;
          if (!kp) {
            setError("Missing local pairing key material");
            advanceCursor(update.seq);
            continue;
          }
          const expectedClientPublicKey = publicKeyToBase64(kp);
          const expectedClientIdentityPublicKey = identityPublicKeyToBase64(
            deriveIdentityKeyPair(kp),
          );
          if (
            update.body.material.client_public_key !== expectedClientPublicKey
          ) {
            advanceCursor(update.seq);
            continue;
          }
          try {
            // The daemon may republish a recovery bootstrap under a newer
            // pairing lineage than the one this client originally claimed
            // (re-pairing and additional-device pairings mint fresh pairing
            // ids while reusing the session and data key). Trust is
            // anchored in the pinned daemon identity, the session id, and
            // this client's own key material, so adopt the material's
            // pairing id instead of pinning the possibly stale one.
            verifySessionKeyMaterial(update.body.material, {
              expectedSessionId: sessionId,
              expectedDaemonPublicKey: trustedDaemonPublicKeyRef.current,
              expectedDaemonIdentityPublicKey:
                trustedDaemonIdentityPublicKeyRef.current,
              expectedClientPublicKey,
              expectedClientIdentityPublicKey,
            });
            sessionCryptoRef.current = bootstrapSessionCrypto(
              kp,
              update.body.material,
            );
            trustedDaemonPublicKeyRef.current ??=
              update.body.material.daemon_public_key;
            trustedDaemonIdentityPublicKeyRef.current ??=
              update.body.material.daemon_identity_public_key;
            if (pairingId !== update.body.material.pairing_id) {
              setPairingId(update.body.material.pairing_id);
            }
            setConnectionStatus("connected as client (encrypted)");
            if (pendingEncryptedUpdatesRef.current.length > 0) {
              batch.splice(index + 1, 0, ...pendingEncryptedUpdatesRef.current);
              pendingEncryptedUpdatesRef.current = [];
              // Keep the cursor before the parked updates until the
              // inserted replay window has been consumed.
              deferredBootstrapSeq = update.seq;
            }
            if (evictedWhileParkedRef.current) {
              // Updates were evicted while parked waiting for this key, so
              // the drained window has a silent gap; drop the snapshot and
              // let the refetch effect rebuild state (it replays events
              // buffered while the RPC is in flight).
              evictedWhileParkedRef.current = false;
              snapshotPresentRef.current = false;
              setSnapshot(null);
            }
            if (deferredBootstrapSeq === null) {
              advanceCursor(update.seq);
            }
            schedulePersistCurrentSession(
              {
                pairingId: update.body.material.pairing_id,
                daemonPublicKey: trustedDaemonPublicKeyRef.current,
                daemonIdentityPublicKey:
                  trustedDaemonIdentityPublicKeyRef.current,
                dataKey: bytesToBase64(sessionCryptoRef.current.dataKey),
                lastReceivedSeq: lastReceivedSeqRef.current,
              },
              { immediate: true },
            );
          } catch (e) {
            failCurrentConnection(
              e instanceof Error
                ? e.message
                : "Failed to establish encrypted relay session",
            );
          }
          continue;
        }

        if (update.body.t === "presence") {
          if (
            shouldApplyReplayPresence(
              update.seq,
              syncedPresenceFloorRef.current,
            )
          ) {
            nextPresence = update.body.presence;
          }
          advanceCursor(update.seq);
          continue;
        }

        if (update.body.t === "action-status") {
          advanceCursor(update.seq);
          continue;
        }

        // Future relay body types may be durable but not encrypted. Older
        // clients cannot interpret them, but they must still remain
        // forward-compatible and move past the sequence rather than trying
        // to decrypt an absent envelope forever.
        if (update.body.t !== "encrypted") {
          advanceCursor(update.seq);
          continue;
        }

        const sc = sessionCryptoRef.current;
        if (!sc) {
          if (
            pendingEncryptedUpdatesRef.current.length >=
            MAX_PENDING_ENCRYPTED_UPDATES
          ) {
            console.warn(
              "Dropping oldest parked encrypted relay update; buffer is full",
            );
            pendingEncryptedUpdatesRef.current.shift();
            evictedWhileParkedRef.current = true;
            // The replay window now has a known gap. Invalidate the warm
            // state immediately instead of continuing to show or persist a
            // snapshot that can no longer be trusted until bootstrap and a
            // fresh snapshot recovery complete.
            snapshotPresentRef.current = false;
            snapshotCacheScheduler.cancel();
            pendingSnapshotCacheRef.current = null;
            clearPersistedRemoteSnapshot(sessionId);
            setSnapshot(null);
            setThreadItems({});
            setThreadDetail(null);
          }
          pendingEncryptedUpdatesRef.current.push(update);
          continue;
        }

        const encryptedRun = [update];
        const envelopes = [update.body.envelope];
        while (encryptedRun.length < RELAY_DISPLAY_FRAME_MAX_ENCRYPTED) {
          const nextUpdate = batch[index + 1];
          if (!nextUpdate || nextUpdate.body.t !== "encrypted") break;
          encryptedRun.push(nextUpdate);
          envelopes.push(nextUpdate.body.envelope);
          index += 1;
        }
        const decryptedRun = await decryptUtf8Batch(sc.dataKey, envelopes);
        if (flushGeneration !== relayFlushGenerationRef.current) return;

        const skipReplaySnapshots = snapshotRequestInFlightRef.current;
        decryptedRun.forEach((result, runIndex) => {
          const encryptedUpdate = encryptedRun[runIndex]!;
          if (result.status === "rejected") {
            // Leave this update behind the cursor unless a later update
            // succeeds, matching the single-update failure behavior.
            setError(
              result.reason instanceof Error
                ? result.reason.message
                : "Failed to decrypt relay update",
            );
            return;
          }
          const text = result.value;
          if (
            skipReplaySnapshots &&
            encryptedPayloadIsSoleSnapshotEvent(text)
          ) {
            advanceCursor(encryptedUpdate.seq);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "Failed to decrypt relay update",
            );
            return;
          }
          advanceCursor(encryptedUpdate.seq);
          const events = parseDaemonEvents(parsed);
          for (const event of events) {
            if (
              shouldIgnoreReplaySnapshotEvent(
                skipReplaySnapshots,
                event.event.type,
              )
            ) {
              continue;
            }
            realtimeAudioPlayer.handleEvent(event);
            daemonEvents.push(event);
          }
        });

        if (
          shouldYieldRelayDisplayFrame(
            flushStartedAt,
            Date.now(),
            batch.length - index - 1,
          )
        ) {
          returnUnprocessedRelayUpdates(
            pendingRelayUpdatesRef.current,
            batch.slice(index + 1),
          );
          break;
        }
      }

      if (deferredBootstrapSeq !== null) {
        advanceCursor(deferredBootstrapSeq);
      }

      if (flushGeneration !== relayFlushGenerationRef.current) return;

      if (nextPresence !== undefined) {
        setMachinePresence(nextPresence);
      }

      if (daemonEvents.length > 0) {
        const { passthroughEvents, updatesByThread } =
          collectConversationItemUpdates(daemonEvents);
        const hasSnapshotEvent = passthroughEvents.some(
          (event) => event.event.type === "snapshot",
        );
        if (!snapshotPresentRef.current && !hasSnapshotEvent) {
          // While snapshot.current is in flight the snapshot is null and
          // events cannot be applied safely. Park every daemon event,
          // including conversation deltas, so a cursor checkpoint cannot
          // get ahead of state that has not yet been rebuilt.
          bufferPendingSnapshotEvents(daemonEvents);
        } else {
          if (hasSnapshotEvent) {
            // A full snapshot is authoritative. Discard events parked
            // before it arrived; replaying them afterward could roll the
            // freshly rebuilt state backward.
            clearSnapshotRaceBuffer(
              pendingSnapshotEventsRef.current,
              pendingSnapshotSeqsRef.current,
            );
            pendingSnapshotOverflowedRef.current = false;
          }
          setSnapshot((current) => {
            if (!current && !hasSnapshotEvent) {
              // The mirror ref lagged a snapshot reset; skip applying onto
              // null — the refetch effect supersedes these events.
              return current;
            }
            return applyDaemonEventsToSnapshot(current, passthroughEvents);
          });
          if (updatesByThread.size > 0) {
            setThreadItems((current) =>
              applyDaemonEventsToThreadItems(current, updatesByThread),
            );
          }
          setThreadDetail((current) =>
            applyDaemonEventsToThreadDetail(
              current,
              passthroughEvents,
              updatesByThread,
            ),
          );
        }
      }

      // A cursor is a durable acknowledgement. Hold it while snapshot
      // recovery is incomplete; the layout effect checkpoints it after the
      // snapshot and every buffered event have been applied.
      if (highestConsumedSeq !== null) {
        pendingSnapshotCursorRef.current = Math.max(
          pendingSnapshotCursorRef.current ?? 0,
          highestConsumedSeq,
        );
      }
      checkpointPendingSnapshotCursor();

      if (flushGeneration !== relayFlushGenerationRef.current) return;

      // A truncated sync may deliver no replayable updates at all (idle
      // session aged out), so the per-update cursor advance above never runs;
      // adopt the truncation point here once nothing is parked, otherwise the
      // cursor stays stuck and every reconnect replays the truncation.
      if (
        pendingRelayUpdatesRef.current.length === 0 &&
        pendingTruncationNextSeqRef.current !== null
      ) {
        const truncationCursor = resolveRelayTruncationCursor(
          pendingTruncationNextSeqRef.current,
          pendingEncryptedUpdatesRef.current.length,
        );
        if (truncationCursor !== null) {
          pendingSnapshotCursorRef.current = Math.max(
            pendingSnapshotCursorRef.current ?? 0,
            truncationCursor,
          );
        }
      }
      checkpointPendingSnapshotCursor();
    } finally {
      relayFlushInProgressRef.current = false;
      if (
        pendingRelayUpdatesRef.current.length > 0 &&
        cancelRelayFlushRef.current === null
      ) {
        cancelRelayFlushRef.current = scheduleVisibilityAwareFlush(() => {
          cancelRelayFlushRef.current = null;
          void flushRelayUpdates();
        });
      }
    }
  }, [
    bufferPendingSnapshotEvents,
    checkpointPendingSnapshotCursor,
    failCurrentConnection,
    pairingId,
    schedulePersistCurrentSession,
    sessionId,
    snapshotCacheScheduler,
  ]);

  const scheduleRelayFlush = useCallback(() => {
    if (cancelRelayFlushRef.current !== null) {
      return;
    }

    cancelRelayFlushRef.current = scheduleVisibilityAwareFlush(() => {
      cancelRelayFlushRef.current = null;
      void flushRelayUpdates();
    });
  }, [flushRelayUpdates]);

  // The relay socket outlives this render, so it calls the scheduler through
  // a ref rather than the closure it was opened with.
  useEffect(() => {
    flushRelayUpdatesRef.current = scheduleRelayFlush;
  }, [scheduleRelayFlush]);

  // A tab returning to the foreground may hold updates that were scheduled on
  // a throttled timer; drain them immediately rather than waiting it out.
  useEffect(() => {
    const drainOnVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pendingRelayUpdatesRef.current.length === 0) return;
      scheduleRelayFlush();
    };
    document.addEventListener("visibilitychange", drainOnVisible);
    return () =>
      document.removeEventListener("visibilitychange", drainOnVisible);
  }, [scheduleRelayFlush]);

  const callRpc = useCallback(
    async <T = unknown,>(
      method: string,
      rpcParams: Record<string, unknown>,
    ) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not ready yet");
      }
      const sc = sessionCryptoRef.current;
      if (!sc) throw new Error("Encrypted relay session is not ready");
      const requestId = `remote-${requestCounter.current++}`;
      const encrypted = await encryptJson(sc.dataKey, rpcParams);
      if (
        socketRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        sessionCryptoRef.current !== sc
      ) {
        throw new Error(
          "Remote connection closed before the request could be sent",
        );
      }
      return new Promise<T>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingRpc.current.delete(requestId);
          reject(new Error(`Timed out waiting for ${method}`));
        }, RELAY_RPC_TIMEOUT_MS);
        pendingRpc.current.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          timeout,
          method,
        });
        try {
          sendRelayMessage(socket, {
            type: "rpc-call",
            request_id: requestId,
            method,
            params: encrypted,
          });
        } catch (sendError) {
          window.clearTimeout(timeout);
          pendingRpc.current.delete(requestId);
          reject(
            sendError instanceof Error
              ? sendError
              : new Error("Failed to send remote request"),
          );
        }
      });
    },
    [],
  );
  const readAloud = useReadAloud(
    useCallback(
      async (text: string) => {
        const response = await callRpc<{
          audio_base64: string;
          mime_type: string;
        }>("speech.synthesize", { text });
        return speechSynthesisBlob(response);
      },
      [callRpc],
    ),
    useCallback(
      (error: Error) =>
        toast({
          variant: "danger",
          title: "Read Aloud failed",
          description: error.message,
        }),
      [toast],
    ),
  );

  useEffect(() => {
    if (
      !selectedWorkspaceId ||
      !selectedThreadId ||
      !relayConnected ||
      !hasSessionKey ||
      !daemonRpcReady
    ) {
      setThreadDetail(null);
      return;
    }

    let cancelled = false;
    void callRpc<ThreadDetail>("thread.detail", {
      workspace_id: selectedWorkspaceId,
      thread_id: selectedThreadId,
      mode: "tail",
      limit: THREAD_DETAIL_TAIL_LIMIT,
    })
      .then((detail) => {
        if (cancelled) return;
        const normalizedDetail = normalizeThreadDetail(detail);
        const merged = mergeThreadDetailPage(
          threadDetailRef.current,
          normalizedDetail,
          "refresh",
        );
        threadDetailRef.current = merged;
        setThreadDetail(merged);
        setThreadItems((current) => ({
          ...current,
          [selectedThreadId]: merged.items,
        }));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setThreadDetail(null);
        setError(
          e instanceof Error ? e.message : "Failed to load thread detail",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    callRpc,
    daemonRpcReady,
    hasSessionKey,
    relayConnected,
    selectedThreadId,
    selectedWorkspaceId,
  ]);

  const handleLoadOlder = useCallback(() => {
    if (
      !selectedWorkspaceId ||
      !selectedThreadId ||
      !threadDetail?.has_older ||
      threadDetail.workspace.id !== selectedWorkspaceId ||
      threadDetail.thread.id !== selectedThreadId ||
      !threadDetail.oldest_item_id
    ) {
      return;
    }
    const key = `${selectedWorkspaceId}:${selectedThreadId}`;
    if (loadingOlderThreadKey === key) return;
    const beforeItemId = threadDetail.oldest_item_id;

    setLoadingOlderThreadKey(key);
    void callRpc<ThreadDetail>("thread.detail", {
      workspace_id: selectedWorkspaceId,
      thread_id: selectedThreadId,
      mode: "before",
      before_item_id: beforeItemId,
      limit: THREAD_DETAIL_OLDER_PAGE_LIMIT,
    })
      .then((rawPage) => {
        const page = normalizeThreadDetail(rawPage);
        const current = threadDetailRef.current;
        if (
          !current ||
          current.workspace.id !== selectedWorkspaceId ||
          current.thread.id !== selectedThreadId ||
          current.oldest_item_id !== beforeItemId
        ) {
          return;
        }
        const merged = mergeThreadDetailPage(current, page, "prepend");
        threadDetailRef.current = merged;
        setThreadDetail(merged);
        setThreadItems((items) => ({
          ...items,
          [selectedThreadId]: merged.items,
        }));
        setError(null);
      })
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error
            ? reason.message
            : "Failed to load earlier messages",
        );
      })
      .finally(() => {
        setLoadingOlderThreadKey((current) =>
          current === key ? null : current,
        );
      });
  }, [
    callRpc,
    loadingOlderThreadKey,
    selectedThreadId,
    selectedWorkspaceId,
    threadDetail,
  ]);

  useEffect(() => {
    if (!relayConnected || !hasSessionKey || !daemonRpcReady || snapshot) {
      snapshotRetryAttemptRef.current = 0;
      snapshotRequestInFlightRef.current = false;
      return;
    }

    snapshotRequestInFlightRef.current = true;

    let cancelled = false;
    let retryTimer: number | null = null;
    const scheduleSnapshotRetry = () => {
      if (retryTimer !== null) return;
      const delay = snapshotRetryDelayMs(snapshotRetryAttemptRef.current);
      snapshotRetryAttemptRef.current += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          setSnapshotRetryGeneration((generation) => generation + 1);
        }
      }, delay);
    };
    void callRpc<DaemonSnapshot>("snapshot.current", {
      include_archived_threads: false,
      include_thread_plans: false,
      include_thread_diffs: false,
    })
      .then((nextSnapshot) => {
        if (cancelled) return;
        if (relayFlushInProgressRef.current) {
          // The decrypt/flush may still hold an event that has not reached the
          // replay buffer. Keep everything already buffered for the retry; the
          // cursor remains held until that buffer is applied to a snapshot.
          scheduleSnapshotRetry();
          return;
        }
        if (pendingSnapshotOverflowedRef.current) {
          // The bounded buffer is incomplete, so this response may have been
          // stale. Discard only the incomplete buffer and retry from the still
          // uncheckpointed cursor with a fresh authoritative RPC response.
          pendingSnapshotEventsRef.current = [];
          pendingSnapshotSeqsRef.current.clear();
          pendingSnapshotOverflowedRef.current = false;
          scheduleSnapshotRetry();
          return;
        }
        // Replay events buffered while the RPC was in flight so they are not
        // lost to the older snapshot the RPC returned.
        const buffered = pendingSnapshotEventsRef.current;
        pendingSnapshotEventsRef.current = [];
        pendingSnapshotSeqsRef.current.clear();
        pendingSnapshotOverflowedRef.current = false;
        const { passthroughEvents, updatesByThread } =
          collectConversationItemUpdates(buffered);
        const hydratedSnapshot = applyDaemonEventsToSnapshot(
          normalizeDaemonSnapshot(nextSnapshot),
          passthroughEvents,
        );
        setSnapshot((current) => {
          if (current) return current;
          return hydratedSnapshot;
        });
        if (updatesByThread.size > 0) {
          setThreadItems((current) =>
            applyDaemonEventsToThreadItems(current, updatesByThread),
          );
        }
        setThreadDetail((current) =>
          applyDaemonEventsToThreadDetail(
            current,
            passthroughEvents,
            updatesByThread,
          ),
        );
        snapshotRetryAttemptRef.current = 0;
        snapshotRequestInFlightRef.current = false;
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        snapshotRequestInFlightRef.current = false;
        setError(
          e instanceof Error ? e.message : "Failed to load remote snapshot",
        );
        scheduleSnapshotRetry();
      });

    return () => {
      cancelled = true;
      snapshotRequestInFlightRef.current = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [
    callRpc,
    daemonRpcReady,
    hasSessionKey,
    relayConnected,
    sessionId,
    snapshot,
    snapshotRetryGeneration,
  ]);

  // ── Actions ────────────────────────────────────────────────────────

  async function handleClaimPairing() {
    if (isClaimingPairing) return;
    setIsClaimingPairing(true);
    try {
      await claimPairing();
    } catch (e) {
      // A rejected fetch here (offline, bad relay host, CORS) previously
      // vanished into an unhandled rejection and left the button inert.
      setError(
        e instanceof Error
          ? e.message
          : "Could not reach the relay. Check the address and your connection.",
      );
    } finally {
      setIsClaimingPairing(false);
    }
  }

  async function claimPairing() {
    suppressReconnectRef.current = false;
    abortPendingActionPolls();
    const keyPair = clientKeyPairRef.current ?? generateBoxKeyPair();
    const relayBase = normalizeRelayUrl(relayUrl);
    setRelayUrl(relayBase);
    const { pairingCode: normalizedPairingCode, authoritySecret } =
      decodeSecurePairingCode(pairingCode);

    // Claims are challenge-bound: fetch a single-use challenge and prove
    // possession of the identity secret key by signing it.
    const challengeResponse = await fetchWithTimeout(
      `${relayBase}/v1/pairings/challenge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairing_code: normalizedPairingCode,
        } satisfies PairingChallengeRequest),
      },
    );
    if (!challengeResponse.ok) {
      const payload = (await challengeResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(
        payload?.error ?? `Failed with status ${challengeResponse.status}`,
      );
      return;
    }
    const challenge =
      (await challengeResponse.json()) as PairingChallengeResponse;
    if (!challenge.challenge) {
      setError("Relay challenge response is missing a challenge");
      return;
    }

    const clientBundle = buildPairingPublicKeyBundle(keyPair);
    const response = await fetchWithTimeout(`${relayBase}/v1/pairings/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairing_code: normalizedPairingCode,
        label: getDeviceLabel(),
        client_bundle: clientBundle,
        challenge_signature: signPairingClaimChallenge(
          keyPair,
          normalizedPairingCode,
          challenge.challenge,
        ),
        pairing_authority_signature: signPairingAuthorityClientBundle(
          authoritySecret,
          normalizedPairingCode,
          challenge.challenge,
          clientBundle,
        ),
      } satisfies ClaimPairingRequest),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(payload?.error ?? `Failed with status ${response.status}`);
      return;
    }
    const claim = (await response.json()) as ClaimPairingResponse;
    if (!claim.daemon_bundle) {
      setError("Relay claim response is missing daemon key material");
      return;
    }
    if (!claim.pairing_authority) {
      setError("Relay claim response is missing secure pairing authority");
      return;
    }
    try {
      verifyPairingPublicKeyBundle(claim.daemon_bundle);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Relay claim response has an invalid daemon signature",
      );
      return;
    }
    try {
      verifyPairingAuthorityDaemonBundle(
        authoritySecret,
        claim.pairing_authority.public_key,
        claim.daemon_bundle,
        claim.pairing_authority.daemon_bundle_signature,
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Relay claim response failed secure pairing verification",
      );
      return;
    }
    clientKeyPairRef.current = keyPair;
    persistClientKeyPairSecret(secretKeyToBase64(keyPair));
    sessionCryptoRef.current = null;
    pendingEncryptedUpdatesRef.current = [];
    evictedWhileParkedRef.current = false;
    pendingTruncationNextSeqRef.current = null;
    pendingSnapshotEventsRef.current = [];
    pendingSnapshotSeqsRef.current.clear();
    pendingSnapshotOverflowedRef.current = false;
    pendingSnapshotCursorRef.current = null;
    pendingRelayUpdatesRef.current = [];
    cancelRelayFlush();
    snapshotCacheScheduler.cancel();
    pendingSnapshotCacheRef.current = null;
    clearPersistedRemoteSnapshot(sessionId);
    clearPersistedRemoteSession(sessionId);
    persistSelection(sessionId, null);
    trustedDaemonPublicKeyRef.current = claim.daemon_bundle.public_key;
    trustedDaemonIdentityPublicKeyRef.current =
      claim.daemon_bundle.identity_public_key;
    clearPendingActionIds(sessionId);
    setPairingId(claim.pairing_id);
    setSessionId(claim.session_id);
    setDeviceId(claim.device_id);
    setClientToken(claim.client_token);
    setPairingCode("");
    lastReceivedSeqRef.current = 0;
    setMachinePresence(null);
    setSnapshot(null);
    setThreadDetail(null);
    setThreadItems({});
    setConnectionStatus("claimed, awaiting encrypted session");
    setError(null);
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: relayBase,
      pairingCode: "",
      pairingId: claim.pairing_id,
      sessionId: claim.session_id,
      deviceId: claim.device_id,
      clientToken: claim.client_token,
      clientSecretKey: secretKeyToBase64(keyPair),
      daemonPublicKey: claim.daemon_bundle.public_key,
      daemonIdentityPublicKey: claim.daemon_bundle.identity_public_key,
      dataKey: null,
      lastReceivedSeq: 0,
    });
    // The code is spent now; keeping it in the address bar leaves it in
    // history and in any link or screenshot the user shares afterwards.
    clearPairingParamsFromUrl();
  }

  /** Keep failures visible on both narrow and wide remote layouts. */
  const reportError = useCallback(
    (cause: unknown, fallback: string) => {
      const message = cause instanceof Error ? cause.message : fallback;
      setError(message);
      toast({ variant: "danger", title: fallback, description: message });
    },
    [toast],
  );

  // Isolated-thread shipping runs entirely in the daemon, so remote web only
  // needs the two RPCs; the control and its toasts are shared with desktop.
  const shipApi = useMemo(
    () => ({
      gitStatus: (workspaceId: string, threadId?: string | null) =>
        callRpc<GitStatusResponse>("git.status", {
          workspace_id: workspaceId,
          thread_id: threadId,
        }),
      shipThread: (
        workspaceId: string,
        threadId: string,
        mode: ShipThreadMode,
      ) =>
        callRpc<ShipThreadResponse>("thread.ship", {
          workspace_id: workspaceId,
          thread_id: threadId,
          mode,
        }),
    }),
    [callRpc],
  );
  const {
    ship: shipThread,
    pending: isShipPending,
    projectFolderDirty,
    mergeFailure,
    dismissMergeFailure,
  } = useShipThread({
    api: isEncrypted ? shipApi : null,
    workspaceId: selectedWorkspace?.id ?? null,
    thread: selectedThread,
    toast,
    // Remote web runs in a real browser, so a new tab is the system browser.
    openUrl: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });

  const handleSetThreadStage = useCallback(
    async (
      _workspaceId: string,
      thread: ThreadSummary,
      stage: ThreadTag | null,
    ) => {
      try {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                extensions: optimisticallySetThreadStage(
                  current.extensions,
                  thread.id,
                  stage?.id ?? null,
                ),
              }
            : current,
        );
        await callRpc("extensions.action.invoke", {
          extensionId: THREAD_TAGS_EXTENSION_ID,
          actionId: THREAD_TAGS_ACTION_ID,
          target: { kind: "thread", id: thread.id },
          input: {
            operation: "set_thread_stage",
            stageId: stage?.id ?? null,
          },
        });
      } catch (error) {
        void callRpc<DaemonSnapshot>("snapshot.current", {})
          .then(setSnapshot)
          .catch(() => {});
        reportError(error, "Failed to set thread stage");
      }
    },
    [callRpc, reportError],
  );

  const handleCreateThreadStage = useCallback(
    async (_workspaceId: string, thread: ThreadSummary, label: string) => {
      await callRpc("extensions.action.invoke", {
        extensionId: THREAD_TAGS_EXTENSION_ID,
        actionId: THREAD_TAGS_ACTION_ID,
        target: { kind: "thread", id: thread.id },
        input: { operation: "create_stage", label },
      });
    },
    [callRpc],
  );

  const invokeExtensionAppAction = useCallback(
    async (
      extensionId: string,
      actionId: string,
      input?: unknown,
      target?: ExtensionAppViewScope | null,
    ) => {
      const response = await callRpc<ExtensionActionResponse>(
        "extensions.action.invoke",
        {
          extensionId,
          actionId,
          target,
          input: input ?? null,
        },
      );
      setSnapshot(
        normalizeDaemonSnapshot(
          await callRpc<DaemonSnapshot>("snapshot.current", {}),
        ),
      );
      return response;
    },
    [callRpc],
  );
  const handleExtensionPanelAction = useCallback(
    async (extensionId: string, action: ExtensionUiActionBinding) => {
      await invokeExtensionAppAction(
        extensionId,
        action.actionId,
        action.input,
        action.target,
      );
    },
    [invokeExtensionAppAction],
  );

  const submitQueuedAction = useCallback(
    async <T = unknown,>(
      actionType: string,
      rpcParams: Record<string, unknown>,
      options?: { awaitCompletion?: boolean },
    ) => {
      if (!sessionId || !clientToken)
        throw new Error("Remote session is not ready");
      const sc = sessionCryptoRef.current;
      if (!sc) throw new Error("Encrypted relay session is not ready");
      const encrypted = await encryptJson(sc.dataKey, rpcParams);
      const response = await fetch(
        `${relayUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${clientToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            action_type: actionType,
            payload: encrypted,
          }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          payload?.error ?? `Failed with status ${response.status}`,
        );
      }
      const action = (await response.json()) as QueuedRemoteAction;
      rememberPendingAction(sessionId, action.action_id);
      if (options?.awaitCompletion === false) {
        const controller = new AbortController();
        pendingActionPollsRef.current.add(controller);

        void pollQueuedAction(action.action_id, {
          signal: controller.signal,
          clientTokenOverride: clientToken,
          sessionIdOverride: sessionId,
        })
          .then(() => forgetPendingAction(sessionId, action.action_id))
          .catch((queuedError) => {
            if (isAbortError(queuedError)) return;
            if (
              forgetPendingActionAfterError(
                action.action_id,
                queuedError,
                (actionId) => forgetPendingAction(sessionId, actionId),
              )
            ) {
              reportError(queuedError, "Remote action failed");
            }
          })
          .finally(() => {
            pendingActionPollsRef.current.delete(controller);
          });
        return null as T;
      }
      try {
        const result = await pollQueuedAction<T>(action.action_id, {
          timeoutMs: AWAITED_ACTION_TIMEOUT_MS,
        });
        forgetPendingAction(sessionId, action.action_id);
        return result;
      } catch (queuedError) {
        // A timeout is not an outcome: leave the id tracked so the resume
        // effect picks the action back up on the next encrypted connection.
        if (!(queuedError instanceof AwaitedActionTimeoutError))
          forgetPendingActionAfterError(
            action.action_id,
            queuedError,
            (actionId) => forgetPendingAction(sessionId, actionId),
          );
        throw queuedError;
      }
    },
    [clientToken, pollQueuedAction, relayUrl, reportError, sessionId],
  );

  const liveSkillsRef = useRef<LiveSkillCatalog | null>(null);
  const snapshotSkillsRef = useRef(selectedWorkspace?.skills ?? []);
  snapshotSkillsRef.current = selectedWorkspace?.skills ?? [];
  useEffect(() => {
    liveSkillsRef.current = null;
  }, [selectedWorkspace?.id]);
  const loadSkills = useCallback(
    async (provider: AgentProvider) => {
      const workspaceId = selectedWorkspace?.id;
      if (!workspaceId) return [];
      try {
        const payload = await callRpc<{ skills?: SkillSummary[] }>(
          "workspace.skills",
          {
            workspace_id: workspaceId,
            provider,
          },
        );
        const skills = normalizeSkillSummaries(payload.skills);
        liveSkillsRef.current = {
          workspaceId,
          provider,
          skills,
        };
        return skills;
      } catch {
        return snapshotSkillsRef.current;
      }
    },
    [callRpc, selectedWorkspace?.id],
  );

  async function handleStop() {
    if (!selectedWorkspace || !selectedThreadId) return;
    if (selectedThread?.status !== "running") return;
    setIsStopping(true);
    try {
      await submitQueuedAction(
        "turn.interrupt",
        {
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
        },
        { awaitCompletion: false },
      );
      setError(null);
    } catch (e) {
      reportError(e, "Failed to stop turn");
    } finally {
      setIsStopping(false);
    }
  }

  /**
   * `override` sends a prompt the user did not type — today, a chosen composer
   * suggestion. It carries no attachments and leaves the composer's own draft
   * where it was, so choosing a suggestion never eats work in progress.
   */
  async function handleSubmit(override?: {
    text: string;
    resumeInterrupted?: boolean;
  }) {
    if ((attachmentPreparationCountsRef.current[conversationKey] ?? 0) > 0) {
      setError("Wait for image preparation to finish before sending.");
      return;
    }
    const submittedDraft = override?.text ?? draft;
    const submittedAttachments = override ? [] : attachments;
    if (
      !selectedWorkspace ||
      (!override?.resumeInterrupted &&
        !submittedDraft.trim() &&
        submittedAttachments.length === 0)
    )
      return;
    const compactCommand = override
      ? null
      : parseCompactThreadCommand(submittedDraft);
    if (compactCommand) {
      if (!selectedThreadId || !selectedThread) {
        setError("Start a conversation before compacting it.");
        return;
      }
      if (submittedAttachments.length > 0) {
        setError("Remove attachments before compacting.");
        return;
      }
      if (
        selectedThread.status === "running" ||
        selectedThread.status === "waiting_for_input"
      ) {
        setError("Wait for the current turn to finish before compacting.");
        return;
      }
      setIsSubmitting(true);
      try {
        await callRpc("thread.compact", {
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          instructions: compactCommand.instructions,
        });
        setDraftForConversation(conversationKey, "");
        setError(null);
      } catch (error) {
        reportError(error, "Failed to compact context");
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    const submitProvider = selectedThread?.provider ?? selectedProvider;
    const imageBlockReason = imageAttachmentSendBlockReason(
      workspaceAgentCapabilities(selectedWorkspace, submitProvider),
      submittedAttachments.length,
    );
    if (imageBlockReason) {
      setError(imageBlockReason);
      return;
    }
    const submittedSkills = selectedSkillsFromText(
      submittedDraft,
      composerSkillCatalog(
        liveSkillsRef.current,
        selectedWorkspace,
        selectedThread?.provider ?? selectedProvider,
      ),
    );
    const userItemId = generateUserItemId();
    const submittedKey = conversationKey;
    sendingConversationKeyRef.current = submittedKey;
    sendingBaselineAgentItemIdRef.current = lastAgentItemId(items);
    setIsSubmitting(true);
    let activeThreadId = selectedThreadId;
    let pendingComposerKey = submittedKey;
    try {
      if (!activeThreadId) {
        const handle = normalizeThreadHandle(
          await submitQueuedAction<ThreadHandle>("thread.start", {
            workspace_id: selectedWorkspace.id,
            provider: selectedProvider,
            model_id: selectedModel,
            collaboration_mode_id: selectedCollaborationMode,
            approval_policy: approvalPolicyForProvider(
              selectedProvider,
              selectedPermissionMode,
            ),
            permission_mode: selectedPermissionMode,
            sandbox_mode: selectedSandboxMode,
          }),
        );
        activeThreadId = handle.thread.id;
        const startedConversationKey = draftKeyFor(
          selectedWorkspace.id,
          activeThreadId,
        );
        // Copy first, then delete: interruption during the new-thread handoff
        // may leave two recoverable drafts, but never zero.
        if (!override) {
          setDraftForConversation(startedConversationKey, submittedDraft);
          setAttachmentsForConversation(
            startedConversationKey,
            () => submittedAttachments,
          );
          setDraftForConversation(submittedKey, "");
          setAttachmentsForConversation(submittedKey, () => []);
        }
        pendingComposerKey = startedConversationKey;
        const adopted = conversationKeyRef.current === submittedKey;
        if (adopted) {
          conversationKeyRef.current = startedConversationKey;
          sendingConversationKeyRef.current = startedConversationKey;
          sendingBaselineAgentItemIdRef.current = null;
          setSelectedWorkspaceId(handle.workspace.id);
          setSelectedThreadId(handle.thread.id);
        }
        setSnapshot((current) =>
          current
            ? {
                ...current,
                workspaces: current.workspaces.map((workspace) =>
                  workspace.id === handle.workspace.id
                    ? handle.workspace
                    : workspace,
                ),
                threads: [
                  handle.thread,
                  ...current.threads.filter(
                    (thread) => thread.id !== handle.thread.id,
                  ),
                ],
              }
            : current,
        );
      }
      // Tier-capable models get their tier stated on every turn — "fast off"
      // must reach the provider as an explicit standard-tier request, because
      // an omitted field means "keep the session's current tier".
      const activeModels = workspaceModels(
        selectedWorkspace,
        selectedThread?.provider ?? selectedProvider,
      );
      const activeModel =
        activeModels.find((model) => model.id === selectedModel) ??
        activeModels.find((model) => model.is_default) ??
        null;
      await submitQueuedAction(
        "turn.start",
        {
          workspace_id: selectedWorkspace.id,
          thread_id: activeThreadId,
          inputs: [
            ...(submittedDraft.trim()
              ? [{ type: "text", text: submittedDraft }]
              : []),
            ...submittedAttachments,
          ],
          user_item_id: userItemId,
          selected_skills: submittedSkills,
          provider: selectedThread?.provider ?? selectedProvider,
          model_id: selectedModel,
          reasoning_effort: selectedEffort,
          approval_policy: approvalPolicyForProvider(
            selectedThread?.provider ?? selectedProvider,
            selectedPermissionMode,
          ),
          service_tier: serviceTierForTurn(selectedServiceTier, activeModel),
          permission_mode: selectedPermissionMode,
          sandbox_mode: selectedSandboxMode,
          resume_interrupted: Boolean(override?.resumeInterrupted),
        },
        { awaitCompletion: false },
      );
      // The relay has durably accepted the outbox entry. Until this point the
      // original composer remains in localStorage, surviving tab or process
      // loss without relying on an in-memory catch handler.
      if (!override) {
        setDraftForConversation(pendingComposerKey, "");
        setAttachmentsForConversation(pendingComposerKey, () => []);
      }
      setError(null);
    } catch (e) {
      // Put the unsent input back where the user now is: the thread that was
      // created before the send failed, or the conversation they sent from.
      const restoreKey = activeThreadId
        ? draftKeyFor(selectedWorkspace.id, activeThreadId)
        : submittedKey;
      if (override) {
        // Nothing of the user's was consumed, so there is nothing to restore.
        reportError(e, "Failed to send message");
        sendingConversationKeyRef.current = null;
        setIsSubmitting(false);
        return;
      }
      if (restoreKey !== submittedKey) {
        setDraftForConversation(submittedKey, "");
        setAttachmentsForConversation(submittedKey, () => []);
      }
      restoreFailedSubmission(restoreKey, submittedDraft, submittedAttachments);
      reportError(e, "Failed to send message");
      sendingConversationKeyRef.current = null;
      setIsSubmitting(false);
    }
  }

  async function handleInteractiveResponse(
    workspaceId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ) {
    try {
      await submitQueuedAction("interactive.respond", {
        workspace_id: workspaceId,
        request_id: requestId,
        response,
      });
    } catch (error) {
      reportError(error, "Interactive response failed");
      throw error instanceof Error
        ? error
        : new Error("Interactive response failed");
    }
    if (selectedThreadId) {
      setThreadItems((current) => ({
        ...current,
        [selectedThreadId]: markInteractiveRequestResolved(
          current[selectedThreadId] ?? [],
          requestId,
          response,
        ),
      }));
    }
    setThreadDetail((current) =>
      current && current.workspace.id === workspaceId
        ? {
            ...current,
            items: markInteractiveRequestResolved(
              current.items,
              requestId,
              response,
            ),
          }
        : current,
    );
  }

  // ── Sync model/effort/mode ─────────────────────────────────────────

  const rememberComposerSelection = useCallback(
    (provider: AgentProvider, patch: Partial<PersistedComposerSelection>) => {
      if (!selectedWorkspace) return;
      setPersistedComposerSelections((current) => {
        const next = withComposerSelection(
          current,
          selectedWorkspace.path,
          provider,
          patch,
        );
        writePersistedComposerState(next);
        return next;
      });
    },
    [selectedWorkspace],
  );

  const rememberWorkspaceProvider = useCallback(
    (provider: AgentProvider) => {
      if (!selectedWorkspace) return;
      setPersistedComposerSelections((current) => {
        const next = withComposerProvider(
          current,
          selectedWorkspace.path,
          provider,
        );
        if (next === current) return current;
        writePersistedComposerState(next);
        return next;
      });
    },
    [selectedWorkspace],
  );

  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedProvider("codex");
      setSelectedModel(null);
      setSelectedCollaborationMode(null);
      setSelectedEffort("medium");
      setSelectedServiceTier(null);
      setSelectedPermissionMode(null);
      setSelectedSandboxMode(null);
      selectionSeedRef.current = null;
      return;
    }
    const seedKey = `${selectedWorkspace.id}:${selectedThread?.id ?? "workspace"}`;
    if (selectionSeedRef.current === seedKey) return;
    selectionSeedRef.current = seedKey;

    // An existing thread dictates its own provider; a new conversation starts
    // from the provider the user last picked here, so that choice sticks.
    const stickyProvider = composerProviderFor(
      persistedComposerSelections,
      selectedWorkspace.path,
    );
    const nextProvider =
      !selectedThread &&
      stickyProvider &&
      workspaceProviderOptions(selectedWorkspace).some(
        (option) => option.provider === stickyProvider,
      )
        ? stickyProvider
        : providerForThread(selectedThread, selectedWorkspace);
    setSelectedProvider(nextProvider);
    const collaborationModes = workspaceCollaborationModes(
      selectedWorkspace,
      nextProvider,
    );
    setSelectedCollaborationMode(
      selectedThread?.agent.collaboration_mode_id ??
        collaborationModes.find((mode) => mode.mode === "default")?.id ??
        collaborationModes[0]?.id ??
        null,
    );
    const preferredSelection = composerSelectionFor(
      persistedComposerSelections,
      selectedWorkspace.path,
      nextProvider,
    );
    // Same idea for the modes: threads keep their own, new conversations get
    // the remembered choice as long as the provider still offers it.
    const capabilities = workspaceAgentCapabilities(
      selectedWorkspace,
      nextProvider,
    );
    setSelectedPermissionMode(
      selectedThread
        ? (selectedThread.agent.permission_mode ?? null)
        : resolvePermissionMode(
            preferredSelection?.permissionMode,
            capabilities.permission_modes,
          ),
    );
    setSelectedSandboxMode(
      selectedThread
        ? (selectedThread.agent.sandbox_mode ?? null)
        : resolvePersistedMode(
            preferredSelection?.sandboxMode,
            capabilities.sandbox_modes,
          ),
    );
    const providerModels = workspaceModels(selectedWorkspace, nextProvider);
    const preferredModelId =
      preferredSelection?.modelId &&
      providerModels.some((model) => model.id === preferredSelection.modelId)
        ? preferredSelection.modelId
        : null;
    const fallbackModelId =
      preferredModelId ??
      providerModels.find((m) => m.is_default)?.id ??
      providerModels[0]?.id ??
      null;
    if (selectedThread) {
      const nextModelId = selectedThread.agent.model_id ?? fallbackModelId;
      setSelectedModel(nextModelId);
      setSelectedEffort(
        selectedThread.agent.reasoning_effort ??
          reasoningOptions(
            snapshot,
            selectedWorkspace.id,
            nextProvider,
            nextModelId,
          )[0] ??
          "medium",
      );
      setSelectedServiceTier(
        resolveServiceTier(
          selectedThread.agent.service_tier,
          providerModels.find((model) => model.id === nextModelId) ?? null,
        ),
      );
      return;
    }
    setSelectedModel(fallbackModelId);
    const effortOptions = reasoningOptions(
      snapshot,
      selectedWorkspace.id,
      nextProvider,
      fallbackModelId,
    );
    setSelectedEffort(
      preferredSelection?.effort &&
        effortOptions.includes(preferredSelection.effort)
        ? preferredSelection.effort
        : (effortOptions[0] ?? "medium"),
    );
    // Threads keep the tier they last ran with; new conversations take the
    // remembered choice, falling back to the model catalog's default tier.
    const fallbackModel =
      providerModels.find((model) => model.id === fallbackModelId) ?? null;
    setSelectedServiceTier(
      resolveServiceTier(
        preferredSelection?.serviceTier ?? fallbackModel?.default_service_tier,
        fallbackModel,
      ),
    );
  }, [
    persistedComposerSelections,
    selectedThread,
    selectedWorkspace,
    snapshot,
  ]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const options = reasoningOptions(
      snapshot,
      selectedWorkspace.id,
      selectedProvider,
      selectedModel,
    );
    if (options.length === 0) return;
    if (!selectedEffort || !options.includes(selectedEffort)) {
      setSelectedEffort(options[0] ?? "medium");
    }
  }, [
    selectedEffort,
    selectedModel,
    selectedProvider,
    selectedWorkspace,
    snapshot,
  ]);

  const applyThreadHandle = useCallback((handle: ThreadHandle) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === handle.workspace.id
                ? handle.workspace
                : workspace,
            ),
            threads: current.threads.map((thread) =>
              thread.id === handle.thread.id ? handle.thread : thread,
            ),
          }
        : current,
    );
    setThreadDetail((current) =>
      current && current.thread.id === handle.thread.id
        ? { ...current, workspace: handle.workspace, thread: handle.thread }
        : current,
    );
  }, []);

  const handleContinueInterruptedTurn = () => {
    void handleSubmit({ text: "", resumeInterrupted: true });
  };

  const handleDismissInterruptedTurn = useCallback(() => {
    if (!selectedWorkspace || !selectedThreadId) return;
    void submitQueuedAction<ThreadHandle>("thread.update", {
      workspace_id: selectedWorkspace.id,
      thread_id: selectedThreadId,
      acknowledge_interruption: true,
    })
      .then((handle) => applyThreadHandle(normalizeThreadHandle(handle)))
      .catch(() => {});
  }, [
    applyThreadHandle,
    selectedThreadId,
    selectedWorkspace,
    submitQueuedAction,
  ]);

  const applyThreadSummary = useCallback((thread: ThreadSummary) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            threads: current.threads.map((entry) =>
              entry.id === thread.id ? thread : entry,
            ),
          }
        : current,
    );
    setThreadDetail((current) =>
      current && current.thread.id === thread.id
        ? { ...current, thread }
        : current,
    );
  }, []);

  const persistThreadSettings = useCallback(
    async ({
      modelId,
      effort,
    }: {
      modelId: string | null;
      effort: string | null;
    }) => {
      if (!selectedWorkspace || !selectedThreadId) return;
      const requestId = ++threadSettingsRequestRef.current;
      try {
        const handle = normalizeThreadHandle(
          await submitQueuedAction<ThreadHandle>("thread.update", {
            workspace_id: selectedWorkspace.id,
            thread_id: selectedThreadId,
            provider: selectedThread?.provider ?? selectedProvider,
            model_id: modelId,
            reasoning_effort: effort,
          }),
        );
        if (requestId !== threadSettingsRequestRef.current) return;
        applyThreadHandle(handle);
        setError(null);
      } catch (e) {
        if (requestId !== threadSettingsRequestRef.current) return;
        reportError(e, "Failed to update thread settings");
      }
    },
    [
      applyThreadHandle,
      reportError,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      submitQueuedAction,
    ],
  );

  const handleTogglePinThread = useCallback(
    async (workspaceId: string, threadId: string, pinned: boolean) => {
      try {
        const handle = normalizeThreadHandle(
          await submitQueuedAction<ThreadHandle>("thread.update", {
            workspace_id: workspaceId,
            thread_id: threadId,
            pinned,
          }),
        );
        applyThreadHandle(handle);
        setError(null);
      } catch (e) {
        reportError(e, "Failed to update pin");
      }
    },
    [applyThreadHandle, reportError, submitQueuedAction],
  );

  const handleTogglePinThreadInProject = useCallback(
    async (workspaceId: string, threadId: string, pinnedInProject: boolean) => {
      try {
        const handle = normalizeThreadHandle(
          await submitQueuedAction<ThreadHandle>("thread.update", {
            workspace_id: workspaceId,
            thread_id: threadId,
            pinned_in_project: pinnedInProject,
          }),
        );
        applyThreadHandle(handle);
        setError(null);
      } catch (e) {
        reportError(e, "Failed to update pin");
      }
    },
    [applyThreadHandle, reportError, submitQueuedAction],
  );

  const handleCollaborationModeChange = useCallback(
    (mode: string | null) => {
      setSelectedCollaborationMode(mode);
      if (!selectedWorkspace || !selectedThreadId) return;
      void submitQueuedAction<ThreadHandle>("thread.update", {
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        collaboration_mode_id: mode,
      })
        .then((handle) => applyThreadHandle(normalizeThreadHandle(handle)))
        .catch((e) => reportError(e, "Failed to update collaboration mode"));
    },
    [
      applyThreadHandle,
      reportError,
      selectedThreadId,
      selectedWorkspace,
      submitQueuedAction,
    ],
  );

  const handlePermissionModeChange = useCallback(
    (mode: string | null) => {
      setSelectedPermissionMode(mode);
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        permissionMode: mode ?? "default",
      });
      if (!selectedWorkspace || !selectedThreadId) return;
      void submitQueuedAction<ThreadHandle>("thread.update", {
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        permission_mode: mode,
        approval_policy: approvalPolicyForProvider(
          selectedThread?.provider ?? selectedProvider,
          mode,
        ),
      })
        .then((handle) => applyThreadHandle(normalizeThreadHandle(handle)))
        .catch((e) => reportError(e, "Failed to update permission mode"));
    },
    [
      applyThreadHandle,
      rememberComposerSelection,
      reportError,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      submitQueuedAction,
    ],
  );

  const handleSandboxModeChange = useCallback(
    (mode: string | null) => {
      setSelectedSandboxMode(mode);
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        sandboxMode: mode,
      });
      if (!selectedWorkspace || !selectedThreadId) return;
      void submitQueuedAction<ThreadHandle>("thread.update", {
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        sandbox_mode: mode,
      })
        .then((handle) => applyThreadHandle(normalizeThreadHandle(handle)))
        .catch((e) => reportError(e, "Failed to update sandbox mode"));
    },
    [
      applyThreadHandle,
      rememberComposerSelection,
      reportError,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      submitQueuedAction,
    ],
  );

  const handleServiceTierChange = useCallback(
    (tier: string | null) => {
      setSelectedServiceTier(tier);
      // Turning fast off is an explicit choice, distinct from never having
      // touched the toggle — only the latter follows the catalog default.
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        serviceTier: tier ?? STANDARD_SERVICE_TIER,
      });
      if (!selectedWorkspace || !selectedThreadId) return;
      void submitQueuedAction<ThreadHandle>("thread.update", {
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        service_tier: tier ?? STANDARD_SERVICE_TIER,
      })
        .then((handle) => applyThreadHandle(normalizeThreadHandle(handle)))
        .catch((e) => reportError(e, "Failed to update speed"));
    },
    [
      applyThreadHandle,
      rememberComposerSelection,
      reportError,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      submitQueuedAction,
    ],
  );

  const handleUpdatePreferences = useCallback(
    async (payload: UpdatePreferencesPayload) => {
      try {
        const preferences = normalizePreferences(
          await submitQueuedAction("preferences.update", payload),
        );
        setSnapshot((current) =>
          current ? { ...current, preferences } : current,
        );
        setError(null);
      } catch (e) {
        reportError(e, "Failed to save preferences");
      }
    },
    [reportError, submitQueuedAction],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId);
      const nextOptions = reasoningOptions(
        snapshot,
        selectedWorkspace?.id ?? null,
        selectedProvider,
        modelId,
      );
      const nextEffort =
        selectedEffort && nextOptions.includes(selectedEffort)
          ? selectedEffort
          : (nextOptions[0] ?? "medium");
      setSelectedEffort(nextEffort);
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        modelId,
        effort: nextEffort,
      });
      void persistThreadSettings({
        modelId,
        effort: nextEffort,
      });
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedEffort,
      selectedThread,
      selectedWorkspace?.id,
      snapshot,
      selectedProvider,
    ],
  );

  const handleEffortChange = useCallback(
    (effort: string) => {
      setSelectedEffort(effort);
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        modelId: selectedModel,
        effort,
      });
      void persistThreadSettings({
        modelId: selectedModel,
        effort,
      });
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedModel,
      selectedProvider,
      selectedThread,
    ],
  );

  const handleProviderChange = useCallback(
    (provider: AgentProvider) => {
      if (selectedThread) return;
      setSelectedProvider(provider);
      const collaborationModes = workspaceCollaborationModes(
        selectedWorkspace,
        provider,
      );
      setSelectedCollaborationMode(
        collaborationModes.find((mode) => mode.mode === "default")?.id ??
          collaborationModes[0]?.id ??
          null,
      );
      rememberWorkspaceProvider(provider);
      const preferredSelection = composerSelectionFor(
        persistedComposerSelections,
        selectedWorkspace?.path,
        provider,
      );
      const models = workspaceModels(selectedWorkspace, provider);
      const preferredModelId =
        preferredSelection?.modelId &&
        models.some((model) => model.id === preferredSelection.modelId)
          ? preferredSelection.modelId
          : null;
      const fallbackModelId =
        preferredModelId ??
        models.find((model) => model.is_default)?.id ??
        models[0]?.id ??
        null;
      setSelectedModel(fallbackModelId);
      const effortOptions = reasoningOptions(
        snapshot,
        selectedWorkspace?.id ?? null,
        provider,
        fallbackModelId,
      );
      setSelectedEffort(
        preferredSelection?.effort &&
          effortOptions.includes(preferredSelection.effort)
          ? preferredSelection.effort
          : (effortOptions[0] ?? "medium"),
      );
      // Switching provider swaps in that provider's remembered modes rather
      // than losing the choice every time.
      const capabilities = workspaceAgentCapabilities(
        selectedWorkspace,
        provider,
      );
      setSelectedPermissionMode(
        resolvePermissionMode(
          preferredSelection?.permissionMode,
          capabilities.permission_modes,
        ),
      );
      setSelectedSandboxMode(
        resolvePersistedMode(
          preferredSelection?.sandboxMode,
          capabilities.sandbox_modes,
        ),
      );
      const fallbackModel =
        models.find((model) => model.id === fallbackModelId) ?? null;
      setSelectedServiceTier(
        resolveServiceTier(
          preferredSelection?.serviceTier ??
            fallbackModel?.default_service_tier,
          fallbackModel,
        ),
      );
    },
    [
      persistedComposerSelections,
      rememberWorkspaceProvider,
      selectedThread,
      selectedWorkspace,
      snapshot,
    ],
  );

  const activeProvider = useMemo(
    () => (selectedThread ? selectedThread.provider : selectedProvider),
    [selectedProvider, selectedThread],
  );
  const currentReasoningOptions = useMemo(
    () =>
      reasoningOptions(
        snapshot,
        selectedWorkspace?.id ?? null,
        activeProvider,
        selectedModel,
      ),
    [activeProvider, selectedModel, selectedWorkspace?.id, snapshot],
  );
  const models = useMemo(
    () => workspaceModels(selectedWorkspace, activeProvider),
    [activeProvider, selectedWorkspace],
  );
  const providerOptions = useMemo(
    () => workspaceProviderOptions(selectedWorkspace),
    [selectedWorkspace],
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
  const handoffDisabledReason = handoffBlockedReason(selectedThread, {
    pending: handoffPending,
  });
  const activeCapabilities = useMemo(
    () =>
      threadAgentCapabilities(
        selectedWorkspace,
        activeProvider,
        selectedThread,
      ),
    [activeProvider, selectedThread, selectedWorkspace],
  );
  const attachmentSendBlockReason = imageAttachmentSendBlockReason(
    activeCapabilities,
    attachments.length,
  );
  const handleSelectWorkspace = useCallback(
    (workspaceId: string, threadId: string | null) => {
      setThreadDetail(null);
      setActiveExtensionPanelKey(null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(threadId);
      setShowProjects(false);
    },
    [],
  );
  const handleSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      setThreadDetail(null);
      setActiveExtensionPanelKey(null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(threadId);
      setShowProjects(false);
    },
    [],
  );
  const handleNewThread = useCallback((workspaceId: string) => {
    setThreadDetail(null);
    setActiveExtensionPanelKey(null);
    setSelectedWorkspaceId(workspaceId);
    setSelectedThreadId(null);
    setShowProjects(false);
  }, []);
  const handleSelectExtensionPanel = useCallback((panelKey: string) => {
    setActiveExtensionPanelKey(panelKey);
    setShowProjects(false);
  }, []);
  const handleNewThreadFromCurrent = useCallback(() => {
    if (!selectedWorkspace || !selectedThread) return;
    const provider = selectedThread.provider;
    rememberWorkspaceProvider(provider);
    rememberComposerSelection(provider, {
      modelId: selectedModel,
      effort: selectedEffort,
      permissionMode: selectedPermissionMode,
      sandboxMode: selectedSandboxMode,
    });
    handleNewThread(selectedWorkspace.id);
  }, [
    handleNewThread,
    rememberComposerSelection,
    rememberWorkspaceProvider,
    selectedEffort,
    selectedModel,
    selectedPermissionMode,
    selectedSandboxMode,
    selectedThread,
    selectedWorkspace,
  ]);

  const branchFromMessage = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      if (!selectedWorkspace || !selectedThread) return;
      const sourceConversationKey = draftKeyFor(
        selectedWorkspace.id,
        selectedThread.id,
      );
      const handle = normalizeThreadHandle(
        item.previous_turn_id
          ? await callRpc<ThreadHandle>("thread.fork", {
              workspace_id: selectedWorkspace.id,
              thread_id: selectedThread.id,
              last_turn_id: item.previous_turn_id,
            })
          : await callRpc<ThreadHandle>("thread.start", {
              workspace_id: selectedWorkspace.id,
              provider: selectedThread.provider,
              model_id: selectedThread.agent.model_id,
              approval_policy: selectedThread.agent.approval_policy,
              permission_mode: selectedThread.agent.permission_mode,
              sandbox_mode: selectedThread.agent.sandbox_mode,
              isolation: "project_folder",
            }),
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              workspaces: current.workspaces.map((workspace) =>
                workspace.id === handle.workspace.id
                  ? handle.workspace
                  : workspace,
              ),
              threads: [
                handle.thread,
                ...current.threads.filter((t) => t.id !== handle.thread.id),
              ],
            }
          : current,
      );
      const adopted = conversationKeyRef.current === sourceConversationKey;
      if (adopted) {
        conversationKeyRef.current = draftKeyFor(
          handle.workspace.id,
          handle.thread.id,
        );
        setThreadDetail({
          workspace: handle.workspace,
          thread: handle.thread,
          items: [],
          has_older: false,
          oldest_item_id: null,
          newest_item_id: null,
          is_partial: false,
        });
        setSelectedWorkspaceId(handle.workspace.id);
        setSelectedThreadId(handle.thread.id);
      }
      return { adopted, handle };
    },
    [callRpc, selectedThread, selectedWorkspace],
  );

  const handleRetryResponse = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      if (!selectedWorkspace || !selectedThread) return;
      let handle: ThreadHandle | null = null;
      try {
        const branch = (await branchFromMessage(item)) ?? null;
        if (!branch) return;
        handle = branch.handle;
        const key = draftKeyFor(handle.workspace.id, handle.thread.id);
        if (branch.adopted) {
          sendingConversationKeyRef.current = key;
          sendingBaselineAgentItemIdRef.current = null;
          setIsSubmitting(true);
        }
        await submitQueuedAction(
          "turn.start",
          {
            workspace_id: handle.workspace.id,
            thread_id: handle.thread.id,
            inputs: [
              ...(item.text.trim() ? [{ type: "text", text: item.text }] : []),
              ...item.attachments,
            ],
            selected_skills: selectedSkillsFromText(
              item.text,
              composerSkillCatalog(
                liveSkillsRef.current,
                selectedWorkspace,
                selectedThread.provider,
              ),
            ),
            provider: selectedThread.provider,
            model_id: selectedThread.agent.model_id,
            reasoning_effort: selectedThread.agent.reasoning_effort,
            approval_policy: selectedThread.agent.approval_policy,
            service_tier: selectedThread.agent.service_tier,
            permission_mode: selectedThread.agent.permission_mode,
            sandbox_mode: selectedThread.agent.sandbox_mode,
          },
          { awaitCompletion: false },
        );
        setError(null);
        toast({
          variant: "success",
          title: "Trying again",
          description: "The original thread is unchanged.",
        });
      } catch (error) {
        if (handle) {
          const key = draftKeyFor(handle.workspace.id, handle.thread.id);
          setDraftForConversation(key, item.text);
          setAttachmentsForConversation(key, () => item.attachments);
        }
        const branchKey = handle
          ? draftKeyFor(handle.workspace.id, handle.thread.id)
          : null;
        if (branchKey && sendingConversationKeyRef.current === branchKey) {
          sendingConversationKeyRef.current = null;
          setIsSubmitting(false);
        }
        reportError(error, "Failed to try again");
        throw error instanceof Error
          ? error
          : new Error("Failed to retry response");
      }
    },
    [
      branchFromMessage,
      reportError,
      selectedThread,
      selectedWorkspace,
      setAttachmentsForConversation,
      setDraftForConversation,
      submitQueuedAction,
      toast,
    ],
  );
  // workspace.remove has no queued-action handler on the daemon (the queue
  // only covers the write path a reconnect may replay), so this goes over the
  // encrypted RPC channel like the other structural edits below.
  async function handleRemoveWorkspace(workspaceId: string) {
    try {
      await callRpc("workspace.remove", { workspace_id: workspaceId });
      if (selectedWorkspaceId === workspaceId) {
        setThreadDetail(null);
        setSelectedWorkspaceId(null);
        setSelectedThreadId(null);
      }
      setError(null);
    } catch (e) {
      // The confirm dialog renders the rejection inline and stays open, so it
      // has to see the failure rather than a resolved promise.
      reportError(e, "Failed to remove project");
      throw e instanceof Error ? e : new Error("Failed to remove project");
    }
  }

  async function handleArchiveThread(workspaceId: string, threadId: string) {
    try {
      await callRpc("thread.archive", {
        workspace_id: workspaceId,
        thread_id: threadId,
      });
      if (selectedThreadId === threadId) {
        setThreadDetail(null);
        setSelectedThreadId(null);
      }
      setError(null);
    } catch (e) {
      reportError(e, "Failed to archive thread");
    }
  }

  async function handleRenameThread(
    workspaceId: string,
    threadId: string,
    title: string,
  ) {
    try {
      const handle = normalizeThreadHandle(
        await callRpc<ThreadHandle>("thread.update", {
          workspace_id: workspaceId,
          thread_id: threadId,
          title,
        }),
      );
      applyThreadHandle(handle);
      setError(null);
    } catch (e) {
      // The rename dialog keeps itself open on a rejection so the typed title
      // is not lost, so this has to rethrow after reporting.
      reportError(e, "Failed to rename thread");
      throw e instanceof Error ? e : new Error("Failed to rename thread");
    }
  }

  async function handleSuggestThreadTitle(
    workspaceId: string,
    threadId: string,
  ) {
    try {
      const result = await callRpc<{ title?: unknown }>("thread.suggestTitle", {
        workspace_id: workspaceId,
        thread_id: threadId,
      });
      const title = typeof result.title === "string" ? result.title.trim() : "";
      if (!title) throw new Error("Couldn't generate a title");
      setError(null);
      return title;
    } catch (e) {
      reportError(e, "Couldn't generate a title");
      throw e instanceof Error ? e : new Error("Couldn't generate a title");
    }
  }

  // Adapts the relay's `thread.*`/`turn.*` RPC methods to the shape the
  // shared `forkThread` helper expects. Thread creation reads/writes go
  // straight over the RPC channel like `branchFromMessage` above; the
  // resulting turn goes through the durable queued-action path like every
  // other turn submission on this client, so a fork survives a flaky
  // connection the same way a normal send does.
  const forkApi = useMemo<ForkThreadApi>(
    () => ({
      forkThread: (payload) =>
        callRpc<ThreadHandle>("thread.fork", payload).then(
          normalizeThreadHandle,
        ),
      startThread: (payload) =>
        callRpc<ThreadHandle>("thread.start", payload).then(
          normalizeThreadHandle,
        ),
      updateThread: (payload) =>
        callRpc<ThreadHandle>("thread.update", payload).then(
          normalizeThreadHandle,
        ),
      sendTurn: async (payload) => {
        await submitQueuedAction("turn.start", payload, {
          awaitCompletion: false,
        });
        return { ok: true };
      },
      threadDetail: (workspaceId, threadId, request) =>
        callRpc<ThreadDetail>("thread.detail", {
          workspace_id: workspaceId,
          thread_id: threadId,
          ...request,
        }).then(normalizeThreadDetail),
    }),
    [callRpc, submitQueuedAction],
  );

  async function handleForkThread(workspaceId: string, threadId: string) {
    const workspace = snapshot?.workspaces.find(
      (entry) => entry.id === workspaceId,
    );
    const thread = snapshot?.threads.find((entry) => entry.id === threadId);
    if (!workspace || !thread) {
      reportError(new Error("Thread not found"), "Failed to fork thread");
      return;
    }
    try {
      const handle = await forkThread(forkApi, { workspace, thread });
      setSnapshot((current) =>
        current
          ? {
              ...current,
              workspaces: current.workspaces.map((entry) =>
                entry.id === handle.workspace.id ? handle.workspace : entry,
              ),
              threads: [
                handle.thread,
                ...current.threads.filter(
                  (entry) => entry.id !== handle.thread.id,
                ),
              ],
            }
          : current,
      );
      setSelectedWorkspaceId(handle.workspace.id);
      setSelectedThreadId(handle.thread.id);
      setError(null);
    } catch (e) {
      reportError(e, "Failed to fork thread");
    }
  }

  const handleHandoffProviderSelect = useCallback(
    async (provider: AgentProvider) => {
      if (
        !selectedWorkspace ||
        !selectedThread ||
        provider === selectedThread.provider
      ) {
        return;
      }
      if (handoffPendingRef.current) return;
      handoffPendingRef.current = true;
      setHandoffPending(true);

      const destination = handoffDestinationSettings(
        selectedWorkspace,
        provider,
        persistedComposerSelections,
      );
      const targetLabel = destination.destinationLabel;
      const showHandoffThread = (handle: ThreadHandle) => {
        const destinationKey = draftKeyFor(
          handle.workspace.id,
          handle.thread.id,
        );
        const emptyDetail: ThreadDetail = {
          workspace: handle.workspace,
          thread: handle.thread,
          items: [],
          has_older: false,
          oldest_item_id: null,
          newest_item_id: null,
          is_partial: false,
        };
        setSnapshot((current) =>
          current
            ? {
                ...current,
                workspaces: current.workspaces.map((workspace) =>
                  workspace.id === handle.workspace.id
                    ? handle.workspace
                    : workspace,
                ),
                threads: [
                  handle.thread,
                  ...current.threads.filter(
                    (thread) => thread.id !== handle.thread.id,
                  ),
                ],
              }
            : current,
        );
        conversationKeyRef.current = destinationKey;
        threadDetailRef.current = emptyDetail;
        setHandoffPendingThreadKey(destinationKey);
        setThreadDetail(emptyDetail);
        setSelectedWorkspaceId(handle.workspace.id);
        setSelectedThreadId(handle.thread.id);
      };

      try {
        await handoffThread(
          forkApi,
          {
            workspace: selectedWorkspace,
            thread: selectedThread,
            provider,
            ...destination,
          },
          { onDestinationReady: showHandoffThread },
        );
        setError(null);
        toast({
          variant: "success",
          title: `Continuing with ${targetLabel}`,
          description:
            "The source conversation was carried over verbatim. The original is unchanged.",
        });
      } catch (error: unknown) {
        if (error instanceof HandoffIncompleteError) {
          showHandoffThread(error.handle);
          if (error.detail) {
            threadDetailRef.current = error.detail;
            setThreadDetail(error.detail);
          }
          if (!error.turnStarted) {
            setDraftForConversation(
              draftKeyFor(error.handle.workspace.id, error.handle.thread.id),
              error.prompt,
            );
          }
          setError(error.message);
          toast({
            variant: "warning",
            title: `Linked ${targetLabel} thread created`,
            description: error.turnStarted
              ? "FalconDeck lost confirmation after starting the handoff turn. Check the linked thread before retrying."
              : "The handoff turn did not start. Its prompt is ready in the composer to resend.",
          });
          return;
        }
        reportError(error, "Failed to create handoff");
      } finally {
        handoffPendingRef.current = false;
        setHandoffPending(false);
        setHandoffPendingThreadKey(null);
      }
    },
    [
      forkApi,
      persistedComposerSelections,
      reportError,
      selectedThread,
      selectedWorkspace,
      setDraftForConversation,
      toast,
    ],
  );

  // Set by "Mark as unread" so the auto-read effect does not undo it while
  // the thread is still selected.
  const suppressAutoReadRef = useRef<{
    threadId: string;
    activitySeq: number;
  } | null>(null);

  async function handleMarkThreadRead(workspaceId: string, threadId: string) {
    const thread = snapshot?.threads.find(
      (entry) => entry.workspace_id === workspaceId && entry.id === threadId,
    );
    try {
      const updated = normalizeThreadSummary(
        await callRpc<ThreadSummary>("thread.mark_read", {
          workspace_id: workspaceId,
          thread_id: threadId,
          read_seq: thread?.attention.last_agent_activity_seq ?? 0,
        }),
      );
      applyThreadSummary(updated);
    } catch (e) {
      reportError(e, "Failed to mark thread as read");
    }
  }

  async function handleMarkThreadUnread(workspaceId: string, threadId: string) {
    const thread = snapshot?.threads.find(
      (entry) => entry.workspace_id === workspaceId && entry.id === threadId,
    );
    // The auto-read effect re-reads the selected, focused thread, which would
    // undo this immediately. Park it on the suppression ref first; the effect
    // releases once the selection moves or new agent activity arrives.
    suppressAutoReadRef.current = {
      threadId,
      activitySeq: thread?.attention.last_agent_activity_seq ?? 0,
    };
    try {
      const updated = normalizeThreadSummary(
        await callRpc<ThreadSummary>("thread.mark_unread", {
          workspace_id: workspaceId,
          thread_id: threadId,
        }),
      );
      suppressAutoReadRef.current = {
        threadId,
        activitySeq: updated.attention.last_agent_activity_seq,
      };
      applyThreadSummary(updated);
    } catch (e) {
      suppressAutoReadRef.current = null;
      reportError(e, "Failed to mark thread as unread");
    }
  }

  async function handleRemoveQueuedTurn(queuedId: string) {
    if (!selectedWorkspaceId || !selectedThreadId) return;
    try {
      await callRpc("thread.queue.remove", {
        workspace_id: selectedWorkspaceId,
        thread_id: selectedThreadId,
        queued_id: queuedId,
      });
    } catch (e) {
      reportError(e, "Failed to remove queued message");
    }
  }

  async function handleSteerQueuedTurn(queuedId: string) {
    if (!selectedWorkspaceId || !selectedThreadId) return;
    try {
      await callRpc("thread.queue.steer", {
        workspace_id: selectedWorkspaceId,
        thread_id: selectedThreadId,
        queued_id: queuedId,
      });
    } catch (e) {
      // The daemon leaves the message queued when a steer fails, so the chip
      // the user acted on is still there when they read this.
      reportError(e, "Failed to steer queued message");
    }
  }

  async function handleEditQueuedTurn(queuedId: string, text: string) {
    if (!selectedWorkspaceId || !selectedThreadId) return;
    try {
      await callRpc("thread.queue.edit", {
        workspace_id: selectedWorkspaceId,
        thread_id: selectedThreadId,
        queued_id: queuedId,
        text,
      });
    } catch (e) {
      // A failed edit leaves the original message queued, so nothing is lost.
      reportError(e, "Failed to edit queued message");
    }
  }

  // Read-only, so a miss just leaves the row image-free rather than raising
  // a banner over a cosmetic failure. Remote clients have no loopback HTTP
  // route to the daemon, so the bytes travel as a data URL over the relay.
  const handleQueuedTurnAttachmentPreview = useCallback(
    async (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return undefined;
      try {
        const result = await callRpc<{ url?: string }>(
          "thread.queue.attachment_preview",
          {
            workspace_id: selectedWorkspaceId,
            thread_id: selectedThreadId,
            queued_id: queuedId,
          },
        );
        return result.url;
      } catch {
        return undefined;
      }
    },
    [callRpc, selectedThreadId, selectedWorkspaceId],
  );

  async function handleSetGoal(objective: string, tokenBudget: number | null) {
    if (!selectedWorkspaceId || !selectedWorkspace)
      throw new Error("Select a project first");
    let activeThreadId = selectedThreadId;
    if (!activeThreadId) {
      const handle = normalizeThreadHandle(
        await submitQueuedAction<ThreadHandle>("thread.start", {
          workspace_id: selectedWorkspace.id,
          provider: selectedProvider,
          model_id: selectedModel,
          collaboration_mode_id: selectedCollaborationMode,
          approval_policy: approvalPolicyForProvider(
            selectedProvider,
            selectedPermissionMode,
          ),
          permission_mode: selectedPermissionMode,
          sandbox_mode: selectedSandboxMode,
        }),
      );
      activeThreadId = handle.thread.id;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              workspaces: current.workspaces.map((workspace) =>
                workspace.id === handle.workspace.id
                  ? handle.workspace
                  : workspace,
              ),
              threads: [
                handle.thread,
                ...current.threads.filter(
                  (thread) => thread.id !== handle.thread.id,
                ),
              ],
            }
          : current,
      );
      setThreadDetail({
        workspace: handle.workspace,
        thread: handle.thread,
        items: [],
        has_older: false,
        oldest_item_id: null,
        newest_item_id: null,
        is_partial: false,
      });
      setSelectedWorkspaceId(handle.workspace.id);
      setSelectedThreadId(activeThreadId);
    }
    applyThreadSummary(
      normalizeThreadSummary(
        await callRpc<ThreadSummary>("thread.goal.set", {
          workspace_id: selectedWorkspaceId,
          thread_id: activeThreadId,
          objective,
          token_budget: tokenBudget,
        }),
      ),
    );
  }

  async function handleClearGoal() {
    if (!selectedWorkspaceId || !selectedThreadId) return;
    applyThreadSummary(
      normalizeThreadSummary(
        await callRpc<ThreadSummary>("thread.goal.clear", {
          workspace_id: selectedWorkspaceId,
          thread_id: selectedThreadId,
        }),
      ),
    );
  }

  async function handleSetGoalStatus(status: "active" | "paused") {
    if (!selectedWorkspaceId || !selectedThreadId) return;
    applyThreadSummary(
      normalizeThreadSummary(
        await callRpc<ThreadSummary>("thread.goal.set", {
          workspace_id: selectedWorkspaceId,
          thread_id: selectedThreadId,
          status,
        }),
      ),
    );
  }
  const isThreadDetailPending = useMemo(
    () =>
      Boolean(
        selectedThreadId &&
        (!threadDetail ||
          threadDetail.workspace.id !== selectedWorkspaceId ||
          threadDetail.thread.id !== selectedThreadId ||
          (threadDetail.is_partial && threadDetail.items.length === 0)),
      ),
    [selectedThreadId, selectedWorkspaceId, threadDetail],
  );
  const loadingThreadState = useMemo(
    () => (
      <div className="flex min-h-[240px] items-center justify-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted">
        <ActivityDiamond size="md" />
        Loading conversation...
      </div>
    ),
    [],
  );
  const conversationEmptyState = useMemo(() => {
    if (isThreadDetailPending) {
      return loadingThreadState;
    }
    if (selectedThreadId) {
      return undefined;
    }
    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="space-y-2">
          <p className="text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
            Start a new thread
          </p>
          <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
            Pick a project below to open a fresh conversation from this browser.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {(snapshot?.workspaces ?? []).length > 0 ? (
            (snapshot?.workspaces ?? []).map((workspace) => (
              <Button
                key={workspace.id}
                type="button"
                variant={
                  workspace.id === selectedWorkspace?.id ? "default" : "outline"
                }
                size="sm"
                onClick={() => handleNewThread(workspace.id)}
              >
                {workspace.path.split("/").pop() ?? workspace.path}
              </Button>
            ))
          ) : (
            <p className="fd-type-supporting text-fg-muted">
              Waiting for projects from your desktop session.
            </p>
          )}
        </div>
      </div>
    );
  }, [
    handleNewThread,
    isThreadDetailPending,
    loadingThreadState,
    selectedThreadId,
    selectedWorkspace,
    snapshot?.workspaces,
  ]);
  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      setAttachmentsForConversation(conversationKey, (current) =>
        current.filter((attachment) => attachment.id !== attachmentId),
      );
    },
    [conversationKey, setAttachmentsForConversation],
  );
  const handlePickImages = useCallback(
    (files: FileList | readonly File[] | null) => {
      const selectedCount = files?.length ?? 0;
      if (selectedCount === 0) return;
      const provider = selectedThread?.provider ?? selectedProvider;
      if (
        !workspaceAgentCapabilities(selectedWorkspace, provider).supports_images
      ) {
        setError("The selected agent does not support image attachments.");
        return;
      }
      // Bind to the conversation the user picked in; file reading is async and
      // they may have navigated away by the time it resolves.
      const key = conversationKey;
      updateAttachmentPreparation(key, selectedCount);
      void filesToImageInputs(
        files,
        attachmentsByConversationRef.current[key] ?? NO_ATTACHMENTS,
      )
        .then((next) => {
          const current =
            attachmentsByConversationRef.current[key] ?? NO_ATTACHMENTS;
          validateImageAttachmentBudget([...current, ...next]);
          setAttachmentsForConversation(key, () => [...current, ...next]);
        })
        .catch((cause) => reportError(cause, "Could not attach that image"))
        .finally(() => updateAttachmentPreparation(key, -selectedCount));
    },
    [
      conversationKey,
      reportError,
      selectedProvider,
      selectedThread?.provider,
      selectedWorkspace,
      setAttachmentsForConversation,
      updateAttachmentPreparation,
    ],
  );

  useEffect(() => {
    if (!snapshot) return;
    // Streaming deltas create an item cache for every thread they mention,
    // but only the selected thread reads its cache — selecting a thread
    // rehydrates through thread.detail regardless. Bound the cache so a
    // long-lived session cannot accumulate one growing array per streamed
    // thread; see boundRetainedThreadItems for the eviction rules.
    setThreadItems((current) =>
      boundRetainedThreadItems(current, snapshot.threads, selectedThreadId),
    );
  }, [selectedThreadId, snapshot]);

  useEffect(() => {
    const count = countAwaitingResponseThreads(snapshot?.threads ?? []);
    document.title =
      count > 0 ? `(${count}) FalconDeck Remote` : "FalconDeck Remote";
  }, [snapshot?.threads]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThread || !windowFocused) return;
    const readSeq = selectedThread.attention.last_agent_activity_seq;
    const suppressed = suppressAutoReadRef.current;
    if (
      suppressed &&
      (suppressed.threadId !== selectedThread.id ||
        suppressed.activitySeq !== readSeq)
    ) {
      suppressAutoReadRef.current = null;
    } else if (suppressed) {
      return;
    }
    if (!readSeq || readSeq <= selectedThread.attention.last_read_seq) return;

    void submitQueuedAction<ThreadSummary>("thread.mark_read", {
      workspace_id: selectedWorkspaceId,
      thread_id: selectedThread.id,
      read_seq: readSeq,
    })
      .then((thread) => {
        const normalizedThread = normalizeThreadSummary(thread);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((entry) =>
                  entry.id === normalizedThread.id ? normalizedThread : entry,
                ),
              }
            : current,
        );
        setThreadDetail((current) =>
          current && current.thread.id === normalizedThread.id
            ? { ...current, thread: normalizedThread }
            : current,
        );
      })
      .catch(() => {});
  }, [selectedThread, selectedWorkspaceId, submitQueuedAction, windowFocused]);

  useEffect(() => {
    if (!snapshot?.threads?.length) return;

    for (const thread of snapshot.threads) {
      const attention = deriveThreadAttentionPresentation(
        thread,
        snapshot.interactive_requests,
      );
      if (
        attention.level === "none" ||
        (windowFocused && selectedThreadId === thread.id)
      ) {
        notifiedAttentionRef.current.delete(thread.id);
        continue;
      }

      const previous = notifiedAttentionRef.current.get(thread.id);
      if (previous === attention.level) continue;
      notifiedAttentionRef.current.set(thread.id, attention.level);

      // Permission is only ever asked for from the Preferences toggle, which
      // runs inside a click — Safari and Firefox reject the request outside
      // one, and a refused prompt is not re-offered.
      if (!canPostNotifications(notificationPreference)) continue;

      const body =
        attention.level === "awaiting_response"
          ? "The agent needs a response in this thread."
          : attention.level === "error"
            ? "The latest run ended with an error."
            : "New activity in this thread.";
      postThreadNotification(thread.title || "FalconDeck thread", body);
    }
  }, [
    notificationPreference,
    selectedThreadId,
    snapshot?.interactive_requests,
    snapshot?.threads,
    windowFocused,
  ]);

  const handleNotificationPreferenceChange = useCallback(
    (value: NotificationPreference) => {
      setNotificationPreference(value);
      persistNotificationPreference(value);
    },
    [],
  );

  const handleThreadSortChange = useCallback((mode: ThreadSortMode) => {
    setThreadSort(mode);
    persistThreadSortMode(mode);
  }, []);

  const handleWorkspaceOrderChange = useCallback(
    async (workspaceIds: string[]) => {
      try {
        const preferences = normalizePreferences(
          await submitQueuedAction("preferences.update", {
            workspace_order: workspaceIds,
          }),
        );
        setSnapshot((current) =>
          current ? { ...current, preferences } : current,
        );
      } catch (error) {
        reportError(error, "Failed to save project order");
        throw error;
      }
    },
    [reportError, setSnapshot, submitQueuedAction],
  );

  const handleWorkspaceColorChange = useCallback(
    async (workspaceId: string, color: WorkspaceColorId | null) => {
      const nextColors = {
        ...(snapshot?.preferences.workspace_colors ?? {}),
      };
      if (color) nextColors[workspaceId] = color;
      else delete nextColors[workspaceId];
      try {
        const preferences = normalizePreferences(
          await submitQueuedAction("preferences.update", {
            workspace_colors: nextColors,
          }),
        );
        setSnapshot((current) =>
          current ? { ...current, preferences } : current,
        );
      } catch (error) {
        reportError(error, "Failed to save project color");
        throw error;
      }
    },
    [
      reportError,
      setSnapshot,
      snapshot?.preferences.workspace_colors,
      submitQueuedAction,
    ],
  );

  useEffect(() => {
    if (!showProjects) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowProjects(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [showProjects]);

  const extensionPanelNavigation =
    extensionPanels.length > 0 ? (
      <ExtensionPanelNavigation
        panels={extensionPanels}
        activePanelKey={activeExtensionPanelKey}
        onSelect={handleSelectExtensionPanel}
      />
    ) : undefined;

  // ── Pairing screen (not connected) ─────────────────────────────────

  if (!isConnected) {
    return (
      <RemotePairingScreen
        relayUrl={relayUrl}
        pairingCode={pairingCode}
        isConnecting={isClaimingPairing}
        connectionHelp={connectionHelp}
        connectionDebugRows={connectionDebugRows}
        onRelayUrlChange={setRelayUrl}
        onPairingCodeChange={setPairingCode}
        onConnect={() => void handleClaimPairing()}
        onResetSavedConnection={resetSavedRemoteConnection}
      />
    );
  }

  // ── Connected session ──────────────────────────────────────────────

  const headerConnectionState = connectionBadgeState(
    connectionStatus,
    desktopOnline,
    hasSessionKey,
    daemonRpcReady,
    daemonPresenceKnown,
  );

  return (
    <div className="fd-safe-area flex h-full flex-col overflow-x-hidden bg-surface-0">
      <SessionHeader
        workspace={selectedWorkspace}
        thread={selectedThread}
        onNewThread={selectedThread ? handleNewThreadFromCurrent : undefined}
        leadingActions={
          <ShipMenu
            thread={selectedThread}
            onShip={shipThread}
            pending={isShipPending}
            projectFolderDirty={projectFolderDirty}
            mergeFailure={mergeFailure}
            onDismissMergeFailure={dismissMergeFailure}
          />
        }
        className="border-b border-border-subtle pt-3"
        navigation={
          <button
            type="button"
            onClick={() => setShowProjects((value) => !value)}
            className="fd-focus flex shrink-0 items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1 text-fg-secondary transition-colors hover:bg-surface-2 hover:text-fg-primary md:hidden"
            aria-label={showProjects ? "Hide projects" : "Show projects"}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        }
      >
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {selectedWorkspace && activeCapabilities.supports_goals ? (
            <GoalControl
              goal={selectedThread?.goal ?? null}
              provider={activeProvider}
              disabled={!isEncrypted}
              onSetGoal={handleSetGoal}
              onClearGoal={handleClearGoal}
              onSetGoalStatus={handleSetGoalStatus}
            />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Preferences"
            onFocus={() => void loadRemotePreferencesModal()}
            onPointerEnter={() => void loadRemotePreferencesModal()}
            onClick={() => setShowPreferences(true)}
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">Preferences</span>
          </Button>
          <Badge variant={headerConnectionState.variant} dot>
            {headerConnectionState.label}
          </Badge>
        </div>
      </SessionHeader>

      {connectionHelp ? (
        <div className="border-b border-border-subtle bg-surface-1 px-4 py-3 md:px-5">
          <div className="mx-auto w-full">
            <RemoteConnectionHelpCard
              help={connectionHelp}
              debugRows={connectionDebugRows}
              onReset={resetSavedRemoteConnection}
            />
          </div>
        </div>
      ) : null}

      {showPreferences ? (
        <Suspense
          fallback={
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Loading preferences"
              className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay-strong)] backdrop-blur-sm"
            >
              <div
                role="status"
                className="flex items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-4 py-3 text-[length:var(--fd-text-sm)] text-fg-muted shadow-xl"
              >
                <ActivityDiamond size="md" />
                Loading preferences…
              </div>
            </div>
          }
        >
          <RemotePreferencesModal
            isOpen
            preferences={snapshot?.preferences ?? null}
            notificationPreference={notificationPreference}
            onClose={() => setShowPreferences(false)}
            onUpdatePreferences={(payload) => {
              void handleUpdatePreferences(payload);
            }}
            onNotificationPreferenceChange={handleNotificationPreferenceChange}
          />
        </Suspense>
      ) : null}

      {projectsDrawer.mounted ? (
        <div
          data-state={projectsDrawer.entered ? "open" : "closed"}
          className="group fd-safe-area fixed inset-0 z-40 bg-[var(--fd-overlay-strong)] opacity-0 backdrop-blur-sm transition-opacity duration-[var(--fd-duration-panel)] ease-[var(--fd-ease-panel)] data-[state=open]:opacity-100 md:hidden"
        >
          <button
            type="button"
            className="absolute inset-0 h-full w-full"
            aria-label="Close projects"
            tabIndex={-1}
            onClick={() => setShowProjects(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Projects"
            className="absolute inset-y-0 left-0 flex w-full max-w-none -translate-x-full transition-transform duration-[var(--fd-duration-panel)] ease-[var(--fd-ease-panel)] group-data-[state=open]:translate-x-0"
          >
            <div className="flex h-full w-full flex-col border-r border-border-default bg-surface-1 shadow-2xl">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <div>
                  <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.24em] text-fg-muted">
                    Navigation
                  </p>
                  <h2 className="mt-1 text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
                    Projects
                  </h2>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  aria-label="Close projects"
                  onClick={() => setShowProjects(false)}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
              <WorkspaceSidebar
                groups={groups}
                selectedWorkspaceId={selectedWorkspaceId}
                selectedThreadId={selectedThreadId}
                onSelectWorkspace={handleSelectWorkspace}
                onSelectThread={handleSelectThread}
                onNewThread={handleNewThread}
                onArchiveThread={handleArchiveThread}
                onRenameThread={handleRenameThread}
                onSuggestThreadTitle={handleSuggestThreadTitle}
                onForkThread={handleForkThread}
                onTogglePinThread={handleTogglePinThread}
                onTogglePinThreadInProject={handleTogglePinThreadInProject}
                onMarkThreadRead={handleMarkThreadRead}
                onMarkThreadUnread={handleMarkThreadUnread}
                onRemoveWorkspace={handleRemoveWorkspace}
                threadSort={threadSort}
                onThreadSortChange={handleThreadSortChange}
                onWorkspaceOrderChange={handleWorkspaceOrderChange}
                workspaceColors={snapshot?.preferences.workspace_colors}
                onWorkspaceColorChange={handleWorkspaceColorChange}
                topNavigation={extensionPanelNavigation}
                title="Projects"
                errors={error ? [error] : []}
                threadTagsById={threadTags.byThreadId}
                threadTagOptions={threadTags.tags}
                extensionSidebarFilters={extensionSidebarFilters}
                extensionSnapshot={snapshot?.extensions}
                onSetThreadStage={
                  threadTagsEnabled ? handleSetThreadStage : undefined
                }
                onCreateThreadStage={
                  threadTagsEnabled ? handleCreateThreadStage : undefined
                }
                emptyState={{
                  title: "Waiting for projects",
                  description:
                    "Projects will appear after the desktop shares its current snapshot.",
                }}
                className="h-full min-h-0 bg-surface-1"
                headerClassName="hidden"
                contentClassName="px-4 pb-8 pt-4"
              />
            </div>
          </div>
        </div>
      ) : null}

      {paletteRequestKey > 0 ? (
        <Suspense fallback={null}>
          <CommandPalette
            groups={groups}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onOpenSettings={() => setShowPreferences(true)}
            openRequestKey={paletteRequestKey}
            requestMode="toggle"
          />
        </Suspense>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceSidebar
          groups={groups}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedThreadId={selectedThreadId}
          onSelectWorkspace={handleSelectWorkspace}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThread}
          onArchiveThread={handleArchiveThread}
          onRenameThread={handleRenameThread}
          onSuggestThreadTitle={handleSuggestThreadTitle}
          onForkThread={handleForkThread}
          onTogglePinThread={handleTogglePinThread}
          onTogglePinThreadInProject={handleTogglePinThreadInProject}
          onMarkThreadRead={handleMarkThreadRead}
          onMarkThreadUnread={handleMarkThreadUnread}
          onRemoveWorkspace={handleRemoveWorkspace}
          threadSort={threadSort}
          onThreadSortChange={handleThreadSortChange}
          onWorkspaceOrderChange={handleWorkspaceOrderChange}
          workspaceColors={snapshot?.preferences.workspace_colors}
          onWorkspaceColorChange={handleWorkspaceColorChange}
          topNavigation={extensionPanelNavigation}
          title="Projects"
          errors={error ? [error] : []}
          threadTagsById={threadTags.byThreadId}
          threadTagOptions={threadTags.tags}
          extensionSidebarFilters={extensionSidebarFilters}
          extensionSnapshot={snapshot?.extensions}
          onSetThreadStage={
            threadTagsEnabled ? handleSetThreadStage : undefined
          }
          onCreateThreadStage={
            threadTagsEnabled ? handleCreateThreadStage : undefined
          }
          emptyState={{
            title: "Waiting for projects",
            description:
              "Projects will appear after the desktop shares its current snapshot.",
          }}
          className="hidden h-full min-h-0 w-[280px] shrink-0 border-r border-border-subtle bg-surface-1 md:flex"
          headerClassName="pt-4"
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {activeExtensionPanel &&
          activeExtension &&
          activeExtensionRegistration &&
          snapshot ? (
            <ExtensionAppPanel
              panel={activeExtensionPanel}
              registration={activeExtensionRegistration}
              extension={activeExtension}
              threads={snapshot.threads}
              views={snapshot.extensions.views}
              onInvokeAction={(panel, actionId, input, target) =>
                invokeExtensionAppAction(
                  panel.extensionId,
                  actionId,
                  input,
                  target,
                )
              }
              onOpenThread={handleSelectThread}
              onClose={() => setActiveExtensionPanelKey(null)}
            />
          ) : activeExtensionPanel ? (
            <ExtensionPanel
              panel={activeExtensionPanel}
              onAction={handleExtensionPanelAction}
              onClose={() => setActiveExtensionPanelKey(null)}
            />
          ) : (
            <>
              {operationalConditions.length > 0 ? (
                <OperationalNotice
                  conditions={operationalConditions}
                  onDismiss={dismissOperationalCondition}
                />
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Conversation
                  threadKey={
                    selectedThreadId
                      ? `${selectedWorkspaceId ?? "workspace"}:${selectedThreadId}`
                      : selectedWorkspaceId
                  }
                  items={items}
                  exportTitle={selectedThread?.title}
                  preferences={snapshot?.preferences ?? null}
                  emptyState={conversationEmptyState}
                  isSending={isSubmitting || isPreparingSelectedHandoff}
                  sendingLabel={
                    isPreparingSelectedHandoff
                      ? "Starting the linked thread…"
                      : null
                  }
                  isThinking={selectedThread?.status === "running"}
                  isWaitingForInput={
                    selectedThread?.status === "waiting_for_input"
                  }
                  isLoading={isThreadDetailPending}
                  hasOlder={Boolean(
                    threadDetail?.workspace.id === selectedWorkspaceId &&
                    threadDetail.thread.id === selectedThreadId &&
                    threadDetail.has_older,
                  )}
                  isLoadingOlder={
                    loadingOlderThreadKey ===
                    `${selectedWorkspaceId}:${selectedThreadId}`
                  }
                  onLoadOlder={handleLoadOlder}
                  onRetryResponse={
                    selectedThread &&
                    activeCapabilities.supports_forking &&
                    !selectedThread.variant &&
                    selectedThread.status !== "running" &&
                    selectedThread.status !== "waiting_for_input"
                      ? handleRetryResponse
                      : undefined
                  }
                  pinnedPlanId={pinnedPlan?.itemId ?? null}
                  readAloud={readAloud}
                />
              </div>

              <div className="shrink-0 border-t border-border-subtle bg-surface-0/95 backdrop-blur md:bg-transparent md:backdrop-blur-0">
                {pinnedPlan ? (
                  <PlanBar plan={pinnedPlan.plan} threadKey={conversationKey} />
                ) : null}
                <InteractiveRequestBar
                  requests={interactiveRequests}
                  onRespond={(request, response) =>
                    handleInteractiveResponse(
                      request.workspace_id,
                      request.request_id,
                      response,
                    )
                  }
                />
                {selectedThread &&
                wasTurnInterruptedByShutdown(selectedThread) ? (
                  <InterruptedTurnNotice
                    onContinue={handleContinueInterruptedTurn}
                    onDismiss={handleDismissInterruptedTurn}
                    isContinuing={isSubmitting}
                  />
                ) : null}
                {selectedThread ? (
                  <QueuedTurns
                    queuedTurns={selectedThread.queued_turns}
                    canSteer={activeCapabilities.supports_steering}
                    onRemove={(queuedId) =>
                      void handleRemoveQueuedTurn(queuedId)
                    }
                    onSteer={(queuedId) => void handleSteerQueuedTurn(queuedId)}
                    onEdit={(queuedId, text) =>
                      void handleEditQueuedTurn(queuedId, text)
                    }
                    getAttachmentPreviewUrl={handleQueuedTurnAttachmentPreview}
                  />
                ) : null}
                {selectedThread?.goal && activeCapabilities.supports_goals ? (
                  <GoalBubble
                    goal={selectedThread.goal}
                    provider={activeProvider}
                    onClearGoal={handleClearGoal}
                    onSetGoalStatus={handleSetGoalStatus}
                  />
                ) : null}
                <ComposerSuggestionPill
                  offer={composerSuggestionOffer}
                  onSubmit={handleSubmitComposerSuggestion}
                  onDismiss={handleDismissComposerSuggestions}
                />
                <PromptInput
                  key={`${conversationKey}:${activeProvider}:${activeCapabilities.supports_images ? "images" : "no-images"}`}
                  value={draft}
                  onValueChange={setDraft}
                  onSubmit={() => void handleSubmit()}
                  onStop={() => void handleStop()}
                  onPickImages={handlePickImages}
                  onRemoveAttachment={handleRemoveAttachment}
                  attachments={attachments}
                  preparingAttachmentCount={preparingAttachmentCount}
                  skills={selectedWorkspace?.skills ?? []}
                  loadSkills={loadSkills}
                  selectedProvider={activeProvider}
                  onProviderChange={handleProviderChange}
                  providers={providerOptions}
                  capabilities={activeCapabilities}
                  compactCommandAvailable={
                    Boolean(selectedThread) &&
                    activeCapabilities.supports_compaction &&
                    selectedThread?.status !== "running" &&
                    selectedThread?.status !== "waiting_for_input"
                  }
                  missionCommandAvailable={missionCommandAvailable(
                    snapshot?.extensions,
                  )}
                  providerLocked={Boolean(selectedThread)}
                  showProviderSelector={!selectedThread}
                  handoffProviders={handoffProviderOptions}
                  onHandoffProviderSelect={
                    selectedThread ? handleHandoffProviderSelect : undefined
                  }
                  handoffDisabledReason={handoffDisabledReason}
                  models={models}
                  selectedModelId={selectedModel}
                  onModelChange={handleModelChange}
                  reasoningOptions={currentReasoningOptions}
                  selectedEffort={selectedEffort}
                  onEffortChange={handleEffortChange}
                  selectedServiceTier={selectedServiceTier}
                  onServiceTierChange={handleServiceTierChange}
                  collaborationModes={workspaceCollaborationModes(
                    selectedWorkspace,
                    activeProvider,
                  )}
                  selectedCollaborationMode={selectedCollaborationMode}
                  onCollaborationModeChange={handleCollaborationModeChange}
                  selectedPermissionMode={selectedPermissionMode}
                  onPermissionModeChange={handlePermissionModeChange}
                  selectedSandboxMode={selectedSandboxMode}
                  onSandboxModeChange={handleSandboxModeChange}
                  disabled={
                    !selectedWorkspace ||
                    !sessionId ||
                    !clientToken ||
                    !hasSessionKey
                  }
                  sendDisabled={
                    isSubmitting ||
                    isPreparingSelectedHandoff ||
                    preparingAttachmentCount > 0 ||
                    Boolean(attachmentSendBlockReason)
                  }
                  sendDisabledReason={
                    attachmentSendBlockReason ??
                    (isPreparingSelectedHandoff
                      ? "Wait for the handoff turn to start"
                      : undefined)
                  }
                  isRunning={
                    selectedThread?.status === "running" ||
                    selectedThread?.status === "waiting_for_input"
                  }
                  isStopping={isStopping}
                  goal={
                    selectedWorkspace && activeCapabilities.supports_goals
                      ? {
                          goal: selectedThread?.goal ?? null,
                          provider: activeProvider,
                          onSetGoal: handleSetGoal,
                          onClearGoal: handleClearGoal,
                          onSetGoalStatus: handleSetGoalStatus,
                        }
                      : undefined
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
