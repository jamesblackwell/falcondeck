import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { FlashList } from "@shopify/flash-list";
import {
  ArrowUpDown,
  ChevronDown,
  FolderClosed,
  FolderOpen,
  ListFilter,
  Plus,
  Settings,
  SquarePen,
  X,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";

import type {
  ActiveExtensionThreadFilter,
  ExtensionSidebarFilterDefinition,
  ExtensionSnapshot,
  ExtensionUiTone,
  ProjectGroup,
  ThreadSortMode,
  ThreadSummary,
  ThreadTag,
} from "@falcondeck/client-core";
import {
  filterProjectGroupsByExtensions,
  isThreadSortMode,
  isWorkspaceColorId,
  sortProjectGroupThreads,
  THREAD_SORT_OPTIONS,
  THREAD_TAGS_EXTENSION_ID,
} from "@falcondeck/client-core";

import {
  Text,
  Button,
  EmptyState,
  OptionSheet,
  SyncBanner,
} from "@/components/ui";
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
import {
  buildSidebarRows,
  SHOW_MORE_STEP,
  type SidebarRow,
} from "./sidebarRows";
import { ThreadOptionsSheet } from "./ThreadOptionsSheet";
import { ExtensionFilterSheet } from "./ExtensionFilterSheet";

interface SidebarViewProps {
  groups: ProjectGroup[];
  /** Target for the top-level "New thread" row, before any per-project pick. */
  selectedWorkspaceId?: string | null;
  selectedThreadId: string | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onNewThread: (workspaceId: string) => void;
  onNewChat?: () => Promise<void> | void;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  /** Dismisses the drawer; the full-width sidebar leaves no scrim to tap. */
  onClose?: () => void;
  threadTagsById?: Record<string, ThreadTag[]>;
  threadTagOptions?: readonly ThreadTag[];
  extensionSnapshot?: ExtensionSnapshot | null;
  extensionSidebarFilters?: readonly ExtensionSidebarFilterDefinition[];
  workspaceColors?: Record<string, string>;
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

const FLOATING_ACTION_HEIGHT = 60;

export const SidebarView = memo(function SidebarView({
  groups,
  selectedWorkspaceId = null,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onNewChat,
  onOpenSettings,
  settingsOpen = false,
  onClose,
  threadTagsById,
  threadTagOptions = [],
  extensionSnapshot,
  extensionSidebarFilters = [],
  workspaceColors,
}: SidebarViewProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  // Cached projects stay on screen while a reconnect snapshot is in flight.
  // The banner is the only extra voice if that wait actually drags.
  const syncStatus = useSessionSyncStatus();

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
      sortProjectGroupThreads(
        filterProjectGroupsByExtensions(
          groups,
          extensionSnapshot,
          activeExtensionFilters,
        ),
        sortMode,
      ),
    [activeExtensionFilters, extensionSnapshot, groups, sortMode],
  );
  const activeExtensionFilterCount = useMemo(
    () =>
      activeExtensionFilters.reduce(
        (count, filter) => count + filter.selectedValues.size,
        0,
      ),
    [activeExtensionFilters],
  );

  // Starting a thread should never depend on first finding a project row: the
  // open one is the obvious target, and the top of the list stands in before
  // anything is selected.
  const newThreadWorkspaceId = useMemo(() => {
    const selected = displayGroups.some(
      (group) => group.workspace.id === selectedWorkspaceId,
    )
      ? selectedWorkspaceId
      : null;
    return selected ?? displayGroups[0]?.workspace.id ?? null;
  }, [displayGroups, selectedWorkspaceId]);

  const rows = useMemo(
    () =>
      buildSidebarRows(
        displayGroups,
        collapsedWorkspaces,
        visibleThreadCounts,
        selectedThreadId,
        sortMode,
        Boolean(onNewChat),
        chatsCollapsed,
      ),
    [
      displayGroups,
      collapsedWorkspaces,
      visibleThreadCounts,
      selectedThreadId,
      sortMode,
      onNewChat,
      chatsCollapsed,
    ],
  );

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

  const toggleChatsCollapsed = useCallback(() => {
    setChatsCollapsed((current) => {
      const next = !current;
      writeStoredChatsCollapsed(next);
      return next;
    });
  }, []);

  const handleOverflowPress = useCallback(
    (workspaceId: string, visibleCount: number, isExpanded: boolean) => {
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
    [],
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
        const chatsCollapsible = item.title === "Chats" && item.isOpen != null;
        return (
          <View style={styles.sectionHeading}>
            {/* Explicitly 400: the bundled Geist has only Regular and Bold, so
                RN resolves any in-between weight to the nearest real face.
                Naming the weight we actually have keeps this row off that
                rounding edge — see docs/MARKDOWN_STYLE.md. */}
            {chatsCollapsible ? (
              <Pressable
                style={({ pressed }) => [
                  styles.sectionHeadingToggle,
                  pressed ? styles.filterButtonPressed : undefined,
                ]}
                onPress={toggleChatsCollapsed}
                accessibilityRole="button"
                accessibilityLabel={
                  item.isOpen ? "Collapse chats" : "Expand chats"
                }
                accessibilityHint={
                  item.isOpen
                    ? "Hides individual chats"
                    : "Shows individual chats"
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
        const shouldRetargetNewConversation =
          selectedThreadId === null && !isNewConversationProject;
        // Two sibling controls, not a button inside a button: nesting them made
        // VoiceOver read the row as one element and swallowed "new thread".
        return (
          <View style={styles.workspaceHeader}>
            <Pressable
              style={styles.workspaceLeft}
              onPress={() => {
                if (shouldRetargetNewConversation) {
                  onNewThread(item.workspaceId);
                } else {
                  toggleWorkspaceCollapse(item.workspaceId);
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={item.workspaceName}
              accessibilityHint={
                shouldRetargetNewConversation
                  ? "Moves the new conversation to this project"
                  : item.isOpen
                    ? "Collapses this project"
                    : "Expands this project"
              }
              accessibilityState={{
                expanded: item.isOpen,
                ...(selectedThreadId === null
                  ? { selected: isNewConversationProject }
                  : {}),
              }}
            >
              {item.isOpen ? (
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
                variant="supporting"
                color="secondary"
                weight="normal"
                numberOfLines={1}
                style={[styles.workspaceName, accent ? { color: accent } : null]}
              >
                {item.workspaceName}
              </Text>
            </Pressable>
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

      if (item.type === "overflow") {
        return (
          <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
            <Pressable
              style={styles.overflowRow}
              onPress={() =>
                handleOverflowPress(
                  item.workspaceId,
                  item.visibleCount,
                  item.isExpanded,
                )
              }
              accessibilityRole="button"
              accessibilityState={{ expanded: item.isExpanded }}
            >
              <ChevronDown
                size={12}
                color={theme.colors.fg.muted}
                style={item.isExpanded ? styles.chevronFlipped : undefined}
              />
              <Text variant="caption" color="muted">
                {item.isExpanded ? "Show less" : "Show more"}
              </Text>
            </Pressable>
          </CollapsibleRow>
        );
      }

      return (
        <CollapsibleRow rowKey={item.key} isCollapsed={item.isCollapsed}>
          <SessionListItem
            thread={item.thread}
            workspaceId={item.workspaceId}
            isSelected={selectedThreadId === item.thread.id}
            onSelectThread={onSelectThread}
            onOpenThreadOptions={openThreadOptions}
            tags={threadTagsById?.[item.thread.id]}
          />
        </CollapsibleRow>
      );
    },
    [
      onNewThread,
      onNewChat,
      onSelectThread,
      openThreadOptions,
      selectedThreadId,
      selectedWorkspaceId,
      theme.colors.cat,
      theme.colors.fg.muted,
      theme.iconSize.xs,
      toggleWorkspaceCollapse,
      toggleChatsCollapsed,
      handleOverflowPress,
      threadTagsById,
      workspaceColors,
      activeExtensionFilterCount,
      supportedExtensionFilters.length,
      sortMode,
      theme.colors.accent.default,
    ],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {onClose ? (
        <View style={styles.header}>
          <Text variant="label" color="primary" weight="semibold">
            Threads
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.closeButton,
              pressed ? styles.closeButtonPressed : undefined,
            ]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close sidebar"
            hitSlop={8}
          >
            <X size={theme.iconSize.md} color={theme.colors.fg.secondary} />
          </Pressable>
        </View>
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
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.type}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={listContentStyle}
          />
        )}
      </View>

      {hasFloatingDock ? (
        <View
          style={[
            styles.floatingDock,
            { bottom: Math.max(insets.bottom, theme.spacing[3]) },
          ]}
          pointerEvents="box-none"
        >
          {canStartNew ? (
            <Pressable
              style={({ pressed }) => [
                styles.floatingNewButton,
                pressed ? styles.floatingNewButtonPressed : undefined,
              ]}
              onPress={() => {
                if (onNewChat) void onNewChat();
                else if (newThreadWorkspaceId) onNewThread(newThreadWorkspaceId);
              }}
              accessibilityRole="button"
              accessibilityLabel={onNewChat ? "New chat" : "New thread"}
              accessibilityHint={
                onNewChat
                  ? "Starts a conversation outside a project"
                  : "Starts a conversation in the open project"
              }
            >
              <SquarePen
                size={theme.iconSize.lg}
                color={theme.colors.surface[0]}
              />
              <Text
                variant="label"
                size="md"
                weight="semibold"
                style={styles.floatingNewLabel}
              >
                New
              </Text>
            </Pressable>
          ) : null}

          {onOpenSettings ? (
            <Pressable
              style={({ pressed }) => [
                styles.floatingSettingsButton,
                settingsOpen ? styles.floatingSettingsButtonSelected : undefined,
                pressed ? styles.floatingSettingsButtonPressed : undefined,
              ]}
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              accessibilityHint="Opens mobile settings and automations"
              accessibilityState={{ selected: settingsOpen }}
            >
              <Settings
                size={theme.iconSize.lg}
                color={theme.colors.fg.primary}
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {optionsTarget ? (
        <ThreadOptionsSheet
          workspaceId={optionsTarget.workspaceId}
          thread={optionsTarget.thread}
          onClose={closeThreadOptions}
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
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[1],
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: theme.minTouchTarget,
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  closeButton: {
    width: theme.minTouchTarget,
    height: theme.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
  },
  closeButtonPressed: { backgroundColor: theme.colors.surface[2] },
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
    height: FLOATING_ACTION_HEIGHT,
    minWidth: 152,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
    borderRadius: theme.radius.full,
    borderCurve: "continuous",
    backgroundColor: theme.colors.fg.primary,
    ...theme.shadow.lg,
  },
  floatingNewButtonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  floatingNewLabel: { color: theme.colors.surface[0] },
  floatingSettingsButton: {
    position: "absolute",
    right: theme.spacing[4],
    width: FLOATING_ACTION_HEIGHT,
    height: FLOATING_ACTION_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    borderWidth: 1,
    borderColor: theme.colors.border.emphasis,
    ...theme.shadow.lg,
  },
  floatingSettingsButtonSelected: {
    backgroundColor: theme.colors.surface[4],
    borderColor: theme.colors.border.strong,
  },
  floatingSettingsButtonPressed: {
    backgroundColor: theme.colors.surface[3],
    transform: [{ scale: 0.96 }],
  },
  workspaceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
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
