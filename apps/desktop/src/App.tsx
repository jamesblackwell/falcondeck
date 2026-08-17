import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  buildOptimisticUserItem,
  buildHandoffPrompt,
  buildHandoffSeedPrompt,
  buildHandoffTranscript,
  buildProjectGroups,
  approvalPolicyForProvider,
  composerProviderFor,
  composerSelectionFor,
  countAwaitingResponseThreads,
  countActivityEntries,
  conversationItemsForSelection,
  deriveExtensionPanels,
  deriveThreadAttentionPresentation,
  deriveExtensionSidebarFilters,
  deriveThreadTags,
  THREAD_TAGS_ACTION_ID,
  THREAD_TAGS_EXTENSION_ID,
  draftKeyFor,
  filesToImageInputs,
  generateUserItemId,
  imageAttachmentSendBlockReason,
  operationalConditionDismissalKey,
  workspaceOperationalConditions,
  mergeThreadDetailPage,
  optimisticallySetThreadColor,
  removeConversationItem,
  mergeFailedComposerAttachments,
  mergeFailedComposerDraft,
  providerForThread,
  resolvePersistedMode,
  resolvePermissionMode,
  resolveServiceTier,
  selectedSkillsFromText,
  serviceTierForTurn,
  STANDARD_SERVICE_TIER,
  THREAD_DETAIL_OLDER_PAGE_LIMIT,
  THREAD_DETAIL_TAIL_LIMIT,
  upsertComposerDraft,
  upsertConversationItem,
  updateAttachmentPreparationCount,
  validateImageAttachmentBudget,
  withComposerProvider,
  withComposerSelection,
  workspaceAgentCapabilities,
  threadAgentCapabilities,
  workspaceCollaborationModes,
  workspaceModels,
  workspaceProviderLabel,
  workspaceProviderOptions,
  threadForSelection,
  type AgentProvider,
  type AttachmentPreparationCounts,
  type ComposerDrafts,
  type ConversationItem,
  type ExtensionPanelDefinition,
  type ExtensionUiActionBinding,
  type ImageInput,
  type PersistedComposerSelection,
  type PersistedComposerState,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type OperationalCondition,
  type ThreadHandle,
  type ThreadIsolation,
  type ThinkingDisplay,
  type ThreadSortMode,
  type ThreadSummary,
  type ThreadTag,
  type TurnInputItem,
  type UpdatePreferencesPayload,
} from "@falcondeck/client-core";
import {
  ComposerContextBar,
  ExtensionPanel,
  NewThreadState,
  ShipMenu,
  useShipThread,
  composePromptWithQuotedSelections,
  normalizeQuotedSelection,
  type ComposerMenuRequest,
  type QuotedSelection,
} from "@falcondeck/chat-ui";
import {
  ActivityDiamond,
  Button,
  DEFAULT_APPEARANCE,
  FONT_SCALE_OPTIONS,
  ToastProvider,
  getAppearance,
  updateAppearance,
  useToast,
} from "@falcondeck/ui";

import {
  markInteractiveRequestResolved,
  normalizeSendError,
  stoppedThreadsToOffer,
  workspaceComposerDisabled,
  workspaceSendBlockReason,
} from "./app-utils";
import { isTauriDesktop, openActivityWindow, openExternalUrl } from "./api";
import {
  ACTIVITY_WINDOW_EVENTS,
  ACTIVITY_WINDOW_LABEL,
  activityStateChanged,
  projectActivityWindowState,
  type ActivityRespondMessage,
  type ActivityStartTaskMessage,
  type ActivityThreadRef,
  type ActivityWindowState,
} from "./activity-window-bridge";
import {
  readPersistedComposerState,
  readStoredDrafts,
  transferComposerDraft,
  writePersistedComposerState,
  writeStoredDrafts,
} from "./composer-persistence";
import {
  preferencesWithThinkingDisplay,
  readStoredCollapsedWorkspaces,
  readStoredThinkingDisplay,
  readStoredThreadSort,
  splitPreferencesUpdate,
  writeStoredCollapsedWorkspaces,
  writeStoredThinkingDisplay,
  writeStoredThreadSort,
} from "./preferences";
import {
  defaultReasoningEffort,
  reasoningOptions,
  resolveReasoningEffort,
  resolveThreadModelId,
} from "./utils";
import { DesktopConversationPane } from "./components/DesktopConversationPane";
import { DesktopVoiceInput } from "./components/DesktopVoiceInput";
import { DesktopSidebar } from "./components/Sidebar";
import { DesktopShell } from "./components/DesktopShell";
import type { DiffPanelSelection } from "./components/DiffPanel";
import { PanelToggles } from "./components/PanelToggles";
import { ProjectImportOverlay } from "./components/ProjectImportOverlay";
import { ResumeStoppedThreadsDialog } from "./components/ResumeStoppedThreadsDialog";
import type { SettingsSectionId } from "./components/settings/settings-utils";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useDaemonConnection } from "./hooks/useDaemonConnection";
import { useGitBranches } from "./hooks/useGitBranches";
import { usePanelVisibility } from "./hooks/usePanelVisibility";
import { useRemoteHosts } from "./hooks/useRemoteHosts";
import {
  hostLabelByWorkspaceId,
  mergeSnapshots,
  type HostScopedApi,
} from "./hosts";
import {
  commandForEvent,
  getShortcutSettings,
  isEditableTarget,
  shortcutHint,
  shortcutHintTokens,
  useShortcutSettings,
} from "./shortcuts";
import { sendDesktopAttentionNotification } from "./desktop-notifications";
import { useDesktopDictation } from "./dictation";
import { resolveMainView } from "./main-view-registry";

// Stable empty array so conversations without attachments don't bust the
// memoized PromptInput on every render.
const NO_ATTACHMENTS: ImageInput[] = [];
const NO_QUOTED_SELECTIONS: QuotedSelection[] = [];

type DesktopExtensionPanel = ExtensionPanelDefinition & {
  ownerHostId: string | null;
};

function lastAgentItemId(items: ConversationItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item.kind !== "user_message") return item.id;
  }
  return null;
}

