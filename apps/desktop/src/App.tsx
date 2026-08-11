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
  buildProjectGroups,
  approvalPolicyForProvider,
  composerProviderFor,
  composerSelectionFor,
  countAwaitingResponseThreads,
  conversationItemsForSelection,
  deriveThreadAttentionPresentation,
  draftKeyFor,
  editResendUnavailableReason,
  filesToImageInputs,
  generateUserItemId,
  imageAttachmentSendBlockReason,
  latestWorkspaceNotice,
  mergeThreadDetailPage,
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
  workspaceCollaborationModes,
  workspaceModels,
  workspaceProviderLabel,
  workspaceProviderOptions,
  threadForSelection,
  type AgentProvider,
  type AttachmentPreparationCounts,
  type ComposerDrafts,
  type ConversationItem,
  type ImageInput,
  type PersistedComposerSelection,
  type PersistedComposerState,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ThreadHandle,
  type ThreadIsolation,
  type ThinkingDisplay,
  type ThreadSortMode,
  type ThreadSummary,
  type TurnInputItem,
  type UpdatePreferencesPayload,
} from "@falcondeck/client-core";
import {
  ComposerContextBar,
  NewThreadState,
  type ComposerMenuRequest,
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
  workspaceComposerDisabled,
  workspaceSendBlockReason,
} from "./app-utils";
import {
  readPersistedComposerState,
  readStoredDrafts,
  writePersistedComposerState,
  writeStoredDrafts,
} from "./composer-persistence";
import {
  preferencesWithThinkingDisplay,
  readStoredThinkingDisplay,
  readStoredThreadSort,
  splitPreferencesUpdate,
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
import { DesktopSidebar } from "./components/Sidebar";
import { DesktopShell } from "./components/DesktopShell";
import type { DiffPanelSelection } from "./components/DiffPanel";
import { PanelToggles } from "./components/PanelToggles";
import { ProjectImportOverlay } from "./components/ProjectImportOverlay";
import type { SettingsSectionId } from "./components/settings/settings-utils";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useDaemonConnection } from "./hooks/useDaemonConnection";
import { useGitBranches } from "./hooks/useGitBranches";
import { usePanelVisibility } from "./hooks/usePanelVisibility";
import { useRemoteHosts } from "./hooks/useRemoteHosts";
import { hostLabelByWorkspaceId, mergeSnapshots } from "./hosts";
import {
  commandForEvent,
  getShortcutSettings,
  isEditableTarget,
  useShortcutSettings,
} from "./shortcuts";

