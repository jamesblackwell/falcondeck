/**
 * Drawer content wrapper that keeps the sidebar cheap while it is closed.
 *
 * The drawer stays mounted for the life of the app, and the session snapshot
 * changes on every applied event batch — during a streaming turn that meant
 * the entire (large) SidebarView re-rendered many times per second behind a
 * closed drawer. While closed, this wrapper keeps returning the same element
 * so React bails out of the whole sidebar subtree; the drawer re-opens with a
 * fresh render, so at worst the sidebar is a closed-drawer's-worth stale
 * during the opening animation.
 */
import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Alert } from "react-native";
import { usePathname, useRouter, type Href } from "expo-router";
import { DrawerActions } from "@react-navigation/native";
import {
  useDrawerStatus,
  type DrawerContentComponentProps,
} from "@react-navigation/drawer";

import {
  buildProjectGroups,
  deriveExtensionSidebarFilters,
  deriveThreadTags,
  type WorkspaceSummary,
} from "@falcondeck/client-core";

import { useRelayStore, useSessionStore } from "@/store";
import { SidebarView } from "./SidebarView";
import { triggerThreadSelectionHaptic } from "@/lib/haptics";

export function SidebarDrawerContent({
  navigation,
}: Pick<DrawerContentComponentProps, "navigation">) {
  const router = useRouter();
  const pathname = usePathname();
  const isOpen = useDrawerStatus() === "open";
  const settingsOpen =
    pathname === "/settings" || pathname.startsWith("/settings/");
  const automationsOpen =
    pathname === "/automations" || pathname.startsWith("/automations/");
  const snapshot = useSessionStore((s) => s.snapshot);
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId);
  const groups = useMemo(
    () =>
      buildProjectGroups(
        snapshot?.workspaces ?? [],
        snapshot?.threads ?? [],
        snapshot?.preferences.workspace_order,
      ),
    [
      snapshot?.preferences.workspace_order,
      snapshot?.threads,
      snapshot?.workspaces,
    ],
  );
  const threadTags = useMemo(
    () => deriveThreadTags(snapshot?.extensions),
    [snapshot?.extensions],
  );
  const extensionSidebarFilters = useMemo(
    () => deriveExtensionSidebarFilters(snapshot?.extensions),
    [snapshot?.extensions],
  );

  const handleSelectThread = useCallback(
    (wId: string, tId: string) => {
      if (selectedWorkspaceId !== wId || selectedThreadId !== tId) {
        triggerThreadSelectionHaptic();
      }
      useSessionStore.getState().selectThread(wId, tId);
      router.navigate("/(app)");
    },
    [router, selectedThreadId, selectedWorkspaceId],
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
    },
    [router, selectedThreadId, selectedWorkspaceId],
  );

  const handleNewChat = useCallback(async () => {
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
  }, [router]);

  const handleOpenSettings = useCallback(() => {
    router.navigate("/(app)/settings");
  }, [router]);

  const handleOpenAutomations = useCallback(() => {
    router.navigate("/(app)/automations" as Href);
  }, [router]);

  // The drawer covers the whole screen, so there is no scrim left to tap:
  // closing it has to come from a control inside the sidebar.
  const handleClose = useCallback(() => {
    navigation.dispatch(DrawerActions.closeDrawer());
  }, [navigation]);

  return (
    <SidebarFreeze isOpen={isOpen}>
      <SidebarView
      groups={groups}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedThreadId={selectedThreadId}
      onSelectThread={handleSelectThread}
      onNewThread={handleNewThread}
      onNewChat={handleNewChat}
      onOpenSettings={handleOpenSettings}
      settingsOpen={settingsOpen}
      onOpenAutomations={handleOpenAutomations}
      automationsOpen={automationsOpen}
      onClose={handleClose}
      threadTagsById={threadTags.byThreadId}
      threadTagOptions={threadTags.tags}
      extensionSnapshot={snapshot?.extensions}
        extensionSidebarFilters={extensionSidebarFilters}
        workspaceColors={snapshot?.preferences.workspace_colors}
      />
    </SidebarFreeze>
  );
}

// While the drawer is closed the comparator reports "equal", so React keeps
// the previously rendered sidebar subtree untouched no matter how often the
// snapshot churns; the first render after opening goes through normally.
const SidebarFreeze = memo(
  function SidebarFreeze({
    children,
  }: {
    isOpen: boolean;
    children: ReactElement;
  }) {
    return children;
  },
  (_prev, next) => !next.isOpen,
);