const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const ScheduledTasksView = lazy(() =>
  import("./components/ScheduledTasksView").then((module) => ({
    default: module.ScheduledTasksView,
  })),
);
const ActivityView = lazy(() =>
  import("@falcondeck/chat-ui/activity-view").then((module) => ({
    default: module.ActivityView,
  })),
);
const DiffPanel = lazy(() =>
  import("./components/DiffPanel").then((module) => ({
    default: module.DiffPanel,
  })),
);
const CommandPalette = lazy(() =>
  import("@falcondeck/chat-ui/command-palette").then((module) => ({
    default: module.CommandPalette,
  })),
);

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const { toast } = useToast();
  const remoteHosts = useRemoteHosts();
  const hostSnapshots = useMemo(
    () => remoteHosts.hosts.map((host) => host.snapshot),
    [remoteHosts.hosts],
  );
  const {
    api,
    baseUrl,
    connectionError,
    snapshot,
    setSnapshot,
    threadDetail,
    setThreadDetail,
    threadDetailError,
    retryThreadDetail,
    remoteStatus,
    setRemoteStatus,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedThreadId,
    setSelectedThreadId,
    gitRefreshTrigger,
  } = useDaemonConnection({ externalSnapshots: hostSnapshots });
  useDesktopDictation(baseUrl);
  const updater = useAppUpdater();
  const {
    sidebarVisible,
    railVisible,
    toggleSidebar,
    toggleRail,
    showRail,
    hideSidebar,
    hideRail,
  } = usePanelVisibility();
  const shortcutSettings = useShortcutSettings();
  // Bindings are customizable, so every hint surface (tooltips, palette rows)
  // renders from the live keymap rather than a hardcoded string.
  const paletteShortcutHints = useMemo(
    () => ({
      activity: shortcutHintTokens("openActivity", shortcutSettings),
      settings: shortcutHintTokens("openSettings", shortcutSettings),
      keyboardShortcuts: shortcutHintTokens(
        "openKeyboardShortcuts",
        shortcutSettings,
      ),
    }),
    [shortcutSettings],
  );
  const composerMenuShortcuts = useMemo(
    () => ({
      provider: shortcutHint("openHarnessMenu", shortcutSettings) ?? undefined,
      permissions:
        shortcutHint("openPermissionMenu", shortcutSettings) ?? undefined,
      sandbox: shortcutHint("openSandboxMenu", shortcutSettings) ?? undefined,
      model: shortcutHint("openModelMenu", shortcutSettings) ?? undefined,
    }),
    [shortcutSettings],
  );
  const [drafts, setDrafts] = useState<ComposerDrafts>(() =>
    readStoredDrafts(),
  );
  const [relayUrl] = useState(
    import.meta.env.VITE_FALCONDECK_RELAY_URL ??
      "https://connect.falcondeck.com",
  );
  const [attachmentsByConversation, setAttachmentsByConversation] = useState<
    Record<string, ImageInput[]>
  >({});
  const [attachmentPreparationCounts, setAttachmentPreparationCounts] =
    useState<AttachmentPreparationCounts>({});
  const [quotedSelectionsByConversation, setQuotedSelectionsByConversation] =
    useState<Record<string, QuotedSelection[]>>({});
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
  const [loadingOlderThreadKey, setLoadingOlderThreadKey] = useState<
    string | null
  >(null);
  // Only ever applies to the next thread this composer creates; a thread's
  // working directory cannot change after it exists.
  const [selectedIsolation, setSelectedIsolation] =
    useState<ThreadIsolation>("project_folder");
  const [persistedComposerSelections, setPersistedComposerSelections] =
    useState<PersistedComposerState>(() => readPersistedComposerState());
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [isImportingProjectSessions, setIsImportingProjectSessions] =
    useState(false);
  const [isStartingRemote, setIsStartingRemote] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isVoiceInputOpen, setIsVoiceInputOpen] = useState(false);
  // Launch-time "continue everything the quit stopped" prompt. Null means no
  // prompt; the ref makes the offer once per app launch.
  const [resumePromptThreads, setResumePromptThreads] = useState<
    ThreadSummary[] | null
  >(null);
  const [isContinuingStoppedThreads, setIsContinuingStoppedThreads] =
    useState(false);
  const resumePromptSettledRef = useRef(false);
  const [isScheduledOpen, setIsScheduledOpen] = useState(false);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [activeExtensionPanelKey, setActiveExtensionPanelKey] = useState<
    string | null
  >(null);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");
  const [settingsRequestKey, setSettingsRequestKey] = useState(0);
  const [paletteRequest, setPaletteRequest] = useState({
    key: 0,
    query: "",
    scope: "all" as "all" | "threads",
    mode: "toggle" as "open" | "toggle" | "close",
  });
  const [composerFocusRequestKey, setComposerFocusRequestKey] = useState(0);
  const [projectMenuRequestKey, setProjectMenuRequestKey] = useState(0);
  const [composerMenuRequest, setComposerMenuRequest] =
    useState<ComposerMenuRequest>({ key: 0, menu: "model" });
  const [findRequestKey, setFindRequestKey] = useState(0);
  const [diffSelection, setDiffSelection] = useState<DiffPanelSelection | null>(
    null,
  );
  const [isSending, setIsSending] = useState(false);
  const [handoffPendingProvider, setHandoffPendingProvider] =
    useState<AgentProvider | null>(null);
  // Once the destination exists, keep the otherwise-empty transcript visibly
  // busy while FalconDeck compacts the source conversation into its handoff.
  // Keying this to the destination avoids showing the indicator if the user
  // navigates back to another thread while summarization is still running.
  const [handoffPendingThreadKey, setHandoffPendingThreadKey] = useState<
    string | null
  >(null);
  // The first message in a new conversation has no daemon thread id yet, so
  // keep its optimistic transcript item keyed to the temporary composer
  // conversation until thread.start returns.
  const [pendingNewThreadItem, setPendingNewThreadItem] = useState<{
    conversationKey: string;
    item: ConversationItem;
  } | null>(null);
  // Isolated-thread creation clones the working tree before the first turn
  // can start; a bare "Sending…" over that window reads as a hang.
  const [isPreparingIsolation, setIsPreparingIsolation] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const handleSetThreadColor = useCallback(
    async (
      workspaceId: string,
      thread: ThreadSummary,
      color: ThreadTag | null,
    ) => {
      const host = remoteHosts.hostForWorkspace(workspaceId);
      const actionApi = host ? host.api() : api;
      if (!actionApi) {
        setActionError("The FalconDeck daemon is not connected");
        return;
      }
      try {
        setActionError(null);
        if (!host) {
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  extensions: optimisticallySetThreadColor(
                    current.extensions,
                    thread.id,
                    color?.color ?? null,
                  ),
                }
              : current,
          );
        }
        await actionApi.invokeExtensionAction(
          THREAD_TAGS_EXTENSION_ID,
          THREAD_TAGS_ACTION_ID,
          {
            target: { kind: "thread", id: thread.id },
            input: {
              operation: "set_thread_color",
              color: color?.color ?? null,
            },
          },
        );
      } catch (error) {
        if (host) {
          void host.refresh().catch(() => {});
        } else {
          void api
            ?.snapshot()
            .then(setSnapshot)
            .catch(() => {});
        }
        const message =
          error instanceof Error
            ? error.message
            : "Failed to set thread colour";
        setActionError(message);
        toast({
          title: "Couldn’t set thread colour",
          description: message,
          variant: "danger",
        });
      }
    },
    [api, remoteHosts, setSnapshot, toast],
  );

  const handleSetExtensionEnabled = useCallback(
    async (extensionId: string, enabled: boolean) => {
      if (!api) throw new Error("The FalconDeck daemon is not connected");
      const updated = await api.updateExtension(extensionId, enabled);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              extensions: {
                ...current.extensions,
                catalog: current.extensions.catalog.map((extension) =>
                  extension.id === updated.id ? updated : extension,
                ),
              },
            }
          : current,
      );
    },
    [api, setSnapshot],
  );
  const handleSetExtensionPermission = useCallback(
    async (extensionId: string, permission: string, granted: boolean) => {
      if (!api) throw new Error("The FalconDeck daemon is not connected");
      const updated = await api.updateExtensionPermission(
        extensionId,
        permission,
        granted,
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              extensions: {
                ...current.extensions,
                catalog: current.extensions.catalog.map((extension) =>
                  extension.id === updated.id ? updated : extension,
                ),
              },
            }
          : current,
      );
    },
    [api, setSnapshot],
  );
  const [windowFocused, setWindowFocused] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [dismissedConditionVersions, setDismissedConditionVersions] = useState<
    Set<string>
  >(() => new Set());
  const [thinkingDisplay, setThinkingDisplay] = useState<ThinkingDisplay>(
    readStoredThinkingDisplay,
  );
  const [threadSort, setThreadSort] =
    useState<ThreadSortMode>(readStoredThreadSort);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<string[]>(
    readStoredCollapsedWorkspaces,
  );
  const selectionSeedRef = useRef<string | null>(null);
  const threadSettingsRequestRef = useRef(0);
  const notifiedAttentionRef = useRef(new Map<string, string>());
  const pendingNotificationKeysRef = useRef(new Set<string>());
  const announcedProjectReadinessRef = useRef<string | null>(null);
  const announcedUpdateVersionRef = useRef<string | null>(null);
  const announcedDownloadedVersionRef = useRef<string | null>(null);
  const draftsRef = useRef(drafts);
  // Submitted text leaves the visible composer immediately, but remains
  // overlaid onto durable draft storage until the daemon accepts the turn.
  // This preserves crash recovery without making the controlled input linger.
  const pendingDraftBackupsRef = useRef(new Map<string, string>());
  const attachmentsByConversationRef = useRef(attachmentsByConversation);
  const attachmentPreparationCountsRef = useRef(attachmentPreparationCounts);
  const sendingConversationKeyRef = useRef<string | null>(null);
  const sendingBaselineAgentItemIdRef = useRef<string | null>(null);
  const selectionHistoryRef = useRef<
    Array<{ workspaceId: string | null; threadId: string | null }>
  >([]);
  const selectionHistoryIndexRef = useRef(-1);
  const navigatingHistoryRef = useRef(false);

  // Each conversation keeps its own unsent input, keyed by workspace + thread
  // ('new' for a thread not yet created), so navigating never carries text or
  // attachments across. Draft text is device-local persistent; attachments
  // follow their conversation for the session only.
  const conversationKey = draftKeyFor(selectedWorkspaceId, selectedThreadId);
  const conversationKeyRef = useRef(conversationKey);
  const draft = drafts[conversationKey]?.text ?? "";
  const attachments =
    attachmentsByConversation[conversationKey] ?? NO_ATTACHMENTS;
  const preparingAttachmentCount =
    attachmentPreparationCounts[conversationKey] ?? 0;
  const quotedSelections =
    quotedSelectionsByConversation[conversationKey] ?? NO_QUOTED_SELECTIONS;

  useLayoutEffect(() => {
    conversationKeyRef.current = conversationKey;
  }, [conversationKey]);

  useEffect(() => {
    if (navigatingHistoryRef.current) {
      navigatingHistoryRef.current = false;
      return;
    }
    const next = {
      workspaceId: selectedWorkspaceId,
      threadId: selectedThreadId,
    };
    const history = selectionHistoryRef.current;
    const current = history[selectionHistoryIndexRef.current];
    if (
      current?.workspaceId === next.workspaceId &&
      current.threadId === next.threadId
    )
      return;
    history.splice(selectionHistoryIndexRef.current + 1);
    history.push(next);
    if (history.length > 50) history.shift();
    selectionHistoryIndexRef.current = history.length - 1;
  }, [selectedThreadId, selectedWorkspaceId]);

  const writeRecoverableDrafts = useCallback((current: ComposerDrafts) => {
    let recoverable = current;
    for (const [key, submittedDraft] of pendingDraftBackupsRef.current) {
      recoverable = upsertComposerDraft(
        recoverable,
        key,
        mergeFailedComposerDraft(submittedDraft, recoverable[key]?.text ?? ""),
      );
    }
    writeStoredDrafts(recoverable);
  }, []);

  const setDraftForConversation = useCallback(
    (key: string, value: string) => {
      setDrafts((current) => {
        const next = upsertComposerDraft(current, key, value);
        draftsRef.current = next;
        if (next !== current) writeRecoverableDrafts(next);
        return next;
      });
    },
    [writeRecoverableDrafts],
  );

  useEffect(() => {
    const flushDrafts = () => writeRecoverableDrafts(draftsRef.current);
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flushDrafts();
    };
    window.addEventListener("pagehide", flushDrafts);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", flushDrafts);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [writeRecoverableDrafts]);

  const setDraft = useCallback(
    (value: string) => setDraftForConversation(conversationKey, value),
    [conversationKey, setDraftForConversation],
  );

  const addQuotedSelection = useCallback(
    (text: string) => {
      const normalized = normalizeQuotedSelection(text);
      if (!normalized.trim()) return;
      const selection: QuotedSelection = {
        id:
          typeof globalThis.crypto?.randomUUID === "function"
            ? globalThis.crypto.randomUUID()
            : `quote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: normalized,
      };
      setQuotedSelectionsByConversation((current) => ({
        ...current,
        [conversationKey]: [...(current[conversationKey] ?? []), selection],
      }));
      setComposerFocusRequestKey((key) => key + 1);
    },
    [conversationKey],
  );

  const removeQuotedSelection = useCallback(
    (selectionId: string) => {
      setQuotedSelectionsByConversation((current) => {
        const nextSelections = (current[conversationKey] ?? []).filter(
          (selection) => selection.id !== selectionId,
        );
        if (nextSelections.length === (current[conversationKey] ?? []).length)
          return current;
        const next = { ...current };
        if (nextSelections.length > 0) next[conversationKey] = nextSelections;
        else delete next[conversationKey];
        return next;
      });
    },
    [conversationKey],
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
        draftsRef.current = next;
        if (next !== current) writeRecoverableDrafts(next);
        return next;
      });
      setAttachmentsForConversation(key, (current) =>
        mergeFailedComposerAttachments(failedAttachments, current),
      );
    },
    [setAttachmentsForConversation, writeRecoverableDrafts],
  );

  // Local daemon snapshot merged with enrolled remote-host snapshots: the
  // sidebar, selection, and composer all see one world; writes route back to
  // the owning daemon via apiFor.
  const viewSnapshot = useMemo(
    () => mergeSnapshots(snapshot, remoteHosts.hosts),
    [remoteHosts.hosts, snapshot],
  );
  const threadTags = useMemo(
    () => deriveThreadTags(viewSnapshot?.extensions),
    [viewSnapshot?.extensions],
  );
  const extensionSidebarFilters = useMemo(
    () => deriveExtensionSidebarFilters(viewSnapshot?.extensions),
    [viewSnapshot?.extensions],
  );
  const extensionPanels = useMemo<DesktopExtensionPanel[]>(() => {
    const localPanels = deriveExtensionPanels(snapshot?.extensions).map(
      (panel) => ({
        ...panel,
        key: `extension:local:${panel.key}`,
        ownerHostId: null,
      }),
    );
    const remotePanels = remoteHosts.hosts.flatMap((host) =>
      deriveExtensionPanels(host.snapshot?.extensions).map((panel) => ({
        ...panel,
        key: `extension:${host.id}:${panel.key}`,
        title: `${panel.title} · ${host.name}`,
        ownerHostId: host.id,
      })),
    );
    return [...localPanels, ...remotePanels];
  }, [remoteHosts.hosts, snapshot?.extensions]);
  useEffect(() => {
    if (
      activeExtensionPanelKey &&
      !extensionPanels.some((panel) => panel.key === activeExtensionPanelKey)
    ) {
      setActiveExtensionPanelKey(null);
    }
  }, [activeExtensionPanelKey, extensionPanels]);
  useEffect(() => {
    if (
      activeExtensionPanelKey &&
      (isActivityOpen || isScheduledOpen || isSettingsOpen)
    ) {
      setActiveExtensionPanelKey(null);
    }
  }, [
    activeExtensionPanelKey,
    isActivityOpen,
    isScheduledOpen,
    isSettingsOpen,
  ]);
  const threadTagsEnabled =
    viewSnapshot?.extensions.catalog.some(
      (extension) =>
        extension.id === THREAD_TAGS_EXTENSION_ID && extension.enabled,
    ) ?? false;
  const workspaceHostIndex = useMemo(
    () => hostLabelByWorkspaceId(remoteHosts.hosts),
    [remoteHosts.hosts],
  );
  const workspaceHostBadges = useMemo(() => {
    const badges: Record<string, { name: string; connected: boolean }> = {};
    for (const [workspaceId, host] of workspaceHostIndex) {
      badges[workspaceId] = {
        name: host.name,
        connected:
          host.status === "encrypted" &&
          (host.presence?.daemon_connected ?? false),
      };
    }
    return badges;
  }, [workspaceHostIndex]);
  const canSetThreadColor = useCallback(
    (workspaceId: string) => {
      const hostSnapshot = workspaceHostIndex.get(workspaceId)?.snapshot;
      const extensions = hostSnapshot?.extensions ?? snapshot?.extensions;
      return (
        extensions?.catalog.some(
          (extension) =>
            extension.id === THREAD_TAGS_EXTENSION_ID && extension.enabled,
        ) ?? false
      );
    },
    [snapshot?.extensions, workspaceHostIndex],
  );
  const apiFor = useCallback(
    (workspaceId: string | null | undefined) => {
      const host = remoteHosts.hostForWorkspace(workspaceId);
      return host ? host.api() : api;
    },
    [api, remoteHosts],
  );
  const invokeExtensionPanelAction = useCallback(
    async (
      panel: DesktopExtensionPanel,
      extensionId: string,
      action: ExtensionUiActionBinding,
    ) => {
      const host = panel.ownerHostId
        ? remoteHosts.hosts.find(
            (candidate) => candidate.id === panel.ownerHostId,
          )
        : null;
      const actionApi = host
        ? (remoteHosts.manager.connection(host.id)?.api() ?? null)
        : api;
      if (!actionApi) throw new Error("The FalconDeck daemon is not connected");
      await actionApi.invokeExtensionAction(extensionId, action.actionId, {
        target: action.target,
        input: action.input ?? null,
      });
      if (!host && api) setSnapshot(await api.snapshot());
    },
    [api, remoteHosts.hosts, remoteHosts.manager, setSnapshot],
  );
  const selectedWorkspace = useMemo(
    () =>
      viewSnapshot?.workspaces.find((w) => w.id === selectedWorkspaceId) ??
      null,
    [selectedWorkspaceId, viewSnapshot?.workspaces],
  );
  // Enabled MCP servers usable by the selected local workspace's agents; feeds
  // the composer's tools chip. Re-fetched when settings close so panel edits
  // show up. Depends on scalar keys only — object/map identities churn per
  // render and would turn every keystroke into a connector fetch.
  const [connectorCount, setConnectorCount] = useState(0);
  const isRemoteWorkspaceSelected = workspaceHostIndex.has(
    selectedWorkspaceId ?? "",
  );

  // A file named in the transcript opens in the changes rail. There is no
  // per-item diff endpoint, so this shows the file's *current* working-tree
  // diff, which is the same view the rail's own file list gives.
  const handleOpenFileDiff = useCallback(
    (filePath: string) => {
      if (!selectedWorkspaceId) return;
      setDiffSelection({
        workspaceId: selectedWorkspaceId,
        filePath,
        view: "changes",
      });
      showRail();
    },
    [selectedWorkspaceId, showRail],
  );
  const workspaceProviderIds = (selectedWorkspace?.agents ?? [])
    .map((agent) => agent.provider)
    .sort()
    .join(",");
  useEffect(() => {
    if (!baseUrl || !selectedWorkspaceId || isRemoteWorkspaceSelected) {
      setConnectorCount(0);
      return;
    }
    if (isSettingsOpen) return;
    const workspaceProviders = new Set(
      workspaceProviderIds.split(",").filter(Boolean),
    );
    let cancelled = false;
    void fetch(
      `${baseUrl}/api/connectors?workspace_id=${encodeURIComponent(selectedWorkspaceId)}`,
    )
      .then(async (response) => (response.ok ? response.json() : null))
      .then(
        (
          overview: {
            merged?: Array<{ enabled?: boolean; providers?: string[] }>;
          } | null,
        ) => {
          if (cancelled) return;
          setConnectorCount(
            overview?.merged?.filter(
              (entry) =>
                entry.enabled !== false &&
                (!entry.providers?.length ||
                  entry.providers.some((provider) =>
                    workspaceProviders.has(provider),
                  )),
            ).length ?? 0,
          );
        },
      )
      .catch(() => {
        if (!cancelled) setConnectorCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [
    baseUrl,
    selectedWorkspaceId,
    isRemoteWorkspaceSelected,
    isSettingsOpen,
    workspaceProviderIds,
  ]);
  const selectedThread = useMemo(
    () =>
      threadForSelection(
        viewSnapshot?.threads ?? [],
        selectedWorkspaceId,
        selectedThreadId,
      ),
    [selectedThreadId, selectedWorkspaceId, viewSnapshot?.threads],
  );
  // Where the selected thread's work lands, for the review rail's overview
  // tab. Without a project there is nothing to describe, so the tab hides.
  const reviewInfo = useMemo(() => {
    if (!selectedWorkspace) return null;
    const host = workspaceHostBadges[selectedWorkspace.id] ?? null;
    return {
      workspacePath: selectedWorkspace.path,
      hostName: host?.name ?? null,
      hostConnected: host?.connected,
      thread: selectedThread,
    };
  }, [selectedThread, selectedWorkspace, workspaceHostBadges]);
  // Checkouts happen outside the daemon's event stream, so the app keeps its
  // own bump to refresh the changes rail after a branch switch.
  const [localGitBump, setLocalGitBump] = useState(0);
  const combinedGitRefreshTrigger = gitRefreshTrigger + localGitBump;
  // Branch state feeds the new-thread context bar only: threads pin their
  // checkout at creation, and remote hosts have no local repo to ask.
  const {
    branches,
    uncommittedCount,
    isCheckoutPending,
    checkout: checkoutBranch,
  } = useGitBranches(
    !selectedThread && !isRemoteWorkspaceSelected && !isSettingsOpen
      ? api
      : null,
    selectedWorkspaceId,
    combinedGitRefreshTrigger,
  );
  // Lands an isolated thread's branch from the session header. Only isolated
  // threads have a branch of their own, so the control hides itself otherwise.
  const {
    ship: shipThread,
    pending: isShipPending,
    projectFolderDirty,
  } = useShipThread({
    api: apiFor(selectedWorkspaceId),
    workspaceId: selectedWorkspaceId,
    thread: selectedThread,
    toast,
    openUrl: openExternalUrl,
    onShipped: () => setLocalGitBump((bump) => bump + 1),
  });
  const groups = useMemo(
    () =>
      buildProjectGroups(
        viewSnapshot?.workspaces ?? [],
        viewSnapshot?.threads ?? [],
        viewSnapshot?.preferences.workspace_order,
      ),
    [
      viewSnapshot?.preferences.workspace_order,
      viewSnapshot?.threads,
      viewSnapshot?.workspaces,
    ],
  );
  const activityCounts = useMemo(
    () =>
      countActivityEntries(groups, viewSnapshot?.interactive_requests ?? []),
    [groups, viewSnapshot?.interactive_requests],
  );
  const conversationItems: ConversationItem[] = useMemo(() => {
    const selectedItems = conversationItemsForSelection(
      selectedWorkspaceId,
      selectedThreadId,
      threadDetail,
    );
    if (
      selectedThreadId ||
      !pendingNewThreadItem ||
      pendingNewThreadItem.conversationKey !== conversationKey
    ) {
      return selectedItems;
    }
    return [pendingNewThreadItem.item];
  }, [
    conversationKey,
    pendingNewThreadItem,
    selectedThreadId,
    selectedWorkspaceId,
    threadDetail,
  ]);
  const interactiveRequests = useMemo(
    () =>
      selectedThreadId
        ? (viewSnapshot?.interactive_requests ?? []).filter(
            (request) =>
              request.workspace_id === selectedWorkspaceId &&
              request.thread_id === selectedThreadId,
          )
        : [],
    [selectedThreadId, selectedWorkspaceId, viewSnapshot?.interactive_requests],
  );
  const remoteWebUrl =
    import.meta.env.VITE_FALCONDECK_REMOTE_WEB_URL ??
    "https://app.falcondeck.com";
  const defaultRelayUrl = "https://connect.falcondeck.com";
  const remoteControlsUnavailableReason =
    connectionError ?? "FalconDeck is still connecting to the local daemon.";
  const remoteControlsDisabled = !api;
  const pairingLink =
    remoteStatus?.pairing && remoteStatus.relay_url
      ? (() => {
          const params = new URLSearchParams({
            code: remoteStatus.pairing.pairing_code,
          });
          if (remoteStatus.relay_url !== defaultRelayUrl) {
            params.set("relay", remoteStatus.relay_url);
          }
          return `${remoteWebUrl}?${params.toString()}`;
        })()
      : null;

  const rememberComposerSelection = useCallback(
    (provider: AgentProvider, patch: Partial<PersistedComposerSelection>) => {
      if (!selectedWorkspace) {
        return;
      }

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
      if (!selectedWorkspace) {
        return;
      }

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

  // Sync model/effort/mode selections from thread/workspace
  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedProvider("codex");
      setSelectedModel(null);
      setSelectedCollaborationMode(null);
      setSelectedEffort("medium");
      setSelectedServiceTier(null);
      setSelectedPermissionMode(null);
      setSelectedSandboxMode(null);
      setSelectedIsolation("project_folder");
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
    const preferredSelection = composerSelectionFor(
      persistedComposerSelections,
      selectedWorkspace.path,
      nextProvider,
    );
    const nextModelId = resolveThreadModelId(
      selectedThread,
      selectedWorkspace,
      preferredSelection?.modelId,
      nextProvider,
    );
    setSelectedProvider(nextProvider);
    setSelectedModel(nextModelId);
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
    setSelectedEffort(
      resolveReasoningEffort(
        selectedThread,
        selectedWorkspace,
        nextModelId,
        preferredSelection?.effort,
        nextProvider,
      ) ?? "medium",
    );
    // Threads keep the tier they last ran with; new conversations take the
    // remembered choice, falling back to the model catalog's default tier for
    // accounts where the provider turns fast on by default.
    const nextModel =
      workspaceModels(selectedWorkspace, nextProvider).find(
        (model) => model.id === nextModelId,
      ) ?? null;
    setSelectedServiceTier(
      selectedThread
        ? resolveServiceTier(selectedThread.agent.service_tier, nextModel)
        : resolveServiceTier(
            preferredSelection?.serviceTier ?? nextModel?.default_service_tier,
            nextModel,
          ),
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
  }, [persistedComposerSelections, selectedThread, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const provider = selectedThread?.provider ?? selectedProvider;
    const models = workspaceModels(selectedWorkspace, provider);
    if (models.length === 0) {
      if (selectedModel !== null) {
        setSelectedModel(null);
      }
      return;
    }
    if (!selectedModel || !models.some((model) => model.id === selectedModel)) {
      const preferredSelection = composerSelectionFor(
        persistedComposerSelections,
        selectedWorkspace.path,
        provider,
      );
      setSelectedModel(
        resolveThreadModelId(
          selectedThread,
          selectedWorkspace,
          preferredSelection?.modelId,
          provider,
        ),
      );
    }
  }, [
    persistedComposerSelections,
    selectedModel,
    selectedProvider,
    selectedThread,
    selectedWorkspace,
  ]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const provider = selectedThread?.provider ?? selectedProvider;
    const options = reasoningOptions(
      selectedThread,
      selectedWorkspace,
      selectedModel,
      provider,
    );
    if (options.length === 0) return;
    if (!selectedEffort || !options.includes(selectedEffort)) {
      const preferredSelection = composerSelectionFor(
        persistedComposerSelections,
        selectedWorkspace.path,
        provider,
      );
      setSelectedEffort(
        resolveReasoningEffort(
          selectedThread,
          selectedWorkspace,
          selectedModel,
          preferredSelection?.effort,
          provider,
        ),
      );
    }
  }, [
    persistedComposerSelections,
    selectedEffort,
    selectedModel,
    selectedProvider,
    selectedThread,
    selectedWorkspace,
  ]);

  // Load and keep fresh the thread detail for remote-host selections. Fetch
  // once per selection; on every host notification re-read the cache so
  // streaming updates applied by the host connection reach the open thread.
  const remoteDetailFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    const host = remoteHosts.hostForWorkspace(selectedWorkspaceId);
    if (!host || !selectedWorkspaceId || !selectedThreadId) {
      remoteDetailFetchedRef.current = null;
      return;
    }
    const key = `${selectedWorkspaceId}:${selectedThreadId}`;
    const cached = host.cachedThreadDetail(
      selectedWorkspaceId,
      selectedThreadId,
    );
    if (cached) {
      setThreadDetail((current) => (current === cached ? current : cached));
    }
    if (remoteDetailFetchedRef.current === key) return;
    remoteDetailFetchedRef.current = key;
    if (!cached) setThreadDetail(null);
    let cancelled = false;
    void host
      .threadDetail(selectedWorkspaceId, selectedThreadId, {
        mode: "tail",
        limit: THREAD_DETAIL_TAIL_LIMIT,
      })
      .then((detail) => {
        if (!cancelled) setThreadDetail(detail);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to load remote thread";
        setActionError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteHosts, selectedThreadId, selectedWorkspaceId, setThreadDetail]);

  const handleLoadOlder = useCallback(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !threadDetail?.has_older)
      return;
    if (
      threadDetail.workspace.id !== selectedWorkspaceId ||
      threadDetail.thread.id !== selectedThreadId ||
      !threadDetail.oldest_item_id
    ) {
      return;
    }
    const client = apiFor(selectedWorkspaceId);
    if (!client) return;
    const key = `${selectedWorkspaceId}:${selectedThreadId}`;
    if (loadingOlderThreadKey === key) return;
    const beforeItemId = threadDetail.oldest_item_id;

    setLoadingOlderThreadKey(key);
    void client
      .threadDetail(selectedWorkspaceId, selectedThreadId, {
        mode: "before",
        before_item_id: beforeItemId,
        limit: THREAD_DETAIL_OLDER_PAGE_LIMIT,
      })
      .then((page) => {
        setThreadDetail((current) => {
          if (
            !current ||
            current.workspace.id !== selectedWorkspaceId ||
            current.thread.id !== selectedThreadId ||
            current.oldest_item_id !== beforeItemId
          ) {
            return current;
          }
          return mergeThreadDetailPage(current, page, "prepend");
        });
        setActionError(null);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load earlier messages";
        setActionError(message);
      })
      .finally(() => {
        setLoadingOlderThreadKey((current) =>
          current === key ? null : current,
        );
      });
  }, [
    apiFor,
    loadingOlderThreadKey,
    selectedThreadId,
    selectedWorkspaceId,
    setActionError,
    setThreadDetail,
    threadDetail,
  ]);

  useEffect(() => {
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);
    const handleVisibility = () => {
      setWindowFocused(
        document.visibilityState !== "hidden" && document.hasFocus(),
      );
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // The daemon uses a short activity lease when deciding whether a remote
  // push would be redundant. Refresh it while this desktop window is the
  // active surface, and let it expire naturally when the app disappears.
  useEffect(() => {
    if (!api) return;

    const publishActivity = () => {
      const active =
        document.visibilityState !== "hidden" && document.hasFocus();
      void api.setClientActivity(active).catch(() => {});
    };

    publishActivity();
    const heartbeat = window.setInterval(publishActivity, 15_000);
    window.addEventListener("focus", publishActivity);
    window.addEventListener("blur", publishActivity);
    document.addEventListener("visibilitychange", publishActivity);

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", publishActivity);
      window.removeEventListener("blur", publishActivity);
      document.removeEventListener("visibilitychange", publishActivity);
      void api.setClientActivity(false).catch(() => {});
    };
  }, [api]);

  // Set by "Mark as unread" so this effect does not immediately undo it while
  // the thread is still the selected one. Cleared as soon as the selection
  // moves elsewhere or the agent adds activity the user has genuinely not seen.
  const suppressAutoReadRef = useRef<{
    threadId: string;
    activitySeq: number;
  } | null>(null);

  useEffect(() => {
    const client = apiFor(selectedWorkspaceId);
    if (!client || !selectedWorkspaceId || !selectedThread) return;
    if (!windowFocused) return;
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

    void client
      .markThreadRead({
        workspace_id: selectedWorkspaceId,
        thread_id: selectedThread.id,
        read_seq: readSeq,
      })
      .then((thread) => {
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
      })
      .catch(() => {});
  }, [apiFor, selectedThread, selectedWorkspaceId, setSnapshot, windowFocused]);

  useEffect(() => {
    const count = countAwaitingResponseThreads(viewSnapshot?.threads ?? []);
    document.title = count > 0 ? `(${count}) FalconDeck` : "FalconDeck";

    if (!window.__TAURI_INTERNALS__) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setBadgeCount(count || undefined),
      )
      .catch(() => {});
  }, [viewSnapshot?.threads]);

  useEffect(() => {
    if (!viewSnapshot?.threads?.length) return;

    for (const thread of viewSnapshot.threads) {
      const attention = deriveThreadAttentionPresentation(
        thread,
        viewSnapshot.interactive_requests,
      );
      const notificationEnabled =
        viewSnapshot.preferences.notifications.enabled &&
        (attention.level === "awaiting_response"
          ? viewSnapshot.preferences.notifications.notify_on_input_required
          : attention.level === "error"
            ? viewSnapshot.preferences.notifications.notify_on_error
            : attention.level === "unread"
              ? viewSnapshot.preferences.notifications.notify_on_turn_complete
              : false);
      if (
        attention.level === "none" ||
        !notificationEnabled ||
        (windowFocused && selectedThreadId === thread.id)
      ) {
        notifiedAttentionRef.current.delete(thread.id);
        continue;
      }

      const previous = notifiedAttentionRef.current.get(thread.id);
      if (previous === attention.level) continue;

      const body =
        attention.level === "awaiting_response"
          ? "The agent needs a response in this thread."
          : attention.level === "error"
            ? "The latest run ended with an error."
            : "The latest turn finished.";
      const notificationKey = `${thread.workspace_id}:${thread.id}:${attention.level}`;
      if (pendingNotificationKeysRef.current.has(notificationKey)) continue;
      pendingNotificationKeysRef.current.add(notificationKey);

      void sendDesktopAttentionNotification({
        title: thread.title || "FalconDeck thread",
        body,
      })
        .then((sent) => {
          if (sent) {
            notifiedAttentionRef.current.set(thread.id, attention.level);
          }
        })
        .finally(() => {
          pendingNotificationKeysRef.current.delete(notificationKey);
        });
    }
  }, [
    selectedThreadId,
    viewSnapshot?.interactive_requests,
    viewSnapshot?.preferences,
    viewSnapshot?.threads,
    windowFocused,
  ]);

  // Surface connection errors as toasts
  useEffect(() => {
    if (connectionError) {
      toast({
        variant: "danger",
        title: "Connection error",
        description: connectionError,
      });
    }
  }, [connectionError, toast]);

  useEffect(() => {
    if (updater.state.status !== "available" || !updater.state.availableVersion)
      return;
    if (announcedUpdateVersionRef.current === updater.state.availableVersion)
      return;
    announcedUpdateVersionRef.current = updater.state.availableVersion;
    toast({
      variant: "warning",
      title: "Update available",
      description: `FalconDeck ${updater.state.availableVersion} is ready to download from GitHub Releases.`,
    });
  }, [toast, updater.state.availableVersion, updater.state.status]);

  useEffect(() => {
    if (
      updater.state.status !== "downloaded" ||
      !updater.state.availableVersion
    )
      return;
    if (
      announcedDownloadedVersionRef.current === updater.state.availableVersion
    )
      return;
    announcedDownloadedVersionRef.current = updater.state.availableVersion;
    toast({
      variant: "success",
      title: "Update downloaded",
      description:
        "Restart FalconDeck when you are ready to install the new desktop build.",
    });
  }, [toast, updater.state.availableVersion, updater.state.status]);

  const applyThreadHandle = useCallback(
    (handle: ThreadHandle) => {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              workspaces: current.workspaces.map((w) =>
                w.id === handle.workspace.id ? handle.workspace : w,
              ),
              threads: current.threads.map((t) =>
                t.id === handle.thread.id ? handle.thread : t,
              ),
            }
          : current,
      );
      setThreadDetail((current) =>
        current && current.thread.id === handle.thread.id
          ? { ...current, workspace: handle.workspace, thread: handle.thread }
          : current,
      );
    },
    [setSnapshot, setThreadDetail],
  );

  const persistThreadSettings = useCallback(
    async ({
      modelId,
      effort,
      serviceTier,
    }: {
      modelId: string | null;
      effort: string | null;
      /** Omitted leaves the thread's tier alone (providers without tiers never send one). */
      serviceTier?: string | null;
    }) => {
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace || !selectedThreadId) return;
      const requestId = ++threadSettingsRequestRef.current;
      try {
        const handle = await client.updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          provider: selectedThread?.provider ?? selectedProvider,
          model_id: modelId,
          reasoning_effort: effort,
          ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
        });
        if (requestId !== threadSettingsRequestRef.current) return;
        applyThreadHandle(handle);
        setActionError(null);
      } catch (error) {
        if (requestId !== threadSettingsRequestRef.current) return;
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to update thread settings";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to update settings",
          description: msg,
        });
      }
    },
    [
      apiFor,
      applyThreadHandle,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      toast,
    ],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      const provider = selectedThread?.provider ?? selectedProvider;
      setSelectedModel(modelId);
      const nextOptions = reasoningOptions(
        selectedThread,
        selectedWorkspace,
        modelId,
        provider,
      );
      const nextEffort =
        selectedEffort && nextOptions.includes(selectedEffort)
          ? selectedEffort
          : defaultReasoningEffort(
              selectedThread,
              selectedWorkspace,
              modelId,
              provider,
            );
      setSelectedEffort(nextEffort);
      rememberComposerSelection(provider, { modelId, effort: nextEffort });
      void persistThreadSettings({ modelId, effort: nextEffort });
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedEffort,
      selectedProvider,
      selectedThread,
      selectedWorkspace,
    ],
  );

  const handleServiceTierChange = useCallback(
    (tier: string | null) => {
      const provider = selectedThread?.provider ?? selectedProvider;
      setSelectedServiceTier(tier);
      // Turning fast off is an explicit choice, distinct from never having
      // touched the toggle — only the latter follows the catalog default.
      rememberComposerSelection(provider, {
        serviceTier: tier ?? STANDARD_SERVICE_TIER,
      });
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace || !selectedThreadId) return;
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          service_tier: tier ?? STANDARD_SERVICE_TIER,
        })
        .then(applyThreadHandle)
        .catch((error: unknown) => {
          const msg =
            error instanceof Error ? error.message : "Failed to update speed";
          setActionError(msg);
        });
    },
    [
      apiFor,
      applyThreadHandle,
      rememberComposerSelection,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      setActionError,
    ],
  );

  const handleEffortChange = useCallback(
    (effort: string) => {
      const provider = selectedThread?.provider ?? selectedProvider;
      setSelectedEffort(effort);
      rememberComposerSelection(provider, { modelId: selectedModel, effort });
      void persistThreadSettings({ modelId: selectedModel, effort });
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedModel,
      selectedProvider,
      selectedThread,
    ],
  );

  const handleCollaborationModeChange = useCallback(
    (mode: string | null) => {
      setSelectedCollaborationMode(mode);
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace || !selectedThreadId) return;
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          collaboration_mode_id: mode,
        })
        .then(applyThreadHandle)
        .catch((error: unknown) => {
          const msg =
            error instanceof Error
              ? error.message
              : "Failed to update collaboration mode";
          setActionError(msg);
        });
    },
    [apiFor, applyThreadHandle, selectedThreadId, selectedWorkspace],
  );

  const handlePermissionModeChange = useCallback(
    (mode: string | null) => {
      setSelectedPermissionMode(mode);
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        // Keep an explicit "Ask to approve" choice distinct from an old
        // selection that has never been set; fresh sessions are safe by
        // default and never infer a permissive mode.
        permissionMode: mode ?? "default",
      });
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace || !selectedThreadId) return;
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          permission_mode: mode,
          approval_policy: approvalPolicyForProvider(
            selectedThread?.provider ?? selectedProvider,
            mode,
          ),
        })
        .then(applyThreadHandle)
        .catch((error: unknown) => {
          const msg =
            error instanceof Error
              ? error.message
              : "Failed to update permission mode";
          setActionError(msg);
        });
    },
    [
      apiFor,
      applyThreadHandle,
      rememberComposerSelection,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      setActionError,
    ],
  );

  const handleSandboxModeChange = useCallback(
    (mode: string | null) => {
      setSelectedSandboxMode(mode);
      rememberComposerSelection(selectedThread?.provider ?? selectedProvider, {
        sandboxMode: mode,
      });
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace || !selectedThreadId) return;
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          sandbox_mode: mode,
        })
        .then(applyThreadHandle)
        .catch((error: unknown) => {
          const msg =
            error instanceof Error
              ? error.message
              : "Failed to update sandbox mode";
          setActionError(msg);
        });
    },
    [
      apiFor,
      applyThreadHandle,
      rememberComposerSelection,
      selectedProvider,
      selectedThread,
      selectedThreadId,
      selectedWorkspace,
      setActionError,
    ],
  );

  const applyThreadSummary = useCallback(
    (thread: ThreadSummary) => {
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
    },
    [setSnapshot],
  );

  const handleSetGoal = useCallback(
    async (objective: string, tokenBudget: number | null) => {
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace) {
        throw new Error("Select a project first");
      }
      let activeThreadId = selectedThreadId;
      if (!activeThreadId) {
        if (selectedIsolation === "isolated") {
          setIsPreparingIsolation(true);
        }
        let handle: ThreadHandle;
        try {
          handle = await client.startThread({
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
            isolation: selectedIsolation,
          });
        } finally {
          setIsPreparingIsolation(false);
        }
        activeThreadId = handle.thread.id;
        const detail = {
          workspace: handle.workspace,
          thread: handle.thread,
          items: [],
          has_older: false,
          oldest_item_id: null,
          newest_item_id: null,
          is_partial: false,
        };
        remoteHosts
          .hostForWorkspace(selectedWorkspace.id)
          ?.seedThreadDetail(detail);
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
        setThreadDetail(detail);
        setSelectedThreadId(activeThreadId);
      }
      const thread = await client.setThreadGoal({
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        objective,
        token_budget: tokenBudget,
      });
      applyThreadSummary(thread);
    },
    [
      apiFor,
      applyThreadSummary,
      remoteHosts,
      selectedCollaborationMode,
      selectedIsolation,
      selectedModel,
      selectedPermissionMode,
      selectedProvider,
      selectedSandboxMode,
      selectedThreadId,
      selectedWorkspace,
      setSelectedThreadId,
      setSnapshot,
      setThreadDetail,
    ],
  );

  const handleClearGoal = useCallback(async () => {
    const client = apiFor(selectedWorkspace?.id);
    if (!client || !selectedWorkspace || !selectedThreadId) return;
    const thread = await client.clearThreadGoal(
      selectedWorkspace.id,
      selectedThreadId,
    );
    applyThreadSummary(thread);
  }, [apiFor, applyThreadSummary, selectedThreadId, selectedWorkspace]);

  const handleSetGoalStatus = useCallback(
    async (status: "active" | "paused") => {
      const client = apiFor(selectedWorkspace?.id);
      if (!client || !selectedWorkspace || !selectedThreadId) return;
      const thread = await client.setThreadGoal({
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        status,
      });
      applyThreadSummary(thread);
    },
    [apiFor, applyThreadSummary, selectedThreadId, selectedWorkspace],
  );

  const handleProviderChange = useCallback(
    (provider: AgentProvider) => {
      if (selectedThread) return;
      const preferredSelection = composerSelectionFor(
        persistedComposerSelections,
        selectedWorkspace?.path,
        provider,
      );
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
      const fallbackModelId = resolveThreadModelId(
        null,
        selectedWorkspace,
        preferredSelection?.modelId,
        provider,
      );
      setSelectedModel(fallbackModelId);
      setSelectedEffort(
        resolveReasoningEffort(
          null,
          selectedWorkspace,
          fallbackModelId,
          preferredSelection?.effort,
          provider,
        ) ?? "medium",
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
        workspaceModels(selectedWorkspace, provider).find(
          (model) => model.id === fallbackModelId,
        ) ?? null;
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
    ],
  );

  const handleHandoffProviderSelect = useCallback(
    async (provider: AgentProvider) => {
      if (
        !selectedWorkspace ||
        !selectedThread ||
        provider === selectedThread.provider ||
        handoffPendingProvider
      ) {
        return;
      }
      const client = apiFor(selectedWorkspace.id);
      if (!client) return;

      let createdHandoff: ThreadHandle | null = null;
      let handoffPrompt: string | null = null;
      let targetLabel = provider;
      const showHandoffThread = (handle: ThreadHandle) => {
        const destinationKey = draftKeyFor(
          handle.workspace.id,
          handle.thread.id,
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
                  ...current.threads.filter(
                    (thread) => thread.id !== handle.thread.id,
                  ),
                ],
              }
            : current,
        );
        conversationKeyRef.current = destinationKey;
        setHandoffPendingThreadKey(destinationKey);
        setSelectedWorkspaceId(handle.workspace.id);
        setSelectedThreadId(handle.thread.id);
        setThreadDetail({
          workspace: handle.workspace,
          thread: handle.thread,
          items: [],
          has_older: false,
          oldest_item_id: null,
          newest_item_id: null,
          is_partial: false,
        });
      };

      setHandoffPendingProvider(provider);
      try {
        // Read the complete source before creating anything, so failed source
        // hydration cannot leave a destination thread behind.
        const sourceDetail = await client.threadDetail(
          selectedWorkspace.id,
          selectedThread.id,
          { mode: "full" },
        );
        targetLabel = workspaceProviderLabel(selectedWorkspace, provider);
        const sourceLabel = workspaceProviderLabel(
          selectedWorkspace,
          selectedThread.provider,
        );
        const preferred = composerSelectionFor(
          persistedComposerSelections,
          selectedWorkspace.path,
          provider,
        );
        const targetCapabilities = workspaceAgentCapabilities(
          selectedWorkspace,
          provider,
        );
        const modelId = resolveThreadModelId(
          null,
          selectedWorkspace,
          preferred?.modelId,
          provider,
        );
        const permissionMode = resolvePermissionMode(
          preferred?.permissionMode,
          targetCapabilities.permission_modes,
        );
        const sandboxMode = resolvePersistedMode(
          preferred?.sandboxMode,
          targetCapabilities.sandbox_modes,
        );
        const transcript = buildHandoffTranscript({
          items: sourceDetail.items,
          sourceTitle: selectedThread.title,
        });
        const started = await client.startThread({
          workspace_id: selectedWorkspace.id,
          provider,
          model_id: modelId,
          permission_mode: permissionMode,
          approval_policy: approvalPolicyForProvider(provider, permissionMode),
          sandbox_mode: sandboxMode,
          isolation: "project_folder",
          handoff_from: {
            thread_id: selectedThread.id,
            provider: selectedThread.provider,
          },
        });
        createdHandoff = started;
        const titled = await client.updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: started.thread.id,
          title: `${selectedThread.title} · ${targetLabel}`,
        });
        createdHandoff = titled;
        showHandoffThread(titled);

        // Compaction runs out of band on a cheap utility model, so the
        // destination spends neither its first turn nor its context window
        // re-reading a transcript that may not even fit. If no utility
        // provider is available the destination compacts it itself, which is
        // the old behaviour and still correct — just more expensive.
        let summarizedBy: string | null = null;
        try {
          const summary = await client.handoffBrief({
            workspace_id: selectedWorkspace.id,
            thread_id: selectedThread.id,
            transcript,
            source_provider_label: sourceLabel,
          });
          handoffPrompt = buildHandoffSeedPrompt({
            brief: summary.brief,
            sourceProvider: selectedThread.provider,
            sourceProviderLabel: sourceLabel,
            truncated: summary.truncated ?? false,
          });
          summarizedBy = summary.model_id
            ? `${summary.provider} · ${summary.model_id}`
            : summary.provider;
        } catch {
          handoffPrompt = buildHandoffPrompt({
            items: sourceDetail.items,
            sourceTitle: selectedThread.title,
            sourceProvider: selectedThread.provider,
            sourceProviderLabel: sourceLabel,
          });
        }

        await client.sendTurn({
          workspace_id: titled.workspace.id,
          thread_id: titled.thread.id,
          provider,
          model_id: modelId,
          permission_mode: permissionMode,
          approval_policy: approvalPolicyForProvider(provider, permissionMode),
          sandbox_mode: sandboxMode,
          inputs: [
            {
              type: "text",
              text: handoffPrompt,
            },
          ],
        });
        setActionError(null);
        toast({
          variant: "success",
          title: `Continuing with ${targetLabel}`,
          description: summarizedBy
            ? `Handoff summarized in the background by ${summarizedBy}. The original is unchanged.`
            : "No background summarizer was available, so the linked thread is compacting the transcript itself. The original is unchanged.",
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Failed to create handoff";
        setActionError(message);
        if (createdHandoff) {
          showHandoffThread(createdHandoff);
          const recoveredDetail = await client
            .threadDetail(
              createdHandoff.workspace.id,
              createdHandoff.thread.id,
              { mode: "full" },
            )
            .catch(() => null);
          const summaryStarted = Boolean(
            recoveredDetail &&
            (recoveredDetail.items.length > 0 ||
              recoveredDetail.thread.status === "running" ||
              recoveredDetail.thread.status === "waiting_for_input"),
          );
          if (recoveredDetail) setThreadDetail(recoveredDetail);
          if (!summaryStarted && handoffPrompt) {
            setDraftForConversation(
              draftKeyFor(
                createdHandoff.workspace.id,
                createdHandoff.thread.id,
              ),
              handoffPrompt,
            );
          }
          toast({
            variant: "warning",
            title: `Linked ${targetLabel} thread created`,
            description: summaryStarted
              ? "FalconDeck lost confirmation after starting the summary. Check the linked thread before retrying."
              : "The summary did not start. Its handoff prompt is ready in the composer to resend.",
          });
          return;
        }
        toast({
          variant: "danger",
          title: "Failed to create handoff",
          description: message,
        });
      } finally {
        setHandoffPendingProvider(null);
        setHandoffPendingThreadKey(null);
      }
    },
    [
      apiFor,
      handoffPendingProvider,
      persistedComposerSelections,
      selectedThread,
      selectedWorkspace,
      setActionError,
      setDraftForConversation,
      setSelectedThreadId,
      setSelectedWorkspaceId,
      setSnapshot,
      setThreadDetail,
      toast,
    ],
  );

  const handleAddProject = useCallback(async () => {
    if (!api) return;
    setIsAddingProject(true);
    try {
      let path: string | null = null;
      if (window.__TAURI_INTERNALS__) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title: "Add Project",
        });
        if (typeof selected === "string") path = selected.trim();
      }
      if (!path) {
        setIsAddingProject(false);
        return;
      }
      setIsImportingProjectSessions(true);
      const workspace = await api.connectWorkspace(path);
      const nextSnapshot = await api.snapshot();
      setSnapshot(nextSnapshot);
      setSelectedWorkspaceId(workspace.id);
      setSelectedThreadId(null);
      setThreadDetail(null);
      setActionError(null);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to add project";
      setActionError(msg);
      toast({
        variant: "danger",
        title: "Failed to add project",
        description: msg,
      });
    } finally {
      setIsImportingProjectSessions(false);
      setIsAddingProject(false);
    }
  }, [
    api,
    setSnapshot,
    setSelectedThreadId,
    setSelectedWorkspaceId,
    setThreadDetail,
    toast,
  ]);

  const handleAddRemoteProject = useCallback(
    async (hostId: string, path: string) => {
      const connection = remoteHosts.manager.connection(hostId);
      const host = remoteHosts.hosts.find((entry) => entry.id === hostId);
      if (!connection) {
        throw new Error(
          host ? `${host.name} is not connected` : "Server is not connected",
        );
      }
      setIsAddingProject(true);
      setIsImportingProjectSessions(true);
      try {
        const workspace = await connection.api().connectWorkspace(path);
        setSelectedWorkspaceId(workspace.id);
        setSelectedThreadId(null);
        setThreadDetail(null);
        setActionError(null);
        toast({
          variant: "success",
          title: "Project added",
          description: host ? `${path} on ${host.name}` : path,
        });
      } catch (error) {
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to add remote project";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to add remote project",
          description: msg,
        });
        throw error instanceof Error ? error : new Error(msg);
      } finally {
        setIsImportingProjectSessions(false);
        setIsAddingProject(false);
      }
    },
    [
      remoteHosts.hosts,
      remoteHosts.manager,
      setActionError,
      setSelectedThreadId,
      setSelectedWorkspaceId,
      setThreadDetail,
      toast,
    ],
  );

  const composerRemoteHosts = useMemo(
    () =>
      remoteHosts.hosts
        .filter((host) => host.enabled)
        .map((host) => ({
          id: host.id,
          name: host.name,
          connected:
            host.status === "encrypted" &&
            (host.presence?.daemon_connected ?? false),
        })),
    [remoteHosts.hosts],
  );

  const handleRemoveWorkspace = useCallback(
    async (workspaceId: string) => {
      const client = apiFor(workspaceId);
      if (!client) return;
      await client.removeWorkspace(workspaceId);
      if (!workspaceHostIndex.has(workspaceId) && api) {
        const nextSnapshot = await api.snapshot();
        setSnapshot(nextSnapshot);
      }
      if (selectedWorkspaceId === workspaceId) {
        setSelectedWorkspaceId(null);
        setSelectedThreadId(null);
        setThreadDetail(null);
      }
      setActionError(null);
    },
    [
      api,
      apiFor,
      selectedWorkspaceId,
      setActionError,
      setSelectedThreadId,
      setSelectedWorkspaceId,
      setSnapshot,
      setThreadDetail,
      workspaceHostIndex,
    ],
  );

  async function handleStop() {
    const client = apiFor(selectedWorkspace?.id);
    if (!client || !selectedWorkspace || !selectedThreadId) return;
    if (
      selectedThread?.status !== "running" &&
      selectedThread?.status !== "waiting_for_input"
    )
      return;
    setIsStopping(true);
    try {
      await client.interruptTurn(selectedWorkspace.id, selectedThreadId);
      setActionError(null);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to stop turn";
      setActionError(msg);
      toast({ variant: "danger", title: "Failed to stop", description: msg });
    } finally {
      setIsStopping(false);
    }
  }

  function removeOptimisticItem(
    workspaceId: string,
    threadId: string,
    itemId: string,
  ) {
    // Remote threads re-sync App state from the host's detail cache on every
    // notification, so the cache copy has to go too or the item resurrects.
    remoteHosts
      .hostForWorkspace(workspaceId)
      ?.removeLocalItem(workspaceId, threadId, itemId);
    setThreadDetail((current) => {
      if (!current || current.thread.id !== threadId) return current;
      const items = removeConversationItem(current.items, itemId);
      if (items === current.items) return current;
      return {
        ...current,
        items,
        oldest_item_id: items[0]?.id ?? null,
        newest_item_id: items.at(-1)?.id ?? null,
      };
    });
  }

  async function handleSubmit(
    steer = false,
    override?: { text: string; preserveComposer: boolean },
  ) {
    if ((attachmentPreparationCountsRef.current[conversationKey] ?? 0) > 0) {
      setActionError("Wait for image preparation to finish before sending.");
      return;
    }
    const submittedSelections = override ? [] : quotedSelections;
    const submittedUserDraft = override?.text ?? draft;
    const submittedDraft = composePromptWithQuotedSelections(
      submittedUserDraft,
      submittedSelections,
    );
    const client = apiFor(selectedWorkspace?.id);
    if (
      !client ||
      !selectedWorkspace ||
      (!submittedDraft.trim() && (override ? 0 : attachments.length) === 0)
    )
      return;
    const submittedAttachments = override ? NO_ATTACHMENTS : attachments;
    const submittedSkills = selectedSkillsFromText(
      submittedUserDraft,
      selectedWorkspace.skills ?? [],
    );
    const activeProvider = selectedThread?.provider ?? selectedProvider;
    const imageBlockReason = imageAttachmentSendBlockReason(
      workspaceAgentCapabilities(selectedWorkspace, activeProvider),
      submittedAttachments.length,
    );
    const blockReason =
      workspaceSendBlockReason(selectedWorkspace, activeProvider) ??
      imageBlockReason;
    if (blockReason) {
      setActionError(blockReason);
      toast({
        variant: "danger",
        title:
          imageBlockReason && blockReason === imageBlockReason
            ? "Image attachments unavailable"
            : "Project not ready",
        description: blockReason,
      });
      return;
    }
    const submittedKey = conversationKey;
    // Fresh per attempt: a retried send must not reuse an id the daemon may
    // already have committed a user item under.
    const userItemId = generateUserItemId();
    const inputs: TurnInputItem[] = [
      ...(submittedDraft.trim()
        ? [{ type: "text", text: submittedDraft } satisfies TurnInputItem]
        : []),
      ...submittedAttachments,
    ];
    // A send aimed at a busy thread lands in the queue chip instead, so it
    // skips the transcript. New and idle threads can show their user item
    // before the network round-trip that starts the turn.
    const expectQueued =
      !steer &&
      (selectedThread?.status === "running" ||
        selectedThread?.status === "waiting_for_input");
    const optimisticItem = expectQueued
      ? null
      : buildOptimisticUserItem(userItemId, inputs, new Date().toISOString());
    if (!selectedThreadId && optimisticItem) {
      setPendingNewThreadItem({
        conversationKey: submittedKey,
        item: optimisticItem,
      });
    }
    // The transcript receives the optimistic user item immediately, so clear
    // the matching composer in the same interaction. Keeping the controlled
    // input populated until sendTurn resolves makes a successful send look
    // duplicated and leaves the composer feeling stuck on slower links. The
    // captured submission below remains available for catch to restore.
    if (!override?.preserveComposer) {
      pendingDraftBackupsRef.current.set(submittedKey, submittedUserDraft);
      setDraftForConversation(submittedKey, "");
      setAttachmentsForConversation(submittedKey, () => []);
      setQuotedSelectionsByConversation((current) => {
        if (!(submittedKey in current)) return current;
        const next = { ...current };
        delete next[submittedKey];
        return next;
      });
    }
    sendingConversationKeyRef.current = submittedKey;
    sendingBaselineAgentItemIdRef.current = lastAgentItemId(conversationItems);
    setIsSending(true);
    let activeThreadId = selectedThreadId;
    try {
      if (!activeThreadId) {
        if (selectedIsolation === "isolated") {
          setIsPreparingIsolation(true);
        }
        const handle = await client.startThread({
          workspace_id: selectedWorkspace.id,
          provider: activeProvider,
          model_id: selectedModel,
          collaboration_mode_id: selectedCollaborationMode,
          approval_policy: approvalPolicyForProvider(
            activeProvider,
            selectedPermissionMode,
          ),
          permission_mode: selectedPermissionMode,
          sandbox_mode: selectedSandboxMode,
          isolation: selectedIsolation,
        });
        setIsPreparingIsolation(false);
        activeThreadId = handle.thread.id;
        const startedConversationKey = draftKeyFor(
          selectedWorkspace.id,
          activeThreadId,
        );
        if (!override?.preserveComposer) {
          const pendingBackup =
            pendingDraftBackupsRef.current.get(submittedKey);
          if (pendingBackup !== undefined) {
            pendingDraftBackupsRef.current.delete(submittedKey);
            pendingDraftBackupsRef.current.set(
              startedConversationKey,
              pendingBackup,
            );
          }
          // Anything authored after pressing Send belongs to the newly-created
          // thread. Move that newer input from the temporary new-thread key;
          // the submitted text is already represented by the optimistic item.
          setDraftForConversation(
            startedConversationKey,
            draftsRef.current[submittedKey]?.text ?? "",
          );
          setAttachmentsForConversation(
            startedConversationKey,
            () => attachmentsByConversationRef.current[submittedKey] ?? [],
          );
          setDraftForConversation(submittedKey, "");
          setAttachmentsForConversation(submittedKey, () => []);
          setQuotedSelectionsByConversation((current) => {
            const nextSelections = current[submittedKey] ?? [];
            if (!(submittedKey in current) && nextSelections.length === 0)
              return current;
            const next = { ...current };
            if (nextSelections.length > 0) {
              next[startedConversationKey] = nextSelections;
            }
            delete next[submittedKey];
            return next;
          });
        }
        const adopted = conversationKeyRef.current === submittedKey;
        if (adopted) {
          conversationKeyRef.current = startedConversationKey;
          sendingConversationKeyRef.current = startedConversationKey;
          sendingBaselineAgentItemIdRef.current = null;
          setSelectedThreadId(activeThreadId);
        }
        setSnapshot((c) =>
          c
            ? {
                ...c,
                workspaces: c.workspaces.map((workspace) =>
                  workspace.id === handle.workspace.id
                    ? handle.workspace
                    : workspace,
                ),
                threads: [
                  handle.thread,
                  ...c.threads.filter((t) => t.id !== handle.thread.id),
                ],
              }
            : c,
        );
        if (adopted) {
          // The new thread is known to be empty. Seed the optimistic item so
          // changing from the temporary composer key to the real thread key
          // does not create a visible gap before the detail endpoint catches
          // up.
          const seededDetail = {
            workspace: handle.workspace,
            thread: handle.thread,
            items: optimisticItem ? [optimisticItem] : [],
            has_older: false,
            oldest_item_id: optimisticItem?.id ?? null,
            newest_item_id: optimisticItem?.id ?? null,
            is_partial: false,
          };
          // Remote threads render from the host's detail cache; without a
          // seed the detail effect nulls the transcript while it fetches.
          remoteHosts
            .hostForWorkspace(selectedWorkspace.id)
            ?.seedThreadDetail(seededDetail);
          setThreadDetail(seededDetail);
          setPendingNewThreadItem(null);
        }
      }
      // Show the message in the transcript now; the daemon echoes it back
      // under the same id, so the echo replaces this copy in place.
      if (optimisticItem) {
        const targetThreadId = activeThreadId;
        remoteHosts
          .hostForWorkspace(selectedWorkspace.id)
          ?.upsertLocalItem(
            selectedWorkspace.id,
            targetThreadId,
            optimisticItem,
          );
        setThreadDetail((current) => {
          if (!current || current.thread.id !== targetThreadId) return current;
          const items = upsertConversationItem(current.items, optimisticItem);
          return {
            ...current,
            items,
            oldest_item_id: items[0]?.id ?? current.oldest_item_id,
            newest_item_id: items.at(-1)?.id ?? current.newest_item_id,
          };
        });
      }
      // Tier-capable models get their tier stated on every turn — "fast off"
      // must reach the provider as an explicit standard-tier request, because
      // an omitted field means "keep the session's current tier".
      const activeModels = workspaceModels(selectedWorkspace, activeProvider);
      const activeModel =
        activeModels.find((model) => model.id === selectedModel) ??
        activeModels.find((model) => model.is_default) ??
        null;
      const sendResponse = await client.sendTurn({
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs,
        selected_skills: submittedSkills,
        provider: activeProvider,
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        approval_policy: approvalPolicyForProvider(
          activeProvider,
          selectedPermissionMode,
        ),
        service_tier: serviceTierForTurn(selectedServiceTier, activeModel),
        permission_mode: selectedPermissionMode,
        sandbox_mode: selectedSandboxMode,
        steer,
        user_item_id: userItemId,
      });
      // The thread turned busy between our status check and the daemon's:
      // the send landed in the queue chip, so the transcript copy comes out.
      if (optimisticItem && sendResponse?.message === "queued") {
        removeOptimisticItem(selectedWorkspace.id, activeThreadId, userItemId);
      }
      if (!override?.preserveComposer) {
        pendingDraftBackupsRef.current.delete(
          draftKeyFor(selectedWorkspace.id, activeThreadId),
        );
        writeRecoverableDrafts(draftsRef.current);
      }
      setPendingNewThreadItem((current) =>
        current?.conversationKey === submittedKey ? null : current,
      );
      setActionError(null);
    } catch (error) {
      // Put the unsent input back where the user now is: the thread that was
      // created before the send failed, or the conversation they sent from.
      const restoreKey = activeThreadId
        ? draftKeyFor(selectedWorkspace.id, activeThreadId)
        : submittedKey;
      // The message never reached the daemon; a transcript entry for it would
      // be a lie. The text goes back into the composer instead.
      if (activeThreadId) {
        removeOptimisticItem(selectedWorkspace.id, activeThreadId, userItemId);
      }
      setPendingNewThreadItem((current) =>
        current?.conversationKey === submittedKey ? null : current,
      );
      if (!override?.preserveComposer) {
        pendingDraftBackupsRef.current.delete(restoreKey);
        if (restoreKey !== submittedKey) {
          setDraftForConversation(submittedKey, "");
          setAttachmentsForConversation(submittedKey, () => []);
          setQuotedSelectionsByConversation((current) => {
            if (!(submittedKey in current)) return current;
            const next = { ...current };
            delete next[submittedKey];
            return next;
          });
        }
        restoreFailedSubmission(
          restoreKey,
          submittedUserDraft,
          submittedAttachments,
        );
        if (submittedSelections.length > 0) {
          setQuotedSelectionsByConversation((current) => {
            const existing = current[restoreKey] ?? [];
            const existingIds = new Set(
              existing.map((selection) => selection.id),
            );
            return {
              ...current,
              [restoreKey]: [
                ...submittedSelections.filter(
                  (selection) => !existingIds.has(selection.id),
                ),
                ...existing,
              ],
            };
          });
        }
      }
      const rawMessage =
        error instanceof Error ? error.message : "Failed to send turn";
      const msg = normalizeSendError(rawMessage, activeProvider);
      setActionError(msg);
      toast({
        variant: "danger",
        title: "Failed to send message",
        description: msg,
      });
      sendingConversationKeyRef.current = null;
      setIsSending(false);
      setIsPreparingIsolation(false);
    }
  }

  async function handleStartRemotePairing() {
    if (!api) {
      setActionError(remoteControlsUnavailableReason);
      toast({
        variant: "danger",
        title: "FalconDeck is not ready yet",
        description: remoteControlsUnavailableReason,
      });
      return;
    }
    setIsStartingRemote(true);
    try {
      const nextStatus = await api.startRemotePairing(relayUrl);
      setRemoteStatus(nextStatus);
      setActionError(null);
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : "Failed to start remote pairing";
      setActionError(msg);
      toast({
        variant: "danger",
        title: "Failed to start pairing",
        description: msg,
      });
    } finally {
      setIsStartingRemote(false);
    }
  }

  async function handleInteractiveResponse(
    workspaceId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ) {
    const client = apiFor(workspaceId);
    if (!client) return;
    const isRemoteWorkspace = workspaceHostIndex.has(workspaceId);
    try {
      await client.respondInteractive(workspaceId, requestId, response);
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
      // Remote host snapshots refresh through their event streams; only the
      // local daemon needs the explicit refetch.
      if (!isRemoteWorkspace && api) {
        const nextSnapshot = await api.snapshot();
        setSnapshot(nextSnapshot);
      }
      setActionError(null);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to respond to request";
      setActionError(msg);
      toast({
        variant: "danger",
        title: "Failed to respond",
        description: msg,
      });
      // Rethrown so the request card can show the failure where the user
      // clicked, instead of only in a toast that scrolls away.
      throw error instanceof Error ? error : new Error(msg);
    }
  }

  // Stable callbacks for child components
  const handleSelectWorkspace = useCallback(
    (workspaceId: string, threadId: string | null) => {
      setIsSettingsOpen(false);
      setIsScheduledOpen(false);
      setIsActivityOpen(false);
      setActiveExtensionPanelKey(null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(threadId);
      setComposerFocusRequestKey((current) => current + 1);
    },
    [setSelectedWorkspaceId, setSelectedThreadId],
  );

  const handleSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      setIsSettingsOpen(false);
      setIsScheduledOpen(false);
      setIsActivityOpen(false);
      setActiveExtensionPanelKey(null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(threadId);
      setComposerFocusRequestKey((current) => current + 1);
    },
    [setSelectedWorkspaceId, setSelectedThreadId],
  );

  const handleNewThread = useCallback(
    (workspaceId: string) => {
      setIsSettingsOpen(false);
      setIsScheduledOpen(false);
      setIsActivityOpen(false);
      setActiveExtensionPanelKey(null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(null);
      setComposerFocusRequestKey((current) => current + 1);
      // Clear the detail at the same time as the selection. The connection
      // hook also reconciles this during layout, but the new-thread surface
      // must never briefly inherit the previous thread's transcript while
      // React is committing the selection change.
      setThreadDetail(null);
    },
    [setSelectedWorkspaceId, setSelectedThreadId, setThreadDetail],
  );

  const handleNewThreadProjectChange = useCallback(
    (workspaceId: string) => {
      const sourceKey = draftKeyFor(selectedWorkspaceId, null);
      const targetKey = draftKeyFor(workspaceId, null);
      if (sourceKey !== targetKey) {
        setDrafts((current) => {
          const next = transferComposerDraft(current, sourceKey, targetKey);
          if (next === current) return current;
          draftsRef.current = next;
          writeRecoverableDrafts(next);
          return next;
        });
      }
      handleNewThread(workspaceId);
    },
    [handleNewThread, selectedWorkspaceId, writeRecoverableDrafts],
  );

  const handleCheckoutBranch = useCallback(
    async (branch: string, create: boolean) => {
      try {
        await checkoutBranch(branch, create);
        // The changes rail reads the working tree, which a checkout just swapped.
        setLocalGitBump((current) => current + 1);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        toast({
          variant: "danger",
          title: "Branch switch failed",
          description: msg,
        });
      }
    },
    [checkoutBranch, toast],
  );

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

  const handleInteractiveResponseCallback = useCallback(
    (request: InteractiveRequest, response: InteractiveResponsePayload) =>
      handleInteractiveResponse(
        request.workspace_id,
        request.request_id,
        response,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, apiFor, workspaceHostIndex],
  );

  const handleStopCallback = useCallback(() => {
    void handleStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    apiFor,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    setActionError,
    toast,
  ]);

  const handleSubmitCallback = useCallback(() => {
    const isBusy =
      selectedThread?.status === "running" ||
      selectedThread?.status === "waiting_for_input";
    const shouldSteer =
      isBusy && getShortcutSettings().followUpBehavior === "steer";
    void handleSubmit(shouldSteer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    apiFor,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    selectedProvider,
    draft,
    attachments,
    quotedSelections,
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    selectedPermissionMode,
    selectedSandboxMode,
    selectedIsolation,
  ]);

  const handleContinueInterruptedTurn = useCallback(() => {
    // Retire the interruption as part of continuing. Without this the thread
    // keeps its stopped marker in persisted state, and the next reconnect
    // restores it as stopped even though the turn is running again.
    const client = apiFor(selectedWorkspace?.id);
    if (client && selectedWorkspace && selectedThreadId) {
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          acknowledge_interruption: true,
        })
        .then(applyThreadHandle)
        .catch(() => {});
    }
    void handleSubmit(false, { text: "Continue", preserveComposer: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    apiFor,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    selectedProvider,
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    selectedPermissionMode,
    selectedSandboxMode,
    selectedIsolation,
  ]);

  const handleDismissInterruptedTurn = useCallback(() => {
    if (!selectedWorkspace || !selectedThreadId) return;
    const client = apiFor(selectedWorkspace.id);
    if (!client) return;
    void client
      .updateThread({
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        acknowledge_interruption: true,
      })
      .then((handle) => {
        applyThreadHandle(handle);
        setActionError(null);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to dismiss stopped turn";
        setActionError(message);
        toast({
          variant: "danger",
          title: "Failed to dismiss stopped turn",
          description: message,
        });
      });
  }, [
    apiFor,
    applyThreadHandle,
    selectedThreadId,
    selectedWorkspace,
    setActionError,
    toast,
  ]);

  // Threads whose turn died with the app, offered as one batch at launch.
  // Read from the merged snapshot so remote hosts are covered too; null
  // while the daemon is still hydrating and the answer would be premature.
  const stoppedThreadOffer = useMemo(
    () =>
      snapshot
        ? stoppedThreadsToOffer({
            threads: viewSnapshot?.threads,
            workspaces: viewSnapshot?.workspaces,
            remoteHosts: remoteHosts.hosts.map((host) => ({
              hasSnapshot: host.snapshot !== null,
              isConnected: host.status === "encrypted",
            })),
          })
        : null,
    [
      remoteHosts.hosts,
      snapshot,
      viewSnapshot?.threads,
      viewSnapshot?.workspaces,
    ],
  );
  // The prompt is a snapshot taken once per launch: it must not grow or
  // reshuffle while the user is reading it, and it must not come back after
  // "Not now".
  useEffect(() => {
    if (resumePromptSettledRef.current) return;
    if (!stoppedThreadOffer) return;
    resumePromptSettledRef.current = true;
    if (stoppedThreadOffer.length === 0) return;
    setResumePromptThreads(stoppedThreadOffer);
  }, [stoppedThreadOffer]);

  const handleContinueStoppedThreads = useCallback(async () => {
    const targets = resumePromptThreads ?? [];
    if (targets.length === 0) {
      setResumePromptThreads(null);
      return;
    }
    setIsContinuingStoppedThreads(true);
    const failures: string[] = [];
    // Sequential: a burst of parallel turns would have every agent CLI cold
    // starting at once on the machine the user just opened.
    for (const thread of targets) {
      const client = apiFor(thread.workspace_id);
      if (!client) {
        failures.push(thread.title);
        continue;
      }
      try {
        // Clear the interruption before sending. The daemon persists that
        // acknowledgement, so a later reconnect cannot restore the thread
        // from state that still calls the last turn interrupted.
        await client
          .updateThread({
            workspace_id: thread.workspace_id,
            thread_id: thread.id,
            acknowledge_interruption: true,
          })
          .catch(() => {});
        await client.sendTurn({
          workspace_id: thread.workspace_id,
          thread_id: thread.id,
          inputs: [{ type: "text", text: "Continue" }],
          // The thread's own settings, not the composer's current selection.
          provider: thread.provider,
          model_id: thread.agent.model_id,
          reasoning_effort: thread.agent.reasoning_effort,
          approval_policy: thread.agent.approval_policy,
          service_tier: thread.agent.service_tier,
          permission_mode: thread.agent.permission_mode ?? null,
          sandbox_mode: thread.agent.sandbox_mode ?? null,
        });
      } catch {
        failures.push(thread.title);
      }
    }
    setIsContinuingStoppedThreads(false);
    setResumePromptThreads(null);
    if (api) {
      try {
        setSnapshot(await api.snapshot());
      } catch {
        // The event stream refreshes the snapshot on its own.
      }
    }
    const continued = targets.length - failures.length;
    if (failures.length > 0) {
      toast({
        variant: "danger",
        title:
          continued > 0
            ? `Continued ${continued} of ${targets.length} sessions`
            : "Failed to continue stopped sessions",
        description: failures.join(", "),
      });
      return;
    }
    toast({
      variant: "success",
      title:
        continued === 1
          ? "Continued 1 stopped session"
          : `Continued ${continued} stopped sessions`,
    });
  }, [api, apiFor, resumePromptThreads, setSnapshot, toast]);

  const handleDismissStoppedThreadsPrompt = useCallback(() => {
    setResumePromptThreads(null);
  }, []);

  const handleAlternateSubmitCallback = useCallback(() => {
    const settings = getShortcutSettings();
    const isBusy =
      selectedThread?.status === "running" ||
      selectedThread?.status === "waiting_for_input";
    const shouldSteer = isBusy && settings.followUpBehavior !== "steer";
    void handleSubmit(shouldSteer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    apiFor,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    selectedProvider,
    draft,
    attachments,
    quotedSelections,
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    selectedPermissionMode,
    selectedSandboxMode,
    selectedIsolation,
  ]);

  const handlePickImages = useCallback(
    (files: FileList | readonly File[] | null) => {
      const selectedCount = files?.length ?? 0;
      if (selectedCount === 0) return;
      const provider = selectedThread?.provider ?? selectedProvider;
      if (
        !workspaceAgentCapabilities(selectedWorkspace, provider).supports_images
      ) {
        setActionError(
          "The selected agent does not support image attachments.",
        );
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
          setAttachmentsForConversation(key, (current) => {
            const combined = [...current, ...next];
            validateImageAttachmentBudget(combined);
            return combined;
          });
        })
        .catch((error: unknown) => {
          setActionError(
            error instanceof Error
              ? error.message
              : "Could not attach that image",
          );
        })
        .finally(() => updateAttachmentPreparation(key, -selectedCount));
    },
    [
      conversationKey,
      selectedProvider,
      selectedThread?.provider,
      selectedWorkspace,
      setAttachmentsForConversation,
      updateAttachmentPreparation,
    ],
  );

  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      setAttachmentsForConversation(conversationKey, (current) =>
        current.filter((attachment) => attachment.id !== attachmentId),
      );
    },
    [conversationKey, setAttachmentsForConversation],
  );

  const handleStartPairingCallback = useCallback(() => {
    void handleStartRemotePairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, relayUrl]);

  const handleRefreshRemoteStatus = useCallback(() => {
    if (!api) {
      setActionError(remoteControlsUnavailableReason);
      toast({
        variant: "danger",
        title: "FalconDeck is not ready yet",
        description: remoteControlsUnavailableReason,
      });
      return;
    }

    void api
      .remoteStatus()
      .then((nextStatus) => {
        setRemoteStatus(nextStatus);
        setActionError(null);
      })
      .catch((error) => {
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to refresh remote status";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to refresh remote status",
          description: msg,
        });
      });
  }, [api, remoteControlsUnavailableReason, setRemoteStatus, toast]);

  const handleUpdatePreferences = useCallback(
    async (payload: UpdatePreferencesPayload) => {
      const { daemonPayload, thinkingDisplay: nextThinkingDisplay } =
        splitPreferencesUpdate(payload);
      if (nextThinkingDisplay) {
        setThinkingDisplay(nextThinkingDisplay);
        writeStoredThinkingDisplay(nextThinkingDisplay);
      }
      if (!daemonPayload) return;
      if (!api) return;
      try {
        const preferences = await api.updatePreferences(daemonPayload);
        setSnapshot((current) =>
          current ? { ...current, preferences } : current,
        );
        setActionError(null);
      } catch (error) {
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to update preferences";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to save preferences",
          description: msg,
        });
      }
    },
    [api, setSnapshot, toast],
  );

  const handleWorkspaceOrderChange = useCallback(
    async (workspaceIds: string[]) => {
      if (!api)
        throw new Error("FalconDeck is still connecting to the local daemon.");
      try {
        const preferences = await api.updatePreferences({
          workspace_order: workspaceIds,
        });
        setSnapshot((current) =>
          current ? { ...current, preferences } : current,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to save project order";
        toast({
          variant: "danger",
          title: "Failed to save project order",
          description: message,
        });
        throw error;
      }
    },
    [api, setSnapshot, toast],
  );

  const handleOpenSettings = useCallback(() => {
    setSettingsSection("general");
    setSettingsRequestKey((current) => current + 1);
    setIsSettingsOpen(true);
    setIsScheduledOpen(false);
    setIsActivityOpen(false);
    setActiveExtensionPanelKey(null);
  }, []);

  const handleOpenKeyboardShortcuts = useCallback(() => {
    setSettingsSection("keyboard");
    setSettingsRequestKey((current) => current + 1);
    setIsSettingsOpen(true);
    setIsScheduledOpen(false);
    setIsActivityOpen(false);
    setActiveExtensionPanelKey(null);
  }, []);

  const handleOpenScheduled = useCallback(() => {
    setIsSettingsOpen(false);
    setIsScheduledOpen(true);
    setIsActivityOpen(false);
    setActiveExtensionPanelKey(null);
  }, []);

  const handleOpenActivity = useCallback(() => {
    setIsSettingsOpen(false);
    setIsScheduledOpen(false);
    setIsActivityOpen(true);
    setActiveExtensionPanelKey(null);
  }, []);

  // Detaching gives Activity its own screen, so the takeover steps aside and
  // the main window goes back to the thread it was on.
  const handlePopOutActivity = useCallback(() => {
    setIsActivityOpen(false);
    void openActivityWindow().catch((error) => {
      setIsActivityOpen(true);
      toast({
        title: "Couldn’t open the Activity window",
        description:
          error instanceof Error ? error.message : "Unknown window error",
        variant: "danger",
      });
    });
  }, [toast]);

  // Same entry point as the keyboard binding, so the sidebar's search button
  // toggles the palette rather than stacking opens.
  const handleOpenCommandPalette = useCallback(() => {
    setPaletteRequest((current) => ({
      key: current.key + 1,
      query: "",
      scope: "all",
      mode: "toggle",
    }));
  }, []);

  const handleOpenExtensionPanel = useCallback((panelKey: string) => {
    setIsSettingsOpen(false);
    setIsScheduledOpen(false);
    setIsActivityOpen(false);
    setActiveExtensionPanelKey(panelKey);
  }, []);

  const handleCheckForUpdates = useCallback(() => {
    void updater.checkForUpdates({ manual: true }).then((result) => {
      if (result.kind === "upToDate") {
        toast({
          variant: "success",
          title: "FalconDeck is up to date",
          description:
            "No newer stable desktop release is available right now.",
        });
      } else if (result.kind === "unsupported") {
        toast({
          variant: "default",
          title: "Updater unavailable",
          description: result.message,
        });
      } else if (result.kind === "error") {
        toast({
          variant: "danger",
          title: "Update check failed",
          description: result.message,
        });
      }
    });
  }, [toast, updater]);

  const handleDownloadUpdate = useCallback(() => {
    void updater.downloadAndInstall().catch((error: unknown) => {
      const msg =
        error instanceof Error
          ? error.message
          : "Failed to download the update";
      toast({
        variant: "danger",
        title: "Update download failed",
        description: msg,
      });
    });
  }, [toast, updater]);

  const handleRestartToInstallUpdate = useCallback(() => {
    void updater.restartToInstall().catch((error: unknown) => {
      const msg =
        error instanceof Error ? error.message : "Failed to restart FalconDeck";
      toast({ variant: "danger", title: "Restart failed", description: msg });
    });
  }, [toast, updater]);

  const handleRevokeDevice = useCallback(
    (device: { device_id: string; label: string | null }) => {
      if (!api) return;
      const confirmed = window.confirm(
        `Remove ${device.label ?? "this device"} from trusted devices? It will need a new pairing code to reconnect.`,
      );
      if (!confirmed) return;

      setRevokingDeviceId(device.device_id);
      void api
        .revokeRemoteDevice(device.device_id)
        .then((nextStatus) => {
          setRemoteStatus(nextStatus);
          setActionError(null);
          toast({
            variant: "success",
            title: "Device removed",
            description: `${device.label ?? "Device"} can no longer access this session.`,
          });
        })
        .catch((error: unknown) => {
          const msg =
            error instanceof Error ? error.message : "Failed to remove device";
          setActionError(msg);
          toast({
            variant: "danger",
            title: "Failed to remove device",
            description: msg,
          });
        })
        .finally(() => {
          setRevokingDeviceId(null);
        });
    },
    [api, toast, setRemoteStatus],
  );

  const handleRemoveQueuedTurn = useCallback(
    async (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return;
      const client = apiFor(selectedWorkspaceId);
      if (!client) return;
      try {
        await client.removeQueuedTurn(
          selectedWorkspaceId,
          selectedThreadId,
          queuedId,
        );
        if (!workspaceHostIndex.has(selectedWorkspaceId) && api) {
          setSnapshot(await api.snapshot());
        }
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to remove queued message";
        toast({
          variant: "danger",
          title: "Failed to remove queued message",
          description: msg,
        });
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      selectedWorkspaceId,
      setSnapshot,
      toast,
      workspaceHostIndex,
    ],
  );

  const handleSteerQueuedTurn = useCallback(
    async (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return;
      const client = apiFor(selectedWorkspaceId);
      if (!client) return;
      try {
        await client.steerQueuedTurn(
          selectedWorkspaceId,
          selectedThreadId,
          queuedId,
        );
        if (!workspaceHostIndex.has(selectedWorkspaceId) && api) {
          setSnapshot(await api.snapshot());
        }
      } catch (error: unknown) {
        // The daemon keeps the message queued when a steer fails, so the chip
        // the user acted on is still there when they read this.
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to steer queued message";
        toast({
          variant: "danger",
          title: "Failed to steer queued message",
          description: msg,
        });
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      selectedWorkspaceId,
      setSnapshot,
      toast,
      workspaceHostIndex,
    ],
  );

  const handleEditQueuedTurn = useCallback(
    async (queuedId: string, text: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return;
      const client = apiFor(selectedWorkspaceId);
      if (!client) return;
      try {
        await client.editQueuedTurn(
          selectedWorkspaceId,
          selectedThreadId,
          queuedId,
          text,
        );
        if (!workspaceHostIndex.has(selectedWorkspaceId) && api) {
          setSnapshot(await api.snapshot());
        }
      } catch (error: unknown) {
        // A failed edit leaves the original message queued, so nothing is lost.
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to edit queued message";
        toast({
          variant: "danger",
          title: "Failed to edit queued message",
          description: msg,
        });
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      selectedWorkspaceId,
      setSnapshot,
      toast,
      workspaceHostIndex,
    ],
  );

  const handleReorderQueuedTurns = useCallback(
    async (queuedIds: string[]) => {
      if (!selectedWorkspaceId || !selectedThreadId) return;
      const client = apiFor(selectedWorkspaceId);
      if (!client) return;
      try {
        await client.reorderQueuedTurns(
          selectedWorkspaceId,
          selectedThreadId,
          queuedIds,
        );
        if (!workspaceHostIndex.has(selectedWorkspaceId) && api) {
          setSnapshot(await api.snapshot());
        }
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to reorder queued messages";
        toast({
          variant: "danger",
          title: "Failed to reorder queued messages",
          description: msg,
        });
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      selectedWorkspaceId,
      setSnapshot,
      toast,
      workspaceHostIndex,
    ],
  );

  const handleArchiveThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId);
      if (!client) throw new Error("FalconDeck is still connecting");
      try {
        await client.archiveThread(workspaceId, threadId);
        if (selectedThreadId === threadId) {
          setSelectedThreadId(null);
        }
        if (!workspaceHostIndex.has(workspaceId) && api) {
          const nextSnapshot = await api.snapshot();
          setSnapshot(nextSnapshot);
        }
        setActionError(null);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : "Failed to archive thread";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to archive thread",
          description: msg,
        });
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      setActionError,
      setSelectedThreadId,
      setSnapshot,
      toast,
      workspaceHostIndex,
    ],
  );

  const handleDeleteThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId);
      if (!client) throw new Error("FalconDeck is still connecting");
      try {
        await client.deleteThread(workspaceId, threadId);
        if (selectedThreadId === threadId) {
          setSelectedThreadId(null);
          setThreadDetail(null);
        }
        if (!workspaceHostIndex.has(workspaceId) && api) {
          setSnapshot(await api.snapshot());
        }
        setActionError(null);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : "Failed to delete thread";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to delete thread",
          description: msg,
        });
        // Rethrown so the dialog keeps itself open and shows the reason.
        throw error instanceof Error ? error : new Error(msg);
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      setActionError,
      setSelectedThreadId,
      setSnapshot,
      setThreadDetail,
      toast,
      workspaceHostIndex,
    ],
  );

  const handleRenameThread = useCallback(
    async (workspaceId: string, threadId: string, title: string) => {
      const client = apiFor(workspaceId);
      if (!client) throw new Error("FalconDeck is still connecting");
      try {
        const handle = await client.updateThread({
          workspace_id: workspaceId,
          thread_id: threadId,
          title,
        });
        applyThreadHandle(handle);
        setActionError(null);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : "Failed to rename thread";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to rename thread",
          description: msg,
        });
        throw error instanceof Error ? error : new Error(msg);
      }
    },
    [apiFor, applyThreadHandle, setActionError, toast],
  );

  const branchFromMessage = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      if (!selectedWorkspace || !selectedThread) return;
      const client = apiFor(selectedWorkspace.id);
      if (!client) return;
      const sourceConversationKey = draftKeyFor(
        selectedWorkspace.id,
        selectedThread.id,
      );
      const handle = item.previous_turn_id
        ? await client.forkThread({
            workspace_id: selectedWorkspace.id,
            thread_id: selectedThread.id,
            last_turn_id: item.previous_turn_id,
          })
        : await client.startThread({
            workspace_id: selectedWorkspace.id,
            provider: selectedThread.provider,
            model_id: selectedThread.agent.model_id,
            approval_policy: selectedThread.agent.approval_policy,
            permission_mode: selectedThread.agent.permission_mode,
            sandbox_mode: selectedThread.agent.sandbox_mode,
            isolation: "project_folder",
          });
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
        setSelectedWorkspaceId(handle.workspace.id);
        setSelectedThreadId(handle.thread.id);
        setThreadDetail({
          workspace: handle.workspace,
          thread: handle.thread,
          items: [],
          has_older: false,
          oldest_item_id: null,
          newest_item_id: null,
          is_partial: false,
        });
      }
      return { adopted, client, handle };
    },
    [
      apiFor,
      selectedThread,
      selectedWorkspace,
      setSelectedThreadId,
      setSelectedWorkspaceId,
      setSnapshot,
      setThreadDetail,
    ],
  );

  const handleRetryResponse = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      if (!selectedWorkspace || !selectedThread) return;
      let branch: Awaited<ReturnType<typeof branchFromMessage>>;
      try {
        branch = await branchFromMessage(item);
        if (!branch) return;
        const key = draftKeyFor(
          branch.handle.workspace.id,
          branch.handle.thread.id,
        );
        if (branch.adopted) {
          sendingConversationKeyRef.current = key;
          sendingBaselineAgentItemIdRef.current = null;
          setIsSending(true);
        }
        await branch.client.sendTurn({
          workspace_id: branch.handle.workspace.id,
          thread_id: branch.handle.thread.id,
          inputs: [
            ...(item.text.trim()
              ? [{ type: "text", text: item.text } satisfies TurnInputItem]
              : []),
            ...item.attachments,
          ],
          selected_skills: selectedSkillsFromText(
            item.text,
            selectedWorkspace.skills ?? [],
          ),
          provider: selectedThread.provider,
          model_id: selectedThread.agent.model_id,
          reasoning_effort: selectedThread.agent.reasoning_effort,
          approval_policy: selectedThread.agent.approval_policy,
          service_tier: selectedThread.agent.service_tier,
          permission_mode: selectedThread.agent.permission_mode,
          sandbox_mode: selectedThread.agent.sandbox_mode,
        });
        setActionError(null);
        toast({
          variant: "success",
          title: "Trying again",
          description: "The original thread is unchanged.",
        });
      } catch (error: unknown) {
        if (branch) {
          const key = draftKeyFor(
            branch.handle.workspace.id,
            branch.handle.thread.id,
          );
          setDraftForConversation(key, item.text);
          setAttachmentsForConversation(key, () => item.attachments);
        }
        const branchKey = branch
          ? draftKeyFor(branch.handle.workspace.id, branch.handle.thread.id)
          : null;
        if (branchKey && sendingConversationKeyRef.current === branchKey) {
          sendingConversationKeyRef.current = null;
          setIsSending(false);
        }
        const message =
          error instanceof Error ? error.message : "Failed to retry response";
        setActionError(message);
        toast({
          variant: "danger",
          title: "Failed to try again",
          description: message,
        });
        throw error instanceof Error
          ? error
          : new Error("Failed to retry response");
      }
    },
    [
      branchFromMessage,
      selectedThread,
      selectedWorkspace,
      setAttachmentsForConversation,
      setDraftForConversation,
      toast,
    ],
  );

  const handleTogglePinThread = useCallback(
    async (workspaceId: string, threadId: string, pinned: boolean) => {
      const client = apiFor(workspaceId);
      if (!client) throw new Error("FalconDeck is still connecting");
      try {
        const handle = await client.updateThread({
          workspace_id: workspaceId,
          thread_id: threadId,
          pinned,
        });
        applyThreadHandle(handle);
        setActionError(null);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : "Failed to update pin";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to update pin",
          description: msg,
        });
      }
    },
    [apiFor, applyThreadHandle, setActionError, toast],
  );

  const handleMarkThreadRead = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId);
      if (!client) return;
      const thread = viewSnapshot?.threads.find(
        (entry) => entry.workspace_id === workspaceId && entry.id === threadId,
      );
      const readSeq = thread?.attention.last_agent_activity_seq ?? 0;
      try {
        const updated = await client.markThreadRead({
          workspace_id: workspaceId,
          thread_id: threadId,
          read_seq: readSeq,
        });
        setSnapshot((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((entry) =>
                  entry.id === updated.id ? updated : entry,
                ),
              }
            : current,
        );
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to mark thread as read";
        setActionError(msg);
      }
    },
    [apiFor, setActionError, setSnapshot, viewSnapshot?.threads],
  );

  /* ================================================================
     Detached Activity window.

     It renders Activity on another screen but holds no client of its
     own, so this window answers for it: push the projection whenever
     it changes, and perform the actions it asks for. Nothing here runs
     until the window announces itself.
     ================================================================ */
  const [activityWindowOpen, setActivityWindowOpen] = useState(false);
  const [activityClockMs, setActivityClockMs] = useState(() => Date.now());
  const lastActivityStateRef = useRef<ActivityWindowState | null>(null);

  // The recently-finished trail ages out, so the projection needs a clock —
  // but a coarse one, or every tick would re-push an identical queue.
  useEffect(() => {
    if (!activityWindowOpen) return;
    const timer = window.setInterval(
      () => setActivityClockMs(Date.now()),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [activityWindowOpen]);

  const activityWindowState = useMemo(
    () =>
      projectActivityWindowState(
        groups,
        viewSnapshot?.interactive_requests ?? [],
        workspaceHostBadges,
        Boolean(selectedWorkspaceId),
        activityClockMs,
        selectedWorkspaceId,
      ),
    [
      activityClockMs,
      groups,
      selectedWorkspaceId,
      viewSnapshot?.interactive_requests,
      workspaceHostBadges,
    ],
  );

  const handleActivityStartTask = useCallback(
    async ({
      workspaceId,
      prompt,
    }: Omit<ActivityStartTaskMessage, "callId">) => {
      const workspace = groups.find(
        (group) => group.workspace.id === workspaceId,
      )?.workspace;
      const client = apiFor(workspaceId);
      if (!workspace || !client)
        throw new Error("That project is unavailable.");
      const blockReason = workspaceSendBlockReason(
        workspace,
        providerForThread(null, workspace),
      );
      if (blockReason) throw new Error(blockReason);

      const stickyProvider = composerProviderFor(
        persistedComposerSelections,
        workspace.path,
      );
      const provider =
        stickyProvider &&
        workspaceProviderOptions(workspace).some(
          (option) => option.provider === stickyProvider,
        )
          ? stickyProvider
          : providerForThread(null, workspace);
      const preferred = composerSelectionFor(
        persistedComposerSelections,
        workspace.path,
        provider,
      );
      const modelId = resolveThreadModelId(
        null,
        workspace,
        preferred?.modelId,
        provider,
      );
      const capabilities = workspaceAgentCapabilities(workspace, provider);
      const permissionMode = resolvePermissionMode(
        preferred?.permissionMode,
        capabilities.permission_modes,
      );
      const sandboxMode = resolvePersistedMode(
        preferred?.sandboxMode,
        capabilities.sandbox_modes,
      );
      const collaborationModes = workspaceCollaborationModes(
        workspace,
        provider,
      );
      const collaborationModeId =
        collaborationModes.find((mode) => mode.mode === "default")?.id ??
        collaborationModes[0]?.id ??
        null;
      const effort =
        resolveReasoningEffort(
          null,
          workspace,
          modelId,
          preferred?.effort,
          provider,
        ) ?? "medium";
      const model =
        workspaceModels(workspace, provider).find(
          (entry) => entry.id === modelId,
        ) ?? null;
      const serviceTier = resolveServiceTier(
        preferred?.serviceTier ?? model?.default_service_tier,
        model,
      );

      const handle = await client.startThread({
        workspace_id: workspaceId,
        provider,
        model_id: modelId,
        collaboration_mode_id: collaborationModeId,
        approval_policy: approvalPolicyForProvider(provider, permissionMode),
        permission_mode: permissionMode,
        sandbox_mode: sandboxMode,
        isolation: "project_folder",
      });
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
      await client.sendTurn({
        workspace_id: workspaceId,
        thread_id: handle.thread.id,
        inputs: [{ type: "text", text: prompt.trim() }],
        selected_skills: selectedSkillsFromText(prompt, workspace.skills ?? []),
        provider,
        model_id: modelId,
        reasoning_effort: effort,
        approval_policy: approvalPolicyForProvider(provider, permissionMode),
        service_tier: serviceTierForTurn(serviceTier, model),
        permission_mode: permissionMode,
        sandbox_mode: sandboxMode,
        steer: false,
        user_item_id: generateUserItemId(),
      });
    },
    [apiFor, groups, persistedComposerSelections, setSnapshot],
  );

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (pending: Promise<() => void>) => {
      void pending.then((off) => {
        if (disposed) off();
        else unlisteners.push(off);
      });
    };

    void import("@tauri-apps/api/event").then(({ emit, listen }) => {
      if (disposed) return;

      track(
        listen(ACTIVITY_WINDOW_EVENTS.ready, () => {
          // A reload leaves the window with no state and us none the wiser,
          // so treat every announcement as "send everything again".
          lastActivityStateRef.current = null;
          setActivityWindowOpen(true);
        }),
      );
      track(
        listen(ACTIVITY_WINDOW_EVENTS.closed, () =>
          setActivityWindowOpen(false),
        ),
      );
      track(
        listen<ActivityThreadRef>(ACTIVITY_WINDOW_EVENTS.openThread, (event) =>
          handleSelectThread(event.payload.workspaceId, event.payload.threadId),
        ),
      );
      track(
        listen<ActivityThreadRef>(ACTIVITY_WINDOW_EVENTS.markRead, (event) => {
          void handleMarkThreadRead(
            event.payload.workspaceId,
            event.payload.threadId,
          );
        }),
      );
      track(
        listen(ACTIVITY_WINDOW_EVENTS.newThread, () => {
          if (selectedWorkspaceId) handleNewThread(selectedWorkspaceId);
        }),
      );
      track(
        listen<ActivityStartTaskMessage>(
          ACTIVITY_WINDOW_EVENTS.startTask,
          (event) => {
            const { callId, workspaceId, prompt } = event.payload;
            void handleActivityStartTask({ workspaceId, prompt })
              .then(() =>
                emit(ACTIVITY_WINDOW_EVENTS.startTaskResult, { callId }),
              )
              .catch((error: unknown) =>
                emit(ACTIVITY_WINDOW_EVENTS.startTaskResult, {
                  callId,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to start task",
                }),
              );
          },
        ),
      );
      track(
        listen<ActivityRespondMessage>(
          ACTIVITY_WINDOW_EVENTS.respond,
          (event) => {
            const { callId, request, response } = event.payload;
            void handleInteractiveResponseCallback(request, response)
              .then(() =>
                emit(ACTIVITY_WINDOW_EVENTS.respondResult, { callId }),
              )
              .catch((error: unknown) =>
                emit(ACTIVITY_WINDOW_EVENTS.respondResult, {
                  callId,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to send your response",
                }),
              );
          },
        ),
      );
    });

    return () => {
      disposed = true;
      for (const off of unlisteners) off();
    };
  }, [
    handleInteractiveResponseCallback,
    handleActivityStartTask,
    handleMarkThreadRead,
    handleNewThread,
    handleSelectThread,
    selectedWorkspaceId,
  ]);

  // Reloading the main window (an update, dev HMR) loses the fact that the
  // Activity window is out there; it does not re-announce, so ask the frame.
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    void import("@tauri-apps/api/webviewWindow").then(
      async ({ getAllWebviewWindows }) => {
        const windows = await getAllWebviewWindows();
        if (disposed) return;
        if (windows.some((window) => window.label === ACTIVITY_WINDOW_LABEL)) {
          setActivityWindowOpen(true);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!activityWindowOpen || !isTauriDesktop()) return;
    if (
      !activityStateChanged(lastActivityStateRef.current, activityWindowState)
    )
      return;
    lastActivityStateRef.current = activityWindowState;
    void import("@tauri-apps/api/event").then(({ emit }) =>
      emit(ACTIVITY_WINDOW_EVENTS.state, activityWindowState),
    );
  }, [activityWindowOpen, activityWindowState]);

  const handleMarkThreadUnread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId);
      if (!client) return;
      // The auto-read effect below re-reads whatever thread is selected and
      // focused, which would undo this the moment it lands. Park the thread on
      // the suppression ref first; the effect skips it until the selection
      // moves away or the agent produces new activity.
      const thread = viewSnapshot?.threads.find(
        (entry) => entry.workspace_id === workspaceId && entry.id === threadId,
      );
      suppressAutoReadRef.current = {
        threadId,
        activitySeq: thread?.attention.last_agent_activity_seq ?? 0,
      };
      try {
        const updated = await client.markThreadUnread({
          workspace_id: workspaceId,
          thread_id: threadId,
        });
        suppressAutoReadRef.current = {
          threadId,
          activitySeq: updated.attention.last_agent_activity_seq,
        };
        setSnapshot((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((entry) =>
                  entry.id === updated.id ? updated : entry,
                ),
              }
            : current,
        );
      } catch (error: unknown) {
        suppressAutoReadRef.current = null;
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to mark thread as unread";
        setActionError(msg);
        toast({
          variant: "danger",
          title: "Failed to mark as unread",
          description: msg,
        });
      }
    },
    [apiFor, setActionError, setSnapshot, toast, viewSnapshot?.threads],
  );

  const handleThreadSortChange = useCallback((mode: ThreadSortMode) => {
    setThreadSort(mode);
    writeStoredThreadSort(mode);
  }, []);

  // Navigating into a project (command palette, new thread, notification)
  // unfolds it, otherwise the chat you just opened would sit inside a closed
  // folder. Keyed on the selection *changing*, so folding the project you are
  // currently in does not snap straight back open.
  const lastExpandedWorkspaceRef = useRef<string | null>(selectedWorkspaceId);
  useEffect(() => {
    if (lastExpandedWorkspaceRef.current === selectedWorkspaceId) return;
    lastExpandedWorkspaceRef.current = selectedWorkspaceId;
    if (!selectedWorkspaceId) return;
    setCollapsedWorkspaceIds((current) => {
      if (!current.includes(selectedWorkspaceId)) return current;
      const next = current.filter((id) => id !== selectedWorkspaceId);
      writeStoredCollapsedWorkspaces(next);
      return next;
    });
  }, [selectedWorkspaceId]);

  const handleWorkspaceCollapsedChange = useCallback(
    (workspaceId: string, collapsed: boolean) => {
      setCollapsedWorkspaceIds((current) => {
        const next = collapsed
          ? current.includes(workspaceId)
            ? current
            : [...current, workspaceId]
          : current.filter((id) => id !== workspaceId);
        if (next !== current) writeStoredCollapsedWorkspaces(next);
        return next;
      });
    },
    [],
  );

  // Memoized derived values
  const isThreadDetailPending = Boolean(
    selectedThreadId &&
    (!threadDetail ||
      threadDetail.workspace.id !== selectedWorkspaceId ||
      threadDetail.thread.id !== selectedThreadId),
  );
  const isPreparingSelectedHandoff =
    handoffPendingThreadKey === conversationKey;
  const operationalConditions = useMemo(
    () =>
      workspaceOperationalConditions(
        viewSnapshot?.operational_conditions,
        viewSnapshot?.service_notices,
        selectedWorkspaceId,
        dismissedConditionVersions,
      ),
    [
      dismissedConditionVersions,
      selectedWorkspaceId,
      viewSnapshot?.operational_conditions,
      viewSnapshot?.service_notices,
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

  // The transport acknowledging turn.start is not the same as the agent
  // starting work (especially for Claude over SSH). Keep the optimistic label
  // until the daemon exposes either a running status or the first agent item.
  useEffect(() => {
    if (!isSending) return;
    if (sendingConversationKeyRef.current !== conversationKey) {
      sendingConversationKeyRef.current = null;
      setIsSending(false);
      return;
    }
    const hasAgentActivity =
      lastAgentItemId(conversationItems) !==
      sendingBaselineAgentItemIdRef.current;
    if (
      selectedThread?.status === "running" ||
      selectedThread?.status === "waiting_for_input" ||
      selectedThread?.status === "error" ||
      hasAgentActivity
    ) {
      sendingConversationKeyRef.current = null;
      setIsSending(false);
    }
  }, [conversationItems, conversationKey, isSending, selectedThread?.status]);
  const activeProvider = selectedThread?.provider ?? selectedProvider;
  const currentReasoningOptions = useMemo(
    () =>
      reasoningOptions(
        selectedThread,
        selectedWorkspace,
        selectedModel,
        activeProvider,
      ),
    [activeProvider, selectedModel, selectedThread, selectedWorkspace],
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
  const handoffDisabledReason = handoffPendingProvider
    ? "Creating the linked handoff thread…"
    : selectedThread?.status === "running" ||
        selectedThread?.status === "waiting_for_input"
      ? "Wait for the current turn to finish before handing off"
      : selectedThread?.variant
        ? "Handoffs from isolated threads are not supported yet"
        : null;
  const activeCapabilities = useMemo(
    () =>
      threadAgentCapabilities(
        selectedWorkspace,
        activeProvider,
        selectedThread,
      ),
    [activeProvider, selectedThread, selectedWorkspace],
  );
  const sendBlockReason = workspaceSendBlockReason(
    selectedWorkspace,
    activeProvider,
  );
  const attachmentSendBlockReason = imageAttachmentSendBlockReason(
    activeCapabilities,
    attachments.length,
  );
  const isComposerDisabled = workspaceComposerDisabled(selectedWorkspace);

  // Project readiness belongs to the app-level notification system, not the
  // composer. Keeping the composer free of transient transport copy preserves
  // room for the user's draft and makes all project states surface the same
  // way. The key prevents snapshot refreshes from repeating the toast.
  useEffect(() => {
    if (!selectedWorkspace || !sendBlockReason) {
      announcedProjectReadinessRef.current = null;
      return;
    }

    const noticeKey = [
      selectedWorkspace.id,
      activeProvider,
      selectedWorkspace.status,
      sendBlockReason,
    ].join(":");
    if (announcedProjectReadinessRef.current === noticeKey) return;
    announcedProjectReadinessRef.current = noticeKey;

    const variant =
      selectedWorkspace.status === "error" ||
      selectedWorkspace.status === "disconnected"
        ? "danger"
        : selectedWorkspace.status === "needs_auth"
          ? "warning"
          : "default";
    const title =
      selectedWorkspace.status === "connecting"
        ? "Project reconnecting"
        : selectedWorkspace.status === "needs_auth"
          ? "Authentication needed"
          : "Project not ready";

    toast({ variant, title, description: sendBlockReason });
  }, [activeProvider, selectedWorkspace, sendBlockReason, toast]);

  const workspaces = useMemo(
    () => viewSnapshot?.workspaces ?? [],
    [viewSnapshot?.workspaces],
  );
  const effectivePreferences = useMemo(
    () =>
      preferencesWithThinkingDisplay(
        snapshot?.preferences ?? null,
        thinkingDisplay,
      ),
    [snapshot?.preferences, thinkingDisplay],
  );

  const resolveComposerShortcut = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const command = commandForEvent(
        "composer",
        event.nativeEvent,
        shortcutSettings,
      );
      if (command === "sendMessage") return "submit" as const;
      if (command === "invertFollowUp") return "alternate-submit" as const;
      if (command === "insertNewline") return "newline" as const;
      return null;
    },
    [shortcutSettings],
  );

  const selectAdjacentThread = useCallback(
    (offset: -1 | 1) => {
      const threads = groups.flatMap((group) =>
        group.threads.filter((thread) => !thread.is_archived),
      );
      if (threads.length === 0) return;
      const selectedIndex = threads.findIndex(
        (thread) => thread.id === selectedThreadId,
      );
      const index = selectedIndex >= 0 ? selectedIndex : offset === 1 ? -1 : 0;
      const next = threads[(index + offset + threads.length) % threads.length];
      if (!next) return;
      setIsSettingsOpen(false);
      setIsScheduledOpen(false);
      setIsActivityOpen(false);
      setSelectedWorkspaceId(next.workspace_id);
      setSelectedThreadId(next.id);
    },
    [groups, selectedThreadId, setSelectedThreadId, setSelectedWorkspaceId],
  );

  const navigateSelectionHistory = useCallback(
    (offset: -1 | 1) => {
      const nextIndex = selectionHistoryIndexRef.current + offset;
      const entry = selectionHistoryRef.current[nextIndex];
      if (!entry) return;
      navigatingHistoryRef.current = true;
      selectionHistoryIndexRef.current = nextIndex;
      setIsSettingsOpen(false);
      setIsScheduledOpen(false);
      setIsActivityOpen(false);
      setSelectedWorkspaceId(entry.workspaceId);
      setSelectedThreadId(entry.threadId);
    },
    [setSelectedThreadId, setSelectedWorkspaceId],
  );

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      const command = commandForEvent("global", event, shortcutSettings);
      if (!command) return;
      if (isEditableTarget(event.target) && !event.metaKey && !event.ctrlKey)
        return;
      event.preventDefault();
      if (command !== "commandPalette" && command !== "searchThreads") {
        setPaletteRequest((current) => ({
          ...current,
          key: current.key + 1,
          mode: "close",
        }));
      }
      switch (command) {
        case "commandPalette":
          setPaletteRequest((current) => ({
            key: current.key + 1,
            query: "",
            scope: "all",
            mode: "toggle",
          }));
          break;
        case "searchThreads":
          setPaletteRequest((current) => ({
            key: current.key + 1,
            query: "",
            scope: "threads",
            mode: "open",
          }));
          break;
        case "openSettings":
          setSettingsSection("general");
          setSettingsRequestKey((current) => current + 1);
          setIsSettingsOpen(true);
          setIsScheduledOpen(false);
          setIsActivityOpen(false);
          break;
        case "openActivity":
          handleOpenActivity();
          break;
        case "openKeyboardShortcuts":
          handleOpenKeyboardShortcuts();
          break;
        case "openProject":
          void handleAddProject();
          break;
        case "newThread":
          if (selectedWorkspaceId) handleNewThread(selectedWorkspaceId);
          break;
        case "findInThread":
          if (!isSettingsOpen && selectedThreadId)
            setFindRequestKey((current) => current + 1);
          break;
        case "navigateBack":
          navigateSelectionHistory(-1);
          break;
        case "navigateForward":
          navigateSelectionHistory(1);
          break;
        case "previousThread":
          selectAdjacentThread(-1);
          break;
        case "nextThread":
          selectAdjacentThread(1);
          break;
        case "toggleSidebar":
          toggleSidebar();
          break;
        case "toggleChanges":
          toggleRail();
          break;
        case "increaseTextSize":
        case "decreaseTextSize": {
          const currentIndex = FONT_SCALE_OPTIONS.findIndex(
            (option) => option.value === getAppearance().fontScale,
          );
          const direction = command === "increaseTextSize" ? 1 : -1;
          const next =
            FONT_SCALE_OPTIONS[
              Math.max(
                0,
                Math.min(
                  FONT_SCALE_OPTIONS.length - 1,
                  currentIndex + direction,
                ),
              )
            ];
          if (next) updateAppearance({ fontScale: next.value });
          break;
        }
        case "resetTextSize":
          updateAppearance({ fontScale: DEFAULT_APPEARANCE.fontScale });
          break;
        case "focusComposer":
          setIsSettingsOpen(false);
          setIsScheduledOpen(false);
          setIsActivityOpen(false);
          setComposerFocusRequestKey((current) => current + 1);
          break;
        case "openProjectMenu":
          if (!selectedThreadId) {
            setIsSettingsOpen(false);
            setIsScheduledOpen(false);
            setIsActivityOpen(false);
            setProjectMenuRequestKey((current) => current + 1);
          }
          break;
        case "openHarnessMenu":
        case "openPermissionMenu":
        case "openSandboxMenu":
        case "openModelMenu": {
          const menu =
            command === "openHarnessMenu"
              ? ("provider" as const)
              : command === "openPermissionMenu"
                ? ("permissions" as const)
                : command === "openSandboxMenu"
                  ? ("sandbox" as const)
                  : ("model" as const);
          setIsSettingsOpen(false);
          setIsScheduledOpen(false);
          setIsActivityOpen(false);
          setComposerMenuRequest((current) => ({ key: current.key + 1, menu }));
          break;
        }
        case "stopTurn":
          if (
            selectedThread?.status === "running" ||
            selectedThread?.status === "waiting_for_input"
          )
            handleStopCallback();
          break;
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    handleAddProject,
    handleNewThread,
    handleOpenActivity,
    handleOpenKeyboardShortcuts,
    handleStopCallback,
    isSettingsOpen,
    navigateSelectionHistory,
    selectAdjacentThread,
    selectedThread?.status,
    selectedThreadId,
    selectedWorkspaceId,
    shortcutSettings,
    toggleRail,
    toggleSidebar,
  ]);

  const newThreadEmptyState = useMemo(
    () => <NewThreadState selectedWorkspace={selectedWorkspace} />,
    [selectedWorkspace],
  );
  const loadingThreadState = useMemo(
    () => (
      <div className="flex min-h-[240px] items-center justify-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted">
        <ActivityDiamond size="md" />
        Loading conversation…
      </div>
    ),
    [],
  );
  const threadDetailErrorState = useMemo(
    () =>
      threadDetailError ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
          <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
            This conversation could not be loaded.
          </p>
          <p className="max-w-md text-[length:var(--fd-text-xs)] text-fg-muted">
            {threadDetailError}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={retryThreadDetail}
          >
            Try again
          </Button>
        </div>
      ) : null,
    [retryThreadDetail, threadDetailError],
  );
  const conversationEmptyState = useMemo(() => {
    // Order matters: a failed load also looks "pending", so the error wins.
    if (threadDetailErrorState) {
      return threadDetailErrorState;
    }
    if (isThreadDetailPending) {
      return loadingThreadState;
    }
    if (selectedThreadId) {
      return undefined;
    }
    return newThreadEmptyState;
  }, [
    isThreadDetailPending,
    loadingThreadState,
    newThreadEmptyState,
    selectedThreadId,
    threadDetailErrorState,
  ]);
  const sidebarErrors = useMemo(
    () =>
      [connectionError, actionError].filter((value): value is string =>
        Boolean(value),
      ),
    [actionError, connectionError],
  );
  const activeMainViewId = isActivityOpen
    ? "core.activity"
    : isScheduledOpen
      ? "core.scheduled"
      : isSettingsOpen
        ? "core.settings"
        : activeExtensionPanelKey;

  return (
    <>
      {paletteRequest.key > 0 ? (
        <Suspense fallback={null}>
          <CommandPalette
            groups={groups}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onOpenSettings={handleOpenSettings}
            onOpenActivity={handleOpenActivity}
            onOpenKeyboardShortcuts={handleOpenKeyboardShortcuts}
            shortcutHints={paletteShortcutHints}
            openRequestKey={paletteRequest.key}
            initialQuery={paletteRequest.query}
            initialScope={paletteRequest.scope}
            requestMode={paletteRequest.mode}
          />
        </Suspense>
      ) : null}
      <DesktopShell
        sidebar={
          <DesktopSidebar
            groups={groups}
            workspaceHosts={workspaceHostBadges}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedThreadId={selectedThreadId}
            onSelectWorkspace={handleSelectWorkspace}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onArchiveThread={handleArchiveThread}
            onDeleteThread={handleDeleteThread}
            onRenameThread={handleRenameThread}
            onTogglePinThread={handleTogglePinThread}
            onMarkThreadRead={handleMarkThreadRead}
            onMarkThreadUnread={handleMarkThreadUnread}
            onAddProject={handleAddProject}
            onSearch={handleOpenCommandPalette}
            onRemoveWorkspace={handleRemoveWorkspace}
            threadSort={threadSort}
            onThreadSortChange={handleThreadSortChange}
            onWorkspaceOrderChange={handleWorkspaceOrderChange}
            collapsedWorkspaceIds={collapsedWorkspaceIds}
            onWorkspaceCollapsedChange={handleWorkspaceCollapsedChange}
            isAddingProject={isAddingProject}
            onOpenSettings={handleOpenSettings}
            settingsOpen={isSettingsOpen}
            onOpenScheduled={handleOpenScheduled}
            scheduledOpen={isScheduledOpen}
            onOpenActivity={handleOpenActivity}
            onPopOutActivity={
              isTauriDesktop() ? handlePopOutActivity : undefined
            }
            activityOpen={isActivityOpen}
            activityCount={
              activityCounts.blocked +
              activityCounts.failed +
              activityCounts.ready
            }
            activityHasFailure={activityCounts.failed > 0}
            scheduledAttention={[
              ...(snapshot?.scheduled_tasks ?? []),
              ...remoteHosts.hosts.flatMap(
                (host) => host.snapshot?.scheduled_tasks ?? [],
              ),
            ].some((task) =>
              ["failed", "awaiting_input"].includes(
                task.last_run?.status ?? "",
              ),
            )}
            errors={sidebarErrors}
            threadTagsById={threadTags.byThreadId}
            threadTagOptions={threadTags.tags}
            extensionSidebarFilters={extensionSidebarFilters}
            extensionSnapshot={viewSnapshot?.extensions}
            onSetThreadColor={
              threadTagsEnabled ? handleSetThreadColor : undefined
            }
            canSetThreadColor={canSetThreadColor}
            extensionPanels={extensionPanels}
            activeExtensionPanelKey={activeExtensionPanelKey}
            onOpenExtensionPanel={handleOpenExtensionPanel}
          />
        }
        main={
          resolveMainView(
            {
              "core.activity": (
                <Suspense fallback={loadingThreadState}>
                  <ActivityView
                    groups={groups}
                    interactiveRequests={
                      viewSnapshot?.interactive_requests ?? []
                    }
                    workspaceHosts={workspaceHostBadges}
                    onOpenThread={handleSelectThread}
                    onInteractiveResponse={handleInteractiveResponseCallback}
                    onMarkThreadRead={handleMarkThreadRead}
                    onClose={() => setIsActivityOpen(false)}
                    onNewThread={
                      selectedWorkspaceId
                        ? () => handleNewThread(selectedWorkspaceId)
                        : undefined
                    }
                    onPopOut={
                      isTauriDesktop() ? handlePopOutActivity : undefined
                    }
                  />
                </Suspense>
              ),
              "core.scheduled": (
                <Suspense fallback={loadingThreadState}>
                  <ScheduledTasksView
                    localSnapshot={snapshot}
                    localApi={api as HostScopedApi | null}
                    hosts={remoteHosts.hosts}
                    manager={remoteHosts.manager}
                    onRefreshLocal={async () => {
                      if (api) setSnapshot(await api.snapshot());
                    }}
                    onOpenThread={(workspaceId, threadId) => {
                      setIsScheduledOpen(false);
                      setIsActivityOpen(false);
                      setSelectedWorkspaceId(workspaceId);
                      setSelectedThreadId(threadId);
                    }}
                    onToast={toast}
                  />
                </Suspense>
              ),
              "core.settings": (
                <Suspense fallback={loadingThreadState}>
                  <SettingsView
                    initialSection={settingsSection}
                    sectionRequestKey={settingsRequestKey}
                    workspace={selectedWorkspace}
                    localWorkspaces={snapshot?.workspaces ?? []}
                    baseUrl={baseUrl}
                    hostManager={remoteHosts.manager}
                    hosts={remoteHosts.hosts}
                    onToast={toast}
                    preferences={effectivePreferences}
                    remoteStatus={remoteStatus}
                    pairingLink={pairingLink}
                    relayUrl={relayUrl}
                    isStartingRemote={isStartingRemote}
                    remoteControlsDisabled={remoteControlsDisabled}
                    remoteControlsUnavailableReason={
                      remoteControlsUnavailableReason
                    }
                    revokingDeviceId={revokingDeviceId}
                    updater={updater.state}
                    updaterProgressPercent={updater.progressPercent}
                    onUpdatePreferences={handleUpdatePreferences}
                    onStartPairing={handleStartPairingCallback}
                    onRefreshRemoteStatus={handleRefreshRemoteStatus}
                    onRevokeDevice={handleRevokeDevice}
                    onCheckForUpdates={handleCheckForUpdates}
                    onDownloadUpdate={handleDownloadUpdate}
                    onRestartToInstallUpdate={handleRestartToInstallUpdate}
                    extensions={
                      snapshot?.extensions ?? { catalog: [], views: [] }
                    }
                    onSetExtensionEnabled={handleSetExtensionEnabled}
                    onSetExtensionPermission={handleSetExtensionPermission}
                    onClose={() => setIsSettingsOpen(false)}
                  />
                </Suspense>
              ),
              ...Object.fromEntries(
                extensionPanels.map((panel) => [
                  panel.key,
                  <ExtensionPanel
                    key={panel.key}
                    panel={panel}
                    onClose={() => setActiveExtensionPanelKey(null)}
                    onAction={(extensionId, action) =>
                      invokeExtensionPanelAction(panel, extensionId, action)
                    }
                  />,
                ]),
              ),
            },
            activeMainViewId,
          ) ?? (
            <DesktopConversationPane
              selectedWorkspace={selectedWorkspace}
              selectedThread={selectedThread}
              selectedWorkspaceId={selectedWorkspaceId}
              selectedThreadId={selectedThreadId}
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              isStartingRemote={isStartingRemote}
              remoteControlsDisabled={remoteControlsDisabled}
              remoteControlsUnavailableReason={remoteControlsUnavailableReason}
              onRevokeDevice={handleRevokeDevice}
              revokingDeviceId={revokingDeviceId}
              conversationItems={conversationItems}
              preferences={effectivePreferences}
              conversationEmptyState={conversationEmptyState}
              isSending={isSending || isPreparingSelectedHandoff}
              sendingLabel={
                isPreparingSelectedHandoff
                  ? "Summarizing previous conversation…"
                  : isPreparingIsolation
                    ? "Setting up isolated copy…"
                    : null
              }
              isThreadDetailPending={isThreadDetailPending}
              hasOlderMessages={Boolean(
                threadDetail?.workspace.id === selectedWorkspaceId &&
                threadDetail.thread.id === selectedThreadId &&
                threadDetail.has_older,
              )}
              isLoadingOlderMessages={
                loadingOlderThreadKey ===
                `${selectedWorkspaceId}:${selectedThreadId}`
              }
              onLoadOlderMessages={handleLoadOlder}
              interactiveRequests={interactiveRequests}
              operationalConditions={operationalConditions}
              onDismissOperationalCondition={dismissOperationalCondition}
              findRequestKey={findRequestKey}
              onRemoveQueuedTurn={handleRemoveQueuedTurn}
              onSteerQueuedTurn={handleSteerQueuedTurn}
              onEditQueuedTurn={handleEditQueuedTurn}
              onReorderQueuedTurns={handleReorderQueuedTurns}
              queuedAttachmentBaseUrl={
                isRemoteWorkspaceSelected ? null : baseUrl
              }
              canSteerQueuedTurn={activeCapabilities.supports_steering}
              // Remote-host workspaces have no local checkout, so the rail has
              // no diff to show and file paths stay plain text there.
              onOpenFile={isRemoteWorkspaceSelected ? null : handleOpenFileDiff}
              onStartPairing={handleStartPairingCallback}
              onInteractiveResponse={handleInteractiveResponseCallback}
              promptInputKey={`${conversationKey}:${activeProvider}:${activeCapabilities.supports_images ? "images" : "no-images"}`}
              onNewThread={
                selectedThread ? handleNewThreadFromCurrent : undefined
              }
              onRetryResponse={
                selectedThread &&
                activeCapabilities.supports_forking &&
                !selectedThread.variant &&
                selectedThread.status !== "running" &&
                selectedThread.status !== "waiting_for_input"
                  ? handleRetryResponse
                  : undefined
              }
              onContinueInterruptedTurn={handleContinueInterruptedTurn}
              onDismissInterruptedTurn={handleDismissInterruptedTurn}
              quotedSelections={quotedSelections}
              onQuoteSelection={addQuotedSelection}
              onRemoveQuotedSelection={removeQuotedSelection}
              promptInputProps={{
                value: draft,
                onValueChange: setDraft,
                // Opening a conversation is a writing action: land the caret
                // in its composer whether it is a new or existing thread.
                autoFocusKey: conversationKey,
                onSubmit: handleSubmitCallback,
                onVoiceInput: baseUrl
                  ? () => setIsVoiceInputOpen(true)
                  : undefined,
                onAlternateSubmit: handleAlternateSubmitCallback,
                resolveComposerShortcut,
                focusRequestKey: composerFocusRequestKey,
                menuRequest: composerMenuRequest,
                menuShortcuts: composerMenuShortcuts,
                onStop: handleStopCallback,
                onPickImages: handlePickImages,
                onRemoveAttachment: handleRemoveAttachment,
                attachments,
                preparingAttachmentCount,
                skills: selectedWorkspace?.skills ?? [],
                selectedProvider,
                onProviderChange: handleProviderChange,
                providers: providerOptions,
                capabilities: activeCapabilities,
                providerLocked: Boolean(selectedThread),
                showProviderSelector: !selectedThread,
                handoffProviders: handoffProviderOptions,
                onHandoffProviderSelect: selectedThread
                  ? handleHandoffProviderSelect
                  : undefined,
                handoffDisabledReason,
                models,
                selectedModelId: selectedModel,
                onModelChange: handleModelChange,
                reasoningOptions: currentReasoningOptions,
                selectedEffort,
                onEffortChange: handleEffortChange,
                selectedServiceTier,
                onServiceTierChange: handleServiceTierChange,
                collaborationModes: workspaceCollaborationModes(
                  selectedWorkspace,
                  activeProvider,
                ),
                selectedCollaborationMode,
                onCollaborationModeChange: handleCollaborationModeChange,
                selectedPermissionMode,
                onPermissionModeChange: handlePermissionModeChange,
                selectedSandboxMode,
                onSandboxModeChange: handleSandboxModeChange,
                // The bar itself stays enabled while the composer is blocked:
                // picking a project is how you unblock an empty window.
                contextBar: selectedThread ? undefined : (
                  <ComposerContextBar
                    workspaces={workspaces}
                    selectedWorkspace={selectedWorkspace}
                    onSelectWorkspace={handleNewThreadProjectChange}
                    projectMenuRequestKey={projectMenuRequestKey}
                    projectShortcutLabel={
                      shortcutHint("openProjectMenu", shortcutSettings) ??
                      undefined
                    }
                    selectedIsolation={selectedIsolation}
                    onIsolationChange={setSelectedIsolation}
                    branches={branches}
                    uncommittedCount={uncommittedCount}
                    onCheckoutBranch={handleCheckoutBranch}
                    isCheckoutPending={isCheckoutPending}
                    workspaceHosts={workspaceHostBadges}
                    remoteHosts={composerRemoteHosts}
                    onAddLocalProject={handleAddProject}
                    onAddRemoteProject={handleAddRemoteProject}
                    isAddingProject={
                      isAddingProject || isImportingProjectSessions
                    }
                  />
                ),
                disabled: isComposerDisabled,
                // Submission should block duplicate sends, not permission and
                // sandbox changes while an agent turn is active or stopping.
                sendDisabled:
                  Boolean(sendBlockReason) ||
                  Boolean(attachmentSendBlockReason) ||
                  isSending ||
                  isPreparingSelectedHandoff ||
                  preparingAttachmentCount > 0,
                sendDisabledReason:
                  attachmentSendBlockReason ??
                  (isPreparingSelectedHandoff
                    ? "Wait for the handoff summary to finish"
                    : undefined),
                // waiting_for_input counts: the CLI is alive and blocked on an
                // approval, and Stop is the only way out of one that has gone
                // stale or was never noticed.
                isRunning:
                  selectedThread?.status === "running" ||
                  selectedThread?.status === "waiting_for_input",
                isStopping,
                connectorCount,
                onConnectorsClick: () => {
                  setSettingsSection("connectors");
                  setSettingsRequestKey((current) => current + 1);
                  setIsSettingsOpen(true);
                  setIsScheduledOpen(false);
                  setIsActivityOpen(false);
                },
                // Goals live in the composer's plus menu, not the header.
                goal:
                  selectedWorkspace && activeCapabilities.supports_goals
                    ? {
                        goal: selectedThread?.goal ?? null,
                        provider: activeProvider,
                        onSetGoal: handleSetGoal,
                        onClearGoal: handleClearGoal,
                        onSetGoalStatus: handleSetGoalStatus,
                      }
                    : undefined,
              }}
              headerLeadingControls={
                <ShipMenu
                  thread={selectedThread}
                  onShip={shipThread}
                  pending={isShipPending}
                  projectFolderDirty={projectFolderDirty}
                />
              }
              headerControls={
                <PanelToggles
                  sidebarVisible={sidebarVisible}
                  railVisible={railVisible}
                  onToggleSidebar={toggleSidebar}
                  onToggleRail={toggleRail}
                />
              }
            />
          )
        }
        rail={
          activeMainViewId ? undefined : (
            <Suspense fallback={null}>
              <DiffPanel
                api={apiFor(selectedWorkspaceId)}
                workspaceId={selectedWorkspaceId}
                threadId={selectedThread?.id ?? null}
                refreshTrigger={combinedGitRefreshTrigger}
                reviewThreadId={
                  selectedThread && activeCapabilities.supports_review
                    ? selectedThread.id
                    : null
                }
                selection={diffSelection}
                onSelectionChange={setDiffSelection}
                info={reviewInfo}
              />
            </Suspense>
          )
        }
        sidebarVisible={sidebarVisible}
        railVisible={railVisible}
        onSidebarCollapsedByDrag={hideSidebar}
        onRailCollapsedByDrag={hideRail}
      />
      {isImportingProjectSessions ? <ProjectImportOverlay /> : null}
      {resumePromptThreads && resumePromptThreads.length > 0 ? (
        <ResumeStoppedThreadsDialog
          threads={resumePromptThreads}
          onContinueAll={() => {
            void handleContinueStoppedThreads();
          }}
          onDismiss={handleDismissStoppedThreadsPrompt}
          isContinuing={isContinuingStoppedThreads}
        />
      ) : null}
      {isVoiceInputOpen && baseUrl ? (
        <DesktopVoiceInput
          baseUrl={baseUrl}
          onTranscript={setDraft}
          onClose={() => setIsVoiceInputOpen(false)}
          onOpenSettings={() => {
            setIsVoiceInputOpen(false);
            setSettingsSection("speech");
            setSettingsRequestKey((current) => current + 1);
            setIsSettingsOpen(true);
            setIsScheduledOpen(false);
            setIsActivityOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