// Stable empty array so conversations without attachments don't bust the
// memoized PromptInput on every render.
const NO_ATTACHMENTS: ImageInput[] = [];
const DRAFT_PERSIST_DELAY_MS = 200;

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
  const updater = useAppUpdater();
  const { sidebarVisible, railVisible, toggleSidebar, toggleRail, showRail } =
    usePanelVisibility();
  const shortcutSettings = useShortcutSettings();

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
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");
  const [settingsRequestKey, setSettingsRequestKey] = useState(0);
  const [paletteRequest, setPaletteRequest] = useState({
    key: 0,
    query: "",
    mode: "toggle" as "open" | "toggle" | "close",
  });
  const [composerFocusRequestKey, setComposerFocusRequestKey] = useState(0);
  const [composerMenuRequest, setComposerMenuRequest] =
    useState<ComposerMenuRequest>({ key: 0, menu: "model" });
  const [findRequestKey, setFindRequestKey] = useState(0);
  const [diffSelection, setDiffSelection] = useState<DiffPanelSelection | null>(
    null,
  );
  const [isSending, setIsSending] = useState(false);
  // Isolated-thread creation clones the working tree before the first turn
  // can start; a bare "Sending…" over that window reads as a hang.
  const [isPreparingIsolation, setIsPreparingIsolation] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [windowFocused, setWindowFocused] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [dismissedNoticeIds, setDismissedNoticeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [thinkingDisplay, setThinkingDisplay] = useState<ThinkingDisplay>(
    readStoredThinkingDisplay,
  );
  const [threadSort, setThreadSort] =
    useState<ThreadSortMode>(readStoredThreadSort);
  const selectionSeedRef = useRef<string | null>(null);
  const threadSettingsRequestRef = useRef(0);
  const notifiedAttentionRef = useRef(new Map<string, string>());
  const announcedUpdateVersionRef = useRef<string | null>(null);
  const announcedDownloadedVersionRef = useRef<string | null>(null);
  const draftsRef = useRef(drafts);
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

  const setDraftForConversation = useCallback((key: string, value: string) => {
    setDrafts((current) => {
      const next = upsertComposerDraft(current, key, value);
      draftsRef.current = next;
      return next;
    });
  }, []);

  // localStorage writes and whole-draft JSON serialization are synchronous.
  // Debouncing keeps the input path free of storage work while still flushing
  // immediately when the webview is backgrounded or closed.
  useEffect(() => {
    const timeout = window.setTimeout(
      () => writeStoredDrafts(drafts),
      DRAFT_PERSIST_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [drafts]);

  useEffect(() => {
    const flushDrafts = () => writeStoredDrafts(draftsRef.current);
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flushDrafts();
    };
    window.addEventListener("pagehide", flushDrafts);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", flushDrafts);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
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
        draftsRef.current = next;
        return next;
      });
      setAttachmentsForConversation(key, (current) =>
        mergeFailedComposerAttachments(failedAttachments, current),
      );
    },
    [setAttachmentsForConversation],
  );

  // Local daemon snapshot merged with enrolled remote-host snapshots: the
  // sidebar, selection, and composer all see one world; writes route back to
  // the owning daemon via apiFor.
  const viewSnapshot = useMemo(
    () => mergeSnapshots(snapshot, remoteHosts.hosts),
    [remoteHosts.hosts, snapshot],
  );
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
  const apiFor = useCallback(
    (workspaceId: string | null | undefined) => {
      const host = remoteHosts.hostForWorkspace(workspaceId);
      return host ? host.api() : api;
    },
    [api, remoteHosts],
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
  const conversationItems: ConversationItem[] = useMemo(
    () =>
      conversationItemsForSelection(
        selectedWorkspaceId,
        selectedThreadId,
        threadDetail,
      ),
    [selectedThreadId, selectedWorkspaceId, threadDetail],
  );
  const interactiveRequests = useMemo(
    () =>
      selectedThreadId
        ? (viewSnapshot?.interactive_requests ?? []).filter(
            (request) =>
              request.workspace_id === selectedWorkspaceId &&
              request.thread_id === selectedThreadId,
          )
        : [],
    [
      selectedThreadId,
      selectedWorkspaceId,
      viewSnapshot?.interactive_requests,
    ],
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

  useEffect(() => {
    const client = apiFor(selectedWorkspaceId);
    if (!client || !selectedWorkspaceId || !selectedThread) return;
    if (!windowFocused) return;
    const readSeq = selectedThread.attention.last_agent_activity_seq;
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

      if (typeof Notification === "undefined") continue;
      if (Notification.permission === "default") {
        void Notification.requestPermission().catch(() => {});
        continue;
      }
      if (Notification.permission !== "granted") continue;

      const body =
        attention.level === "awaiting_response"
          ? "The agent needs a response in this thread."
          : attention.level === "error"
            ? "The latest run ended with an error."
            : "New activity in this thread.";
      new Notification(thread.title || "FalconDeck thread", { body });
    }
  }, [
    selectedThreadId,
    viewSnapshot?.interactive_requests,
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
      if (!client || !selectedWorkspace || !selectedThreadId) {
        throw new Error("Select a thread first");
      }
      const thread = await client.setThreadGoal({
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        objective,
        token_budget: tokenBudget,
      });
      applyThreadSummary(thread);
    },
    [apiFor, applyThreadSummary, selectedThreadId, selectedWorkspace],
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
      setSelectedThreadId(workspace.current_thread_id);
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
  }, [api, setSnapshot, setSelectedThreadId, setSelectedWorkspaceId, toast]);

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

  async function handleSubmit(steer = false) {
    if ((attachmentPreparationCountsRef.current[conversationKey] ?? 0) > 0) {
      setActionError("Wait for image preparation to finish before sending.");
      return;
    }
    const client = apiFor(selectedWorkspace?.id);
    if (
      !client ||
      !selectedWorkspace ||
      (!draft.trim() && attachments.length === 0)
    )
      return;
    const submittedDraft = draft;
    const submittedAttachments = attachments;
    const submittedSkills = selectedSkillsFromText(
      submittedDraft,
      selectedWorkspace.skills ?? [],
    );
    const activeProvider = selectedThread?.provider ?? selectedProvider;
    const imageBlockReason = imageAttachmentSendBlockReason(
      workspaceAgentCapabilities(selectedWorkspace, activeProvider),
      attachments.length,
    );
    const blockReason =
      workspaceSendBlockReason(selectedWorkspace, activeProvider) ??
      imageBlockReason;
    if (blockReason) {
      setActionError(blockReason);
      toast({
        variant: "danger",
        title: imageBlockReason && blockReason === imageBlockReason
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
    sendingConversationKeyRef.current = submittedKey;
    sendingBaselineAgentItemIdRef.current = lastAgentItemId(conversationItems);
    setDraftForConversation(submittedKey, "");
    setAttachmentsForConversation(submittedKey, () => []);
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
          // The new thread is known to be empty. Render it immediately rather
          // than showing a loading state while the detail endpoint catches up.
          const seededDetail = {
            workspace: handle.workspace,
            thread: handle.thread,
            items: [],
            has_older: false,
            oldest_item_id: null,
            newest_item_id: null,
            is_partial: false,
          };
          // Remote threads render from the host's detail cache; without a
          // seed the detail effect nulls the transcript while it fetches.
          remoteHosts
            .hostForWorkspace(selectedWorkspace.id)
            ?.seedThreadDetail(seededDetail);
          setThreadDetail(seededDetail);
        }
      }
      const inputs: TurnInputItem[] = [
        ...(submittedDraft.trim()
          ? [{ type: "text", text: submittedDraft } satisfies TurnInputItem]
          : []),
        ...submittedAttachments,
      ];
      // Show the message in the transcript now; the daemon echoes it back
      // under the same id, so the echo replaces this copy in place. A send
      // aimed at a busy thread lands in the queue chip instead, so it skips
      // the transcript (steering does append to the transcript).
      const expectQueued =
        !steer &&
        (selectedThread?.status === "running" ||
          selectedThread?.status === "waiting_for_input");
      const optimisticItem = expectQueued
        ? null
        : buildOptimisticUserItem(userItemId, inputs, new Date().toISOString());
      if (optimisticItem) {
        const targetThreadId = activeThreadId;
        remoteHosts
          .hostForWorkspace(selectedWorkspace.id)
          ?.upsertLocalItem(selectedWorkspace.id, targetThreadId, optimisticItem);
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
      restoreFailedSubmission(restoreKey, submittedDraft, submittedAttachments);
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
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(threadId);
    },
    [setSelectedWorkspaceId, setSelectedThreadId],
  );

  const handleSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      setIsSettingsOpen(false);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(threadId);
    },
    [setSelectedWorkspaceId, setSelectedThreadId],
  );

  const handleNewThread = useCallback(
    (workspaceId: string) => {
      setIsSettingsOpen(false);
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(null);
      // Clear the detail at the same time as the selection. The connection
      // hook also reconciles this during layout, but the new-thread surface
      // must never briefly inherit the previous thread's transcript while
      // React is committing the selection change.
      setThreadDetail(null);
    },
    [setSelectedWorkspaceId, setSelectedThreadId, setThreadDetail],
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
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    selectedPermissionMode,
    selectedSandboxMode,
    selectedIsolation,
  ]);

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

  const handleEditResend = useCallback(
    async (item: Extract<ConversationItem, { kind: "user_message" }>) => {
      try {
        const branch = await branchFromMessage(item);
        if (!branch) return;
        const key = draftKeyFor(
          branch.handle.workspace.id,
          branch.handle.thread.id,
        );
        setDraftForConversation(key, item.text);
        setAttachmentsForConversation(key, () => item.attachments);
        setActionError(null);
        toast({
          variant: "success",
          title: branch.adopted ? "New branch ready" : "Branch created",
          description: branch.adopted
            ? "Edit the message in the composer, then send when ready."
            : "Your current thread stayed open. Select the new branch to edit the saved message.",
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to branch conversation";
        setActionError(message);
        toast({
          variant: "danger",
          title: "Failed to branch conversation",
          description: message,
        });
        throw error instanceof Error
          ? error
          : new Error("Failed to branch conversation");
      }
    },
    [
      branchFromMessage,
      setAttachmentsForConversation,
      setDraftForConversation,
      toast,
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

  const handleThreadSortChange = useCallback((mode: ThreadSortMode) => {
    setThreadSort(mode);
    writeStoredThreadSort(mode);
  }, []);

  // Memoized derived values
  const isThreadDetailPending = Boolean(
    selectedThreadId &&
    (!threadDetail ||
      threadDetail.workspace.id !== selectedWorkspaceId ||
      threadDetail.thread.id !== selectedThreadId),
  );
  const operationalNotice = useMemo(
    () =>
      latestWorkspaceNotice(
        viewSnapshot?.service_notices,
        selectedWorkspaceId,
        dismissedNoticeIds,
      ),
    [dismissedNoticeIds, selectedWorkspaceId, viewSnapshot?.service_notices],
  );
  const dismissOperationalNotice = useCallback((noticeId: string) => {
    setDismissedNoticeIds((current) => {
      if (current.has(noticeId)) return current;
      const next = new Set(current);
      next.add(noticeId);
      return next;
    });
  }, []);

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
  const activeCapabilities = useMemo(
    () => workspaceAgentCapabilities(selectedWorkspace, activeProvider),
    [activeProvider, selectedWorkspace],
  );
  const editResendReason = selectedThread
    ? editResendUnavailableReason({
        providerLabel: workspaceProviderLabel(
          selectedWorkspace,
          selectedThread.provider,
        ),
        supportsForking: activeCapabilities.supports_forking,
        isIsolated: Boolean(selectedThread.variant),
        threadStatus: selectedThread.status,
      })
    : null;
  const sendBlockReason = workspaceSendBlockReason(
    selectedWorkspace,
    activeProvider,
  );
  const attachmentSendBlockReason = imageAttachmentSendBlockReason(
    activeCapabilities,
    attachments.length,
  );
  const isComposerDisabled = workspaceComposerDisabled(selectedWorkspace);
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
            mode: "toggle",
          }));
          break;
        case "searchThreads":
          setPaletteRequest((current) => ({
            key: current.key + 1,
            query: "",
            mode: "open",
          }));
          break;
        case "openSettings":
          setSettingsSection("general");
          setSettingsRequestKey((current) => current + 1);
          setIsSettingsOpen(true);
          break;
        case "openKeyboardShortcuts":
          setSettingsSection("keyboard");
          setSettingsRequestKey((current) => current + 1);
          setIsSettingsOpen(true);
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
          setComposerFocusRequestKey((current) => current + 1);
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

  return (
    <>
      {paletteRequest.key > 0 ? (
        <Suspense fallback={null}>
          <CommandPalette
            groups={groups}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onOpenSettings={handleOpenSettings}
            openRequestKey={paletteRequest.key}
            initialQuery={paletteRequest.query}
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
            onAddProject={handleAddProject}
            onRemoveWorkspace={handleRemoveWorkspace}
            threadSort={threadSort}
            onThreadSortChange={handleThreadSortChange}
            onWorkspaceOrderChange={handleWorkspaceOrderChange}
            isAddingProject={isAddingProject}
            onOpenSettings={handleOpenSettings}
            settingsOpen={isSettingsOpen}
            errors={sidebarErrors}
          />
        }
        main={
          isSettingsOpen ? (
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
                onClose={() => setIsSettingsOpen(false)}
              />
            </Suspense>
          ) : (
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
              isSending={isSending}
              sendingLabel={
                isPreparingIsolation ? "Setting up isolated copy…" : null
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
              operationalNotice={operationalNotice}
              onDismissOperationalNotice={dismissOperationalNotice}
              findRequestKey={findRequestKey}
              onRemoveQueuedTurn={handleRemoveQueuedTurn}
              onSteerQueuedTurn={handleSteerQueuedTurn}
              onEditQueuedTurn={handleEditQueuedTurn}
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
              onEditResend={
                selectedThread &&
                activeCapabilities.supports_forking &&
                !selectedThread.variant &&
                selectedThread.status !== "running" &&
                selectedThread.status !== "waiting_for_input"
                  ? handleEditResend
                  : undefined
              }
              editResendUnavailableReason={editResendReason}
              onRetryResponse={
                selectedThread &&
                activeCapabilities.supports_forking &&
                !selectedThread.variant &&
                selectedThread.status !== "running" &&
                selectedThread.status !== "waiting_for_input"
                  ? handleRetryResponse
                  : undefined
              }
              promptInputProps={{
                value: draft,
                onValueChange: setDraft,
                // Land the caret in the composer when a new conversation
                // opens; null while a thread is selected keeps thread
                // switches from stealing focus.
                autoFocusKey: selectedThread
                  ? null
                  : (selectedWorkspaceId ?? "new"),
                onSubmit: handleSubmitCallback,
                onAlternateSubmit: handleAlternateSubmitCallback,
                resolveComposerShortcut,
                focusRequestKey: composerFocusRequestKey,
                menuRequest: composerMenuRequest,
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
                    onSelectWorkspace={handleNewThread}
                    selectedIsolation={selectedIsolation}
                    onIsolationChange={setSelectedIsolation}
                    branches={branches}
                    uncommittedCount={uncommittedCount}
                    onCheckoutBranch={handleCheckoutBranch}
                    isCheckoutPending={isCheckoutPending}
                  />
                ),
                disabled: isComposerDisabled,
                // Submission should block duplicate sends, not permission and
                // sandbox changes while an agent turn is active or stopping.
                sendDisabled:
                  Boolean(sendBlockReason) ||
                  Boolean(attachmentSendBlockReason) ||
                  isSending ||
                  preparingAttachmentCount > 0,
                sendDisabledReason: attachmentSendBlockReason ?? undefined,
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
                },
                // Goals live in the composer's plus menu, not the header.
                goal:
                  selectedThread && activeCapabilities.supports_goals
                    ? {
                        goal: selectedThread.goal,
                        provider: activeProvider,
                        onSetGoal: handleSetGoal,
                        onClearGoal: handleClearGoal,
                        onSetGoalStatus: handleSetGoalStatus,
                      }
                    : undefined,
              }}
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
          isSettingsOpen ? undefined : (
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
              />
            </Suspense>
          )
        }
        sidebarVisible={sidebarVisible}
        railVisible={railVisible}
      />
      {isImportingProjectSessions ? <ProjectImportOverlay /> : null}
    </>
  );
}
