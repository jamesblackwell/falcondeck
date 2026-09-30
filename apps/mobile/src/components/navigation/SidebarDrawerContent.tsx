/**
 * Drawer content wrapper that keeps the sidebar cheap while it is closed.
 *
 * The drawer stays mounted for the life of the app, and the session snapshot
 * changes on every applied event batch. Pause sampling while closed and pass
 * every snapshot-derived input, including sync coverage, through one sampled
 * snapshot. Opening the drawer catches up to the current store value.
 */
import { useCallback, useMemo, useRef } from "react";
import { Alert } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { DrawerActions } from "@react-navigation/native";
import {
  useDrawerStatus,
  type DrawerContentComponentProps,
} from "@react-navigation/drawer";

import {
  buildProjectGroups,
  deriveExtensionSidebarFilters,
  deriveThreadTags,
  type ProjectGroup,
  type WorkspaceSummary,
} from "@falcondeck/client-core";

import { useRelayStore, useSessionStore, useThrottledSnapshot } from "@/store";
import { AnimationVisibility } from '@/components/ui/AnimationVisibility';
import { SidebarView } from "./SidebarView";
import { useTabletLayout } from "@/hooks/useTabletLayout";
import { triggerThreadSelectionHaptic } from "@/lib/haptics";

/**
 * How often the open drawer resamples the snapshot. Long enough that a
 * streaming turn cannot drive a full sidebar rebuild per frame, short enough
 * that a thread appearing or finishing still feels immediate.
 */
const SIDEBAR_REFRESH_INTERVAL_MS = 250;

export function SidebarDrawerContent({
  navigation,
}: Pick<DrawerContentComponentProps, "navigation">) {
  const router = useRouter();
  const pathname = usePathname();
  const { hasPermanentSidebar } = useTabletLayout();
  // A permanent sidebar is always visible and must continue sampling.
  const drawerStatus = useDrawerStatus();
  const isOpen = hasPermanentSidebar || drawerStatus === "open";
  const settingsOpen =
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/automations" ||
    pathname.startsWith("/automations/");
  // Four refreshes per second keep visible navigation current during streaming.
  const snapshot = useThrottledSnapshot(SIDEBAR_REFRESH_INTERVAL_MS, !isOpen);
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId);
  // Groups built from an unchanged workspace keep their previous identity, so
  // the memoized rows below survive a refresh that only touched one thread.
  const previousGroupsRef = useRef<ProjectGroup[] | null>(null);
  // Render-only structural-sharing cache, the same pattern (and the same lint
  // exemption) as useConversationPresentation: React has no previous-value
  // form of useMemo, and buildProjectGroups is pure.
  /* eslint-disable react-hooks/refs */
  const groups = useMemo(() => {
    const built = buildProjectGroups(
      snapshot?.workspaces ?? [],
      snapshot?.threads ?? [],
      snapshot?.preferences.workspace_order,
      previousGroupsRef.current,
    );
    previousGroupsRef.current = built;
    return built;
  }, [
    snapshot?.preferences.workspace_order,
    snapshot?.threads,
    snapshot?.workspaces,
  ]);
  /* eslint-enable react-hooks/refs */
  const threadTags = useMemo(
    () => deriveThreadTags(snapshot?.extensions),
    [snapshot?.extensions],
  );
  const extensionSidebarFilters = useMemo(
    () => deriveExtensionSidebarFilters(snapshot?.extensions),
    [snapshot?.extensions],
  );

  // The drawer covers the whole screen, so destination actions must dismiss
  // it explicitly. Navigating to the already-active app route is otherwise a
  // no-op and leaves the newly selected conversation hidden underneath.
  const handleClose = useCallback(() => {
    navigation.dispatch(DrawerActions.closeDrawer());
  }, [navigation]);

  const handleSelectThread = useCallback(
    (wId: string, tId: string) => {
      if (selectedWorkspaceId !== wId || selectedThreadId !== tId) {
        triggerThreadSelectionHaptic();
      }
      useSessionStore.getState().selectThread(wId, tId);
      router.navigate("/(app)");
      handleClose();
    },
    [handleClose, router, selectedThreadId, selectedWorkspaceId],
  );

  const handleNewThread = useCallback(
    (wId: string) => {
      // The composer seed effect reacts to this selection change and applies
      // the workspace's remembered provider/model/effort/modes, so nothing is
      // inherited from the previously viewed thread.
      if (selectedWorkspaceId !== wId || selectedThreadId !== null) {
        triggerThreadSelectionHaptic();
      }
      useSessionStore.getState().selectNewThread(wId);
      router.navigate("/(app)");
      handleClose();
    },
    [handleClose, router, selectedThreadId, selectedWorkspaceId],
  );

  const handleNewChat = useCallback(async () => {
    // Chat creation is an RPC, so acknowledge the tap and dismiss the drawer
    // before waiting for the desktop. Otherwise a slow connection leaves the
    // fully opaque drawer unchanged and makes this control appear inert.
    triggerThreadSelectionHaptic();
    handleClose();
    try {
      const workspace = await useRelayStore
        .getState()
        ._callRpc<WorkspaceSummary>("chat.create", { create: true });
      useSessionStore.getState().selectNewThread(workspace.id);
      router.navigate("/(app)");
    } catch (error) {
      Alert.alert(
        "Couldn't create chat",
        error instanceof Error ? error.message : "The desktop could not create the chat folder.",
      );
    }
  }, [handleClose, router]);

  const handleOpenActivity = useCallback(() => {
    router.navigate("/(app)/activity");
    handleClose();
  }, [handleClose, router]);

  const handleOpenSettings = useCallback(() => {
    router.navigate("/(app)/settings");
    handleClose();
  }, [handleClose, router]);

  return (
    <AnimationVisibility active={isOpen}>
    <SidebarView
      isVisible={isOpen}
      syncIndex={snapshot?.sync_index}
      groups={groups}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedThreadId={selectedThreadId}
      onSelectThread={handleSelectThread}
      onNewThread={handleNewThread}
      onNewChat={handleNewChat}
      onOpenActivity={handleOpenActivity}
      activityOpen={pathname === "/activity"}
      onOpenSettings={handleOpenSettings}
      settingsOpen={settingsOpen}
      // A sidebar that never goes away has nothing to close, and an X on it
      // reads as a way to dismiss the app's only navigation.
      onClose={hasPermanentSidebar ? undefined : handleClose}
      threadTagsById={threadTags.byThreadId}
      threadTagOptions={threadTags.tags}
      extensionSnapshot={snapshot?.extensions}
      extensionSidebarFilters={extensionSidebarFilters}
      workspaceColors={snapshot?.preferences.workspace_colors}
      hiddenWorkspaceIds={snapshot?.preferences.hidden_workspace_ids}
    />
    </AnimationVisibility>
  );
}
