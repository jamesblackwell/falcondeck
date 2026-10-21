import { ProjectFolderSheet, ProjectFolderPickerSheet } from './ProjectFolderSheet';
import { mutateProjectFolder } from '@/lib/project-folders';
import { useSessionStore } from '@/store'
import { isSyncThreadPageInFlight, loadSyncThreadPage, loadSyncProjectFolderPage } from '@/hooks/sync-index'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { FlashList } from "@shopify/flash-list";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderClosed,
  FolderPlus,
  FolderOpen,
  Inbox,
  ListFilter,
  Plus,
  Settings,
  SquarePen,
  X,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { triggerProjectToggleHaptic } from "@/lib/haptics";

import type {
  ActiveExtensionThreadFilter,
  ExtensionSidebarFilterDefinition,
  ExtensionSnapshot,
  ExtensionUiTone,
  ProjectGroup,
  ProjectFolder,
  ProjectFolderMutation,
  ThreadSortMode,
  ThreadSummary,
  ThreadTag,
  SyncIndexCoverage,
} from "@falcondeck/client-core";
import {
  EMPTY_PROJECT_FOLDERS,
  filterProjectGroupsByExtensions,
  isThreadSortMode,
  isWorkspaceColorId,
  THREAD_SORT_OPTIONS,
  THREAD_TAGS_EXTENSION_ID,
} from "@falcondeck/client-core";

import {
  ActivityDiamond,
  Text,
  Button,
  EmptyState,
  GlassButton,
  LoadingPill,
  OptionSheet,
  ScrollEdge,
  SymbolIcon,
  SyncBanner,
} from "@/components/ui";
import { CHROME_MAX_FONT_SCALE } from "@/lib/glass";
import {
  readStoredChatsCollapsed,
  writeStoredChatsCollapsed,
} from "@/storage/chats-collapsed";
import {
  readStoredThreadSort,
  writeStoredThreadSort,
} from "@/storage/thread-sort";
import { SessionListItem } from "@/components/chat";
import { useCollapsible } from "@/components/chat/useCollapsible";
import { useSessionSyncStatus } from "@/hooks/useSessionSyncStatus";
import { useRelativeTimeTick } from "@/hooks/useRelativeTimeTick";
import {
  buildSidebarRows,
  SHOW_MORE_STEP,
  VISIBLE_THREAD_LIMIT,
  sidebarRowsEqual,
  type SidebarRow,
} from "./sidebarRows";
import { ThreadOptionsSheet } from "./ThreadOptionsSheet";
import { WorkspaceOptionsSheet } from "./WorkspaceOptionsSheet";
import { ExtensionFilterSheet } from "./ExtensionFilterSheet";
import { useWorkspaceIcons } from "@/hooks/useWorkspaceIcons";

interface SidebarViewProps {
  isVisible?: boolean;
  syncIndex?: SyncIndexCoverage;
  groups: ProjectGroup[];
  /** Target for the top-level "New thread" row, before any per-project pick. */
  selectedWorkspaceId?: string | null;
  selectedThreadId: string | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onNewThread: (workspaceId: string) => void;
  onNewChat?: () => Promise<void> | void;
  onOpenActivity?: () => void;
  activityOpen?: boolean;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  /** Dismisses the drawer; the full-width sidebar leaves no scrim to tap. */
  onClose?: () => void;
  threadTagsById?: Record<string, ThreadTag[]>;
  threadTagOptions?: readonly ThreadTag[];
  extensionSnapshot?: ExtensionSnapshot | null;
  extensionSidebarFilters?: readonly ExtensionSidebarFilterDefinition[];
  projectFolders?: readonly ProjectFolder[];
  onNewThreadInFolder?: (workspaceId: string, folderId: string) => Promise<void>;
  workspaceColors?: Record<string, string>;
  hiddenWorkspaceIds?: readonly string[];
}

function workspaceCatColor(
  cat: Record<number, string>,
  colorId: string | undefined,
): string | undefined {
  if (!isWorkspaceColorId(colorId)) return undefined;
  return cat[Number(colorId.slice(4))];
}

const SORT_SHEET_ITEMS = THREAD_SORT_OPTIONS.map((option) => ({
  value: option.mode,
  label: option.label,
}));

const EXTENSION_UI_TONES = new Set<ExtensionUiTone>([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);

function extensionUiTone(color: string): ExtensionUiTone {
  return EXTENSION_UI_TONES.has(color as ExtensionUiTone)
    ? (color as ExtensionUiTone)
    : "gray";
}

// Collapsed projects keep their thread rows in the list data so the same cells
// can animate shut — height runs to zero while everything below slides up,
// matching the iOS accordion feel. `useCollapsible` already handles FlashList
// recycling (snap, don't animate, when the cell lands on a different row).
const CollapsibleRow = memo(function CollapsibleRow({
  rowKey,
  isCollapsed,
  children,
}: {
  rowKey: string;
  isCollapsed: boolean;
  children: ReactNode;
}) {
  const { bodyStyle, onContentLayout } = useCollapsible(!isCollapsed, rowKey);

  return (
    <Animated.View
      style={bodyStyle}
      pointerEvents={isCollapsed ? "none" : "auto"}
      accessibilityElementsHidden={isCollapsed}
      importantForAccessibility={isCollapsed ? "no-hide-descendants" : "auto"}
    >
      <View onLayout={onContentLayout}>{children}</View>
    </Animated.View>
  );
});

const FLOATING_ACTION_HEIGHT = 56;
/** Matches the floating header row on the conversation screen. */
const GLASS_ROW_HEIGHT = 52;
const EMPTY_HIDDEN_WORKSPACE_IDS: readonly string[] = [];

export const SidebarView = memo(function SidebarView({
  isVisible = true,
  syncIndex,
  groups,
  selectedWorkspaceId = null,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onNewChat,
  onOpenActivity,
  activityOpen = false,
  onOpenSettings,
  settingsOpen = false,
  onClose,
  threadTagsById,
  threadTagOptions = [],
  extensionSnapshot,
  extensionSidebarFilters = [],
  projectFolders = EMPTY_PROJECT_FOLDERS,
  onNewThreadInFolder,
  workspaceColors,
  hiddenWorkspaceIds = EMPTY_HIDDEN_WORKSPACE_IDS,
}: SidebarViewProps) {
  const workspaceIconSrc = useWorkspaceIcons(groups, !isVisible);
  const [folderEditor, setFolderEditor] = useState<{ workspaceId: string; folder?: ProjectFolder } | null>(null);
  const [folderMoveTarget, setFolderMoveTarget] = useState<{ workspaceId: string; threadId: string } | null>(null);
  const [isFolderPaging, setIsFolderPaging] = useState(false);
  const performFolderMutation = useCallback((mutation: ProjectFolderMutation) => {
    void mutateProjectFolder(mutation).catch((error: unknown) => Alert.alert('Could not update folder',
      error instanceof Error ? error.message : 'Please try again'));
  }, []);
  const [workspaceOptions, setWorkspaceOptions] = useState<{
    workspaceId: string;
    workspaceName: string;
  } | null>(null);
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  // Cached projects stay on screen while a reconnect snapshot is in flight.
  // Page requests continue after the initial snapshot is ready.
  const syncStatus = useSessionSyncStatus();
  const remoteCounts = syncIndex?.counts;
  // Rows only repaint when their own inputs move, and an idle thread's summary
  // never does — without this the "9h" a row was born with is still there a
  // day later. It reaches the cells through renderRow (the list's extraData).
  const nowTick = useRelativeTimeTick(!isVisible);

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
    () => new Set(),
  );
  const [chatsCollapsed, setChatsCollapsed] = useState(readStoredChatsCollapsed);
  const [visibleThreadCounts, setVisibleThreadCounts] = useState<
    Map<string, number>
  >(() => new Map());
  const [optionsTarget, setOptionsTarget] = useState<{
    workspaceId: string;
    thread: ThreadSummary;
  } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [sortMode, setSortMode] = useState<ThreadSortMode>(readStoredThreadSort);
  const [extensionFilterSelections, setExtensionFilterSelections] = useState<
    Map<string, ReadonlySet<string>>
  >(() => new Map());

  const supportedExtensionFilters = useMemo(
    () =>
      extensionSidebarFilters.flatMap((definition) => {
        const document = definition.document;
        if (document?.root.type !== "select") return [];
        if (
          definition.extensionId !== THREAD_TAGS_EXTENSION_ID ||
          threadTagOptions.length === 0
        ) {
          return [definition];
        }
        return [
          {
            ...definition,
            document: {
              ...document,
              root: {
                ...document.root,
                options: threadTagOptions.map((stage) => ({
                  value: stage.id,
                  label: stage.label,
                  tone: extensionUiTone(stage.color),
                })),
              },
            },
          },
        ];
      }),
    [extensionSidebarFilters, threadTagOptions],
  );
  const activeExtensionFilters = useMemo(
    () =>
      supportedExtensionFilters.flatMap(
        (definition): ActiveExtensionThreadFilter[] => {
          const root = definition.document?.root;
          if (!root || root.type !== "select") return [];
          return [
            {
              key: definition.key,
              extensionId: definition.extensionId,
              binding: root.binding,
              selectedValues:
                extensionFilterSelections.get(definition.key) ?? new Set(),
            },
          ];
        },
      ),
    [extensionFilterSelections, supportedExtensionFilters],
  );
  const displayGroups = useMemo(
    () =>
      filterProjectGroupsByExtensions(
        groups,
        extensionSnapshot,
        activeExtensionFilters,
      ),
    [activeExtensionFilters, extensionSnapshot, groups],
  );
  const hiddenWorkspaceIdSet = useMemo(
    () => new Set(hiddenWorkspaceIds),
    [hiddenWorkspaceIds],
  );
  // A thread filter can drop a hidden project before any of its rows load.
  // Keep the reveal control based on the unfiltered project list.
  const hiddenProjectCount = groups.filter(
    (group) =>
      group.workspace.kind !== "casual" &&
      hiddenWorkspaceIdSet.has(group.workspace.id),
  ).length;
  useEffect(() => {
    if (hiddenProjectCount === 0) setShowHiddenProjects(false);
  }, [hiddenProjectCount]);
  const listedGroups = useMemo(
    () =>
      showHiddenProjects
        ? displayGroups
        : displayGroups.filter(
            (group) =>
              group.workspace.kind === "casual" ||
              !hiddenWorkspaceIdSet.has(group.workspace.id),
          ),
    [displayGroups, hiddenWorkspaceIdSet, showHiddenProjects],
  );
  const activeExtensionFilterCount = useMemo(
    () =>
      activeExtensionFilters.reduce(
        (count, filter) => count + filter.selectedValues.size,
        0,
      ),
    [activeExtensionFilters],
  );

  const [overflowLoading, setOverflowLoading] = useState<ReadonlySet<string>>(new Set());
  const [isPaging, setIsPaging] = useState(false);
  const pagingRunRef = useRef(0);
  const loadPage = useCallback(async (workspaceId: string, sort: ThreadSortMode, limit?: number) => {
    await loadSyncThreadPage(workspaceId, sort, limit);
  }, []);

  // Fetch one bounded page per expanded scope. Filters need complete scope,
  // so continue one page at a time, yielding between store commits.
  const pageScopes = groups
    .filter(
      (group) =>
        (group.workspace.kind === "casual" ||
          showHiddenProjects ||
          !hiddenWorkspaceIdSet.has(group.workspace.id)) &&
        (group.workspace.kind === "casual"
          ? !chatsCollapsed
          : !collapsedWorkspaces.has(group.workspace.id)),
    )
    .map((group) => group.workspace.id)
    .join("\n");
  useEffect(() => {
    if (!isVisible || !syncIndex?.token) {
      setIsPaging(false);
      return;
    }
    let cancelled = false;
    const run = ++pagingRunRef.current;
    const token = syncIndex.token;
    void (async () => {
      try {
        for (const workspaceId of pageScopes.split("\n").filter(Boolean)) {
          while (!cancelled) {
            const current = useSessionStore.getState().snapshot?.sync_index;
            if (!current || current.token !== token) return;
            const cursor = current.cursors[`${workspaceId}:${sortMode}`];
            if (cursor === null || (cursor !== undefined && !activeExtensionFilterCount)) break;
            setIsPaging(true);
            await loadPage(workspaceId, sortMode, activeExtensionFilterCount ? 50 : VISIBLE_THREAD_LIMIT);
            const next = useSessionStore.getState().snapshot?.sync_index;
            if (next?.token !== token || next.cursors[`${workspaceId}:${sortMode}`] === cursor) break;
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      } finally {
        if (!cancelled && pagingRunRef.current === run) setIsPaging(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isVisible, syncIndex?.token, pageScopes, sortMode, activeExtensionFilterCount, loadPage]);

  // Starting a thread should never depend on first finding a project row: the
  // open one is the obvious target, and the top of the list stands in before
  // anything is selected.
  const newThreadWorkspaceId = useMemo(() => {
    const selected = listedGroups.some(
      (group) => group.workspace.id === selectedWorkspaceId,
    )
      ? selectedWorkspaceId
      : null;
    return selected ?? listedGroups[0]?.workspace.id ?? null;
  }, [listedGroups, selectedWorkspaceId]);

  const expandedFolderScopes = projectFolders
    .filter(
      (folder) =>
        !folder.collapsed &&
        !collapsedWorkspaces.has(folder.workspace_id) &&
        listedGroups.some((group) => group.workspace.id === folder.workspace_id),
    )
    .map((folder) => `${folder.workspace_id}\t${folder.id}`)
    .join("\n");
  useEffect(() => {
    if (!isVisible || !syncIndex?.token || !expandedFolderScopes) {
      setIsFolderPaging(false);
      return;
    }
    let cancelled = false;
    const token = syncIndex.token;
    void (async () => {
      setIsFolderPaging(true);
      try {
        for (const scope of expandedFolderScopes.split("\n")) {
          const [workspaceId, folderId] = scope.split("\t");
          const key = `${workspaceId}:folder:${folderId}:${sortMode}`;
          while (!cancelled) {
            const index = useSessionStore.getState().snapshot?.sync_index;
            if (index?.token !== token || index.cursors[key] === null) break;
            const previous = index.cursors[key];
            await loadSyncProjectFolderPage(workspaceId, folderId, sortMode);
            const next = useSessionStore.getState().snapshot?.sync_index;
            if (next?.token !== token || next.cursors[key] === previous) break;
          }
        }
      } catch (error) {
        if (!cancelled)
          Alert.alert(
            "Could not load folder",
            error instanceof Error ? error.message : "Please try again",
          );
      } finally {
        if (!cancelled) setIsFolderPaging(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isVisible, syncIndex?.token, expandedFolderScopes, sortMode]);

  const builtRows = useMemo(
    () =>
      buildSidebarRows(
        listedGroups,
        collapsedWorkspaces,
        visibleThreadCounts,
        selectedThreadId,
        sortMode,
        Boolean(onNewChat),
        chatsCollapsed,
        activeExtensionFilterCount ? undefined : remoteCounts,
        syncIndex?.cursors,
        hiddenProjectCount > 0,
        listedGroups,
        projectFolders,
      ),
    [
      listedGroups,
      projectFolders,
      collapsedWorkspaces,
      visibleThreadCounts,
      selectedThreadId,
      sortMode,
      onNewChat,
      chatsCollapsed,
      remoteCounts,
      syncIndex?.cursors,
      activeExtensionFilterCount,
      hiddenProjectCount,
    ],
  );
  // Selecting a visible thread rebuilds builtRows with identical content;
  // keeping the previous array identity spares FlashList a whole-list data
  // change during the drawer-close/navigation frame. Selection highlights
  // repaint through extraData below.
  const previousRowsRef = useRef(builtRows);
  const rows = sidebarRowsEqual(previousRowsRef.current, builtRows)
    ? previousRowsRef.current
    : builtRows;
  previousRowsRef.current = rows;

  const handleExtensionFilterChange = useCallback(
    (key: string, values: ReadonlySet<string>) => {
      setExtensionFilterSelections((current) => {
        const next = new Map(current);
        next.set(key, values);
        return next;
      });
    },
    [],
  );

  const clearExtensionFilters = useCallback(() => {
    setExtensionFilterSelections(new Map());
  }, []);

  const handleSortChange = useCallback((value: string) => {
    if (!isThreadSortMode(value)) return;
    setSortMode(value);
    writeStoredThreadSort(value);
    setSortOpen(false);
  }, []);

  const canStartNew = Boolean(onNewChat || newThreadWorkspaceId);
  const hasFloatingDock = canStartNew || Boolean(onOpenSettings);
  // The controls float over the list like the native ChatGPT drawer, so reserve
  // their painted height, the safe area, and one quiet row of breathing room.
  const listContentStyle = useMemo(
    () => ({
      paddingTop: theme.spacing[3],
      paddingBottom: hasFloatingDock
        ? FLOATING_ACTION_HEIGHT +
          Math.max(insets.bottom, theme.spacing[3]) +
          theme.spacing[4]
        : theme.spacing[3] + insets.bottom,
    }),
    [hasFloatingDock, insets.bottom, theme.spacing],
  );

  const toggleWorkspaceCollapse = useCallback((workspaceId: string) => {
    triggerProjectToggleHaptic();
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  const toggleProjectsCollapsed = useCallback(() => {
    triggerProjectToggleHaptic();
    setCollapsedWorkspaces((current) => {
      const projects = listedGroups.filter(({ workspace }) => workspace.kind !== "casual");
      const allCollapsed = projects.every(({ workspace }) => current.has(workspace.id));
      const next = new Set(current);
      for (const { workspace } of projects) {
        if (allCollapsed) next.delete(workspace.id);
        else next.add(workspace.id);
      }
      return next;
    });
  }, [listedGroups]);

  const toggleChatsCollapsed = useCallback(() => {
    setChatsCollapsed((current) => {
      const next = !current;
      writeStoredChatsCollapsed(next);
      return next;
    });
  }, []);

  const handleOverflowPress = useCallback(
    (workspaceId: string, visibleCount: number, isExpanded: boolean) => {
      if (!isExpanded) {
        const key = `${useSessionStore.getState().snapshot?.sync_index?.token}:${workspaceId}:${sortMode}`;
        const joined = isSyncThreadPageInFlight(workspaceId, sortMode);
        setOverflowLoading((current) => new Set(current).add(key));
        void (async () => {
          try {
            await loadPage(workspaceId, sortMode, SHOW_MORE_STEP);
            if (!joined) return;
            const cursor = useSessionStore.getState().snapshot?.sync_index?.cursors[`${workspaceId}:${sortMode}`];
            if (cursor === null || cursor === undefined) return;
            await loadPage(workspaceId, sortMode, SHOW_MORE_STEP);
          } finally {
            setOverflowLoading((current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            });
          }
        })();
      }
      setVisibleThreadCounts((prev) => {
        const next = new Map(prev);
        if (isExpanded) {
          next.delete(workspaceId);
        } else {
          next.set(workspaceId, visibleCount + SHOW_MORE_STEP);
        }
        return next;
      });
    },
    [sortMode, loadPage],
  );

  const openThreadOptions = useCallback(
    (workspaceId: string, thread: ThreadSummary) => {
      void Haptics.selectionAsync();
      setOptionsTarget({ workspaceId, thread });
    },
    [],
  );

  const closeThreadOptions = useCallback(() => {
    setOptionsTarget(null);
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: SidebarRow }) => {
      if (item.type === "section") {
        const sectionCollapsible = item.isOpen != null;
        const isProjects = item.title === "Projects";
        return (
          <View style={styles.sectionHeading}>
            {/* Explicitly 400: the bundled Geist has only Regular and Bold, so
                RN resolves any in-between weight to the nearest real face.
                Naming the weight we actually have keeps this row off that
                rounding edge — see docs/MARKDOWN_STYLE.md. */}
            {sectionCollapsible ? (
              <Pressable
                style={({ pressed }) => [
                  styles.sectionHeadingToggle,
                  pressed ? styles.filterButtonPressed : undefined,
                ]}
                onPress={isProjects ? toggleProjectsCollapsed : toggleChatsCollapsed}
                accessibilityRole="button"
                accessibilityLabel={
                  `${item.isOpen ? "Collapse" : "Expand"} ${isProjects ? "projects" : "chats"}`
                }
                accessibilityHint={
                  isProjects
                    ? "Toggles all project contents; project names stay visible"
                    : item.isOpen ? "Hides individual chats" : "Shows individual chats"
                }
                accessibilityState={{ expanded: item.isOpen }}
              >
                <Text variant="caption" color="muted" weight="normal">
                  {item.title.toUpperCase()}
                </Text>
                <ChevronDown
                  size={12}
                  color={theme.colors.fg.muted}
                  style={
                    item.isOpen ? undefined : styles.sectionChevronCollapsed
                  }
                />
              </Pressable>
            ) : (
              <Text variant="caption" color="muted" weight="normal">
                {item.title.toUpperCase()}
              </Text>
            )}
            {item.title === "Chats" && onNewChat ? (
              <Pressable
                style={({ pressed }) => [
                  styles.filterButton,
                  pressed ? styles.filterButtonPressed : undefined,
                ]}
                onPress={() => void onNewChat()}
                accessibilityRole="button"
                accessibilityLabel="Start new chat"
              >
                <Plus
                  size={theme.iconSize.xs}
                  color={theme.colors.fg.muted}
                />
              </Pressable>
            ) : item.title === "Projects" ? (
              <View style={styles.sectionActions}>
                {hiddenProjectCount > 0 ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.filterButton,
                      showHiddenProjects ? styles.filterButtonActive : undefined,
                      pressed ? styles.filterButtonPressed : undefined,
                    ]}
                    onPress={() => setShowHiddenProjects((current) => !current)}
                    accessibilityRole="button"
                    accessibilityLabel={
                      showHiddenProjects
                        ? "Hide hidden projects"
                        : `Show hidden projects (${hiddenProjectCount})`
                    }
                    accessibilityState={{ selected: showHiddenProjects }}
                  >
                    {showHiddenProjects ? (
                      <EyeOff size={theme.iconSize.xs} color={theme.colors.accent.default} />
                    ) : (
                      <Eye size={theme.iconSize.xs} color={theme.colors.fg.muted} />
                    )}
                  </Pressable>
                ) : null}
                <Pressable
                  style={({ pressed }) => [
                    styles.filterButton,
                    sortMode !== "last_updated"
                      ? styles.filterButtonActive
                      : undefined,
                    pressed ? styles.filterButtonPressed : undefined,
                  ]}
                  onPress={() => setSortOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Sort chats"
                  accessibilityHint={`Currently ${
                    THREAD_SORT_OPTIONS.find((option) => option.mode === sortMode)
                      ?.label ?? "Last updated"
                  }`}
                  accessibilityState={{
                    selected: sortMode !== "last_updated",
                  }}
                >
                  <ArrowUpDown
                    size={theme.iconSize.xs}
                    color={
                      sortMode !== "last_updated"
                        ? theme.colors.accent.default
                        : theme.colors.fg.muted
                    }
                  />
                </Pressable>
                {supportedExtensionFilters.length > 0 ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.filterButton,
                      activeExtensionFilterCount > 0
                        ? styles.filterButtonActive
                        : undefined,
                      pressed ? styles.filterButtonPressed : undefined,
                    ]}
                    onPress={() => setFiltersOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Filter threads"
                    accessibilityHint={
                      activeExtensionFilterCount > 0
                        ? `${activeExtensionFilterCount} selected`
                        : "Filter threads by stage"
                    }
                    accessibilityState={{
                      selected: activeExtensionFilterCount > 0,
                    }}
                  >
                    <ListFilter
                      size={theme.iconSize.xs}
                      color={
                        activeExtensionFilterCount > 0
                          ? theme.colors.accent.default
                          : theme.colors.fg.muted
                      }
                    />
                    {activeExtensionFilterCount > 0 ? (
                      <Text
                        variant="caption"
                        size="2xs"
                        color="accent"
                        weight="semibold"
                      >
                        {activeExtensionFilterCount}
                      </Text>
                    ) : null}
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      }

      if (item.type === "workspace") {
        const accent = workspaceCatColor(
          theme.colors.cat,
          workspaceColors?.[item.workspaceId],
        );
        const isNewConversationProject =
          selectedThreadId === null && item.workspaceId === selectedWorkspaceId;
        // Two sibling controls, not a button inside a button: nesting them made
        // VoiceOver read the row as one element and swallowed "new thread".
        // The name always collapses/expands; moving a new conversation to a
        // project is the pen button's job, so a tap never leaves the drawer.
        return (
          <View
            style={[
              styles.workspaceHeader,
              hiddenWorkspaceIdSet.has(item.workspaceId)
                ? styles.hiddenWorkspace
                : undefined,
            ]}
          >
            <Pressable
              style={styles.workspaceLeft}
              onPress={() => toggleWorkspaceCollapse(item.workspaceId)}
              onLongPress={() => {
                void Haptics.selectionAsync()
                setWorkspaceOptions({
                  workspaceId: item.workspaceId,
                  workspaceName: item.workspaceName,
                })
              }}
              accessibilityRole="button"
              accessibilityLabel={item.workspaceName}
              accessibilityHint={
                item.isOpen
                  ? "Collapses this project. Double tap and hold for project options"
                  : "Expands this project. Double tap and hold for project options"
              }
              accessibilityState={{
                expanded: item.isOpen,
                ...(selectedThreadId === null
                  ? { selected: isNewConversationProject }
                  : {}),
              }}
            >
              {workspaceIconSrc(item.workspaceId) ? (
                <Image
                  source={{ uri: workspaceIconSrc(item.workspaceId)! }}
                  style={styles.workspaceFavicon}
                  contentFit="contain"
                  accessibilityIgnoresInvertColors
                />
              ) : item.isOpen ? (
                <FolderOpen
                  size={theme.iconSize.xs}
                  color={accent ?? theme.colors.fg.muted}
                />
              ) : (
                <FolderClosed
                  size={theme.iconSize.xs}
                  color={accent ?? theme.colors.fg.muted}
                />
              )}
              <Text
                variant="body"
                color="secondary"
                weight="normal"
                numberOfLines={1}
                style={[styles.workspaceName, accent ? { color: accent } : null]}
              >
                {item.workspaceName}
              </Text>
              {/* Collapsed projects hide every thread row, so the rollup rides
                  here instead: live work first, then what is waiting. */}
              {!item.isOpen && (item.runningCount > 0 || item.unreadCount > 0) ? (
                <View style={styles.workspaceCounts}>
                  {item.runningCount > 0 ? (
                    <View style={styles.workspaceCount}>
                      <ActivityDiamond
                        size={10}
                        color={theme.colors.accent.default}
                      />
                      <Text variant="meta" color="muted">
                        {item.runningCount}
                      </Text>
                    </View>
                  ) : null}
                  {item.unreadCount > 0 ? (
                    <View style={styles.workspaceCount}>
                      <View
                        style={[
                          styles.workspaceCountDot,
                          {
                            backgroundColor:
                              item.unreadTone === "danger"
                                ? theme.colors.danger.default
                                : item.unreadTone === "warning"
                                  ? theme.colors.warning.default
                                  : theme.colors.unread,
                          },
                        ]}
                      />
                      <Text variant="meta" color="muted">
                        {item.unreadCount}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </Pressable>
            <Button variant="ghost" size="icon" accessibilityLabel={`Create folder in ${item.workspaceName}`}
              onPress={() => setFolderEditor({ workspaceId: item.workspaceId })}>
              <FolderPlus size={theme.iconSize.xs} color={theme.colors.fg.muted} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel={`New thread in ${item.workspaceName}`}
              onPress={() => onNewThread(item.workspaceId)}
            >
              <SquarePen
                size={theme.iconSize.xs}
                color={theme.colors.fg.muted}
              />
            </Button>
          </View>
        );
      }

      if (item.type === 'folder') {
        return <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
          <View style={styles.folderHeader}>
            <Pressable style={styles.workspaceLeft} accessibilityRole="button" accessibilityLabel={item.folder.name}
              accessibilityState={{ expanded: !item.folder.collapsed }} accessibilityHint="Double tap and hold for folder options"
              onPress={() => performFolderMutation({ action: 'set_collapsed', workspace_id: item.workspaceId, folder_id: item.folder.id, collapsed: !item.folder.collapsed })}
              onLongPress={() => setFolderEditor({ workspaceId: item.workspaceId, folder: item.folder })}>
              <ChevronDown size={theme.iconSize.xs} color={theme.colors.fg.muted} style={item.folder.collapsed ? styles.sectionChevronCollapsed : undefined} />
              {item.folder.collapsed ? <FolderClosed size={theme.iconSize.xs} color={theme.colors.fg.muted} /> : <FolderOpen size={theme.iconSize.xs} color={theme.colors.fg.muted} />}
              <Text variant="body" color="secondary" numberOfLines={1} style={styles.workspaceName}>{item.folder.name}</Text>
              <Text variant="meta" color="muted">{item.count}</Text>
            </Pressable>
            {onNewThreadInFolder ? <Button variant="ghost" size="icon" accessibilityLabel={`New task in ${item.folder.name}`}
              onPress={() => { void onNewThreadInFolder(item.workspaceId, item.folder.id).catch((error: unknown) => Alert.alert('Could not create task', error instanceof Error ? error.message : 'Please try again')); }}>
              <SquarePen size={theme.iconSize.xs} color={theme.colors.fg.muted} />
            </Button> : null}
          </View>
        </CollapsibleRow>;
      }

      if (item.type === "overflow") {
        const overflowLabel = item.isExpanded ? "Show less" : "Show more";
        const isLoading = overflowLoading.has(`${syncIndex?.token}:${item.workspaceId}:${sortMode}`);
        return (
          <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
            <Pressable
              style={styles.overflowRow}
              onPress={() =>
                item.folderId ? setVisibleThreadCounts((current) => {
                  const next = new Map(current);
                  next.set(`folder:${item.folderId}`, item.isExpanded ? VISIBLE_THREAD_LIMIT : item.visibleCount + SHOW_MORE_STEP);
                  return next;
                }) : handleOverflowPress(
                  item.workspaceId,
                  item.visibleCount,
                  item.isExpanded,
                )
              }
              accessibilityRole="button"
              accessibilityLabel={overflowLabel}
              disabled={isLoading}
              accessibilityState={{ expanded: item.isExpanded, busy: isLoading, disabled: isLoading }}
            >
              {isLoading ? (
                <ActivityDiamond size={theme.iconSize.xs} color={theme.colors.fg.muted} />
              ) : (
                <ChevronDown
                  size={12}
                  color={theme.colors.fg.muted}
                  style={item.isExpanded ? styles.chevronFlipped : undefined}
                />
              )}
              <Text variant="supporting" color="muted">
                {overflowLabel}
              </Text>
            </Pressable>
          </CollapsibleRow>
        );
      }

      return (
        <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
          <View style={item.folderId ? styles.folderContent : undefined}>
          <SessionListItem
            thread={item.thread}
            workspaceId={item.workspaceId}
            isSelected={selectedThreadId === item.thread.id}
            onSelectThread={onSelectThread}
            onOpenThreadOptions={openThreadOptions}
            nowTick={nowTick}
            tags={threadTagsById?.[item.thread.id]}
            depth={item.depth}
            trunkMask={item.trunkMask}
          />
          </View>
        </CollapsibleRow>
      );
    },
    [
      nowTick,
      onNewThread,
      onNewThreadInFolder,
      performFolderMutation,
      onNewChat,
      onSelectThread,
      openThreadOptions,
      selectedThreadId,
      selectedWorkspaceId,
      theme.colors.cat,
      theme.colors.danger.default,
      theme.colors.fg.muted,
      theme.colors.unread,
      theme.colors.warning.default,
      theme.iconSize.xs,
      toggleWorkspaceCollapse,
      toggleChatsCollapsed,
      toggleProjectsCollapsed,
      handleOverflowPress,
      overflowLoading,
      syncIndex?.token,
      threadTagsById,
      workspaceColors,
      hiddenWorkspaceIdSet,
      hiddenProjectCount,
      showHiddenProjects,
      workspaceIconSrc,
      activeExtensionFilterCount,
      supportedExtensionFilters.length,
      sortMode,
      theme.colors.accent.default,
    ],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* The title stays even when there is nothing to close: it keeps the
          panel's top edge on the same line as the conversation header. */}
      <View style={styles.header}>
        <Text variant="heading" size="2xl" weight="bold" color="primary" maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE} style={styles.headerTitle}>
          Tasks
        </Text>
        {onClose ? (
          <GlassButton
            onPress={onClose}
            accessibilityLabel="Close sidebar"
            hitSlop={4}
          >
            <SymbolIcon name="xmark" fallback={X} size={16} weight="semibold" color={theme.colors.fg.primary} />
          </GlassButton>
        ) : null}
      </View>

      {onOpenActivity ? (
        <Pressable
          style={({ pressed }) => [
            styles.activityButton,
            activityOpen ? styles.activityButtonActive : pressed ? styles.activityButtonPressed : null,
          ]}
          onPress={onOpenActivity}
          accessibilityRole="button"
          accessibilityLabel="Activity"
          accessibilityHint="Tasks that need you, finished work, and what is running, across all projects"
          accessibilityState={{ selected: activityOpen }}
        >
          <View style={[styles.activityGlyph, activityOpen ? styles.activityGlyphActive : null]}>
            <SymbolIcon
              name="tray.full"
              fallback={Inbox}
              size={16}
              color={activityOpen ? theme.colors.accent.default : theme.colors.fg.secondary}
            />
          </View>
          <View style={styles.activityCopy}>
            <Text variant="label" weight="medium" color={activityOpen ? "accent" : "primary"}>Activity</Text>
            <Text variant="meta" color="muted">Across all projects</Text>
          </View>
          <SymbolIcon
            name="chevron.right"
            fallback={ChevronRight}
            size={12}
            weight="semibold"
            color={theme.colors.fg.faint}
          />
        </Pressable>
      ) : null}
      <SyncBanner status={syncStatus} />

      <View style={styles.list}>
        {rows.length === 0 ? (
          // Cached rows render above. With nothing on disk yet, stay quiet
          // while a sync is in flight — the banner names a wait that lasts.
          // 'offline' is a dead end rather than a wait, so it keeps the
          // regular empty state.
          activeExtensionFilterCount > 0 ? (
            <View style={styles.filteredEmptyState}>
              <EmptyState
                title="No matching threads"
                description="Try clearing one or more filters"
              />
              <Button
                variant="ghost"
                label="Change filters"
                onPress={() => setFiltersOpen(true)}
              />
            </View>
          ) : syncStatus.isBusy && syncStatus.stage !== "offline" ? null : (
            <EmptyState
              title="No projects"
              description="Connect from your desktop to get started"
            />
          )
        ) : (
          <FlashList
            data={rows}
            renderItem={renderRow}
            // renderRow closes over selection/tags/colors; with row identity
            // now stable across selection changes, this is what tells the
            // list to repaint visible cells when any of those inputs move.
            extraData={renderRow}
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.type}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={listContentStyle}
            // Collapsing a section rewrites the heights of rows *above* the
            // viewport, which visible-content anchoring answers by shifting
            // the scroll offset — that is the blank stretch at the top until
            // the next scroll forces a re-layout. A drawer list has no feed
            // semantics to preserve, so anchor to the plain offset instead.
            maintainVisibleContentPosition={{ disabled: true }}
          />
        )}
        {/* Rows soften as they scroll up under the Activity row. */}
        <ScrollEdge edge="top" height={theme.spacing[4]} color={theme.colors.surface[1]} />
        <LoadingPill
          visible={!syncStatus.isBusy && (isPaging || isFolderPaging)}
          label="Loading tasks…"
          accessibilityLabel="Loading tasks"
        />
      </View>

      {hasFloatingDock ? (
        <>
          {/* The list fades into the panel behind the floating controls. */}
          <ScrollEdge
            edge="bottom"
            color={theme.colors.surface[1]}
            height={FLOATING_ACTION_HEIGHT + Math.max(insets.bottom, theme.spacing[3]) + theme.spacing[6]}
            solid={Math.max(insets.bottom, theme.spacing[3]) * 0.6}
          />
          <View
            style={[
              styles.floatingDock,
              { bottom: Math.max(insets.bottom - 6, theme.spacing[3]) },
            ]}
            pointerEvents="box-none"
          >
            {canStartNew ? (
              <GlassButton
                shape="pill"
                size={FLOATING_ACTION_HEIGHT}
                tint={theme.colors.accent.default}
                style={styles.floatingNewButton}
                onPress={() => {
                  if (onNewChat) void onNewChat();
                  else if (newThreadWorkspaceId) onNewThread(newThreadWorkspaceId);
                }}
                accessibilityLabel={onNewChat ? "New chat" : "New thread"}
                accessibilityHint={
                  onNewChat
                    ? "Starts a conversation outside a project"
                    : "Starts a conversation in the open project"
                }
              >
                <SymbolIcon
                  name="square.and.pencil"
                  fallback={SquarePen}
                  size={21}
                  weight="medium"
                  color={theme.colors.surface[0]}
                />
                <Text
                  variant="label"
                  size="md"
                  weight="semibold"
                  style={styles.floatingNewLabel}
                  maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}
                >
                  New
                </Text>
              </GlassButton>
            ) : null}

            {onOpenSettings ? (
              <GlassButton
                size={FLOATING_ACTION_HEIGHT}
                style={styles.floatingSettingsButton}
                onPress={onOpenSettings}
                accessibilityLabel="Settings"
                accessibilityHint="Opens mobile settings and automations"
                accessibilityState={{ selected: settingsOpen }}
              >
                <SymbolIcon
                  name={settingsOpen ? "gearshape.fill" : "gearshape"}
                  fallback={Settings}
                  size={23}
                  color={theme.colors.fg.primary}
                />
              </GlassButton>
            ) : null}
          </View>
        </>
      ) : null}

      {optionsTarget ? (
        <ThreadOptionsSheet
          workspaceId={optionsTarget.workspaceId}
          thread={optionsTarget.thread}
          onMoveToFolder={projectFolders.some((folder) => folder.workspace_id === optionsTarget.workspaceId) ? () => {
            setFolderMoveTarget({ workspaceId: optionsTarget.workspaceId, threadId: optionsTarget.thread.id });
            setOptionsTarget(null);
          } : undefined}
          onClose={closeThreadOptions}
        />
      ) : null}

      {folderEditor ? <ProjectFolderSheet key={folderEditor.folder?.id ?? folderEditor.workspaceId}
        workspaceId={folderEditor.workspaceId} folder={folderEditor.folder} onNewTask={onNewThreadInFolder} onClose={() => setFolderEditor(null)} /> : null}
      {folderMoveTarget ? <ProjectFolderPickerSheet workspaceId={folderMoveTarget.workspaceId} threadId={folderMoveTarget.threadId}
        folders={projectFolders} onClose={() => setFolderMoveTarget(null)} /> : null}

      {workspaceOptions ? (
        <WorkspaceOptionsSheet
          workspaceId={workspaceOptions.workspaceId}
          workspaceName={workspaceOptions.workspaceName}
          isHidden={hiddenWorkspaceIdSet.has(workspaceOptions.workspaceId)}
          onClose={() => setWorkspaceOptions(null)}
        />
      ) : null}

      {filtersOpen ? (
        <ExtensionFilterSheet
          definitions={supportedExtensionFilters}
          selections={extensionFilterSelections}
          onChange={handleExtensionFilterChange}
          onClearAll={clearExtensionFilters}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}

      {sortOpen ? (
        <OptionSheet
          title="Sort chats by"
          items={SORT_SHEET_ITEMS}
          selected={sortMode}
          onSelect={handleSortChange}
          onClose={() => setSortOpen(false)}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  folderHeader: { flexDirection: 'row', alignItems: 'center', paddingLeft: theme.spacing[6], paddingRight: theme.spacing[2], minHeight: theme.minTouchTarget },
  folderContent: { paddingLeft: theme.spacing[4] },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[1],
  },
  activityButton: {
    minHeight: 52,
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
  },
  activityButtonActive: {
    backgroundColor: theme.colors.accent.muted,
  },
  activityButtonPressed: {
    backgroundColor: theme.isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(9, 9, 11, 0.045)",
  },
  activityGlyph: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface[3],
  },
  activityGlyphActive: {
    backgroundColor: theme.colors.accent.muted,
  },
  activityCopy: {
    flex: 1,
    gap: 1,
  },
  list: {
    flex: 1,
  },
  filteredEmptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  // Same height and inset as the conversation's floating header row, so the
  // panel's title and close button sit where the sidebar button was.
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: GLASS_ROW_HEIGHT,
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[4],
  },
  headerTitle: {
    letterSpacing: -0.4,
  },
  floatingDock: {
    position: "absolute",
    left: 0,
    right: 0,
    height: FLOATING_ACTION_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
  },
  floatingNewButton: {
    position: "absolute",
    left: theme.spacing[4],
    minWidth: 140,
  },
  floatingNewLabel: { color: theme.colors.surface[0] },
  floatingSettingsButton: {
    position: "absolute",
    right: theme.spacing[4],
  },
  workspaceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  hiddenWorkspace: {
    opacity: 0.6,
  },
  sectionHeading: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  sectionHeadingToggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: theme.minTouchTarget,
  },
  sectionChevronCollapsed: {
    transform: [{ rotate: "-90deg" }],
  },
  sectionActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  filterButton: {
    minWidth: theme.minTouchTarget,
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.radius.full,
  },
  filterButtonActive: {
    backgroundColor: theme.colors.accent.muted,
  },
  filterButtonPressed: {
    backgroundColor: theme.colors.surface[3],
  },
  workspaceFavicon: {
    width: theme.iconSize.xs,
    height: theme.iconSize.xs,
    borderRadius: 3,
  },
  workspaceLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // The row is the whole tap target for collapsing, so it carries the
    // minimum height rather than the header wrapper around it.
    minHeight: theme.minTouchTarget,
  },
  workspaceName: {
    flex: 1,
  },
  workspaceCounts: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  workspaceCount: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workspaceCountDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
  },
  overflowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[4],
    marginLeft: theme.spacing[3],
  },
  chevronFlipped: {
    transform: [{ rotate: "180deg" }],
  },
}));
