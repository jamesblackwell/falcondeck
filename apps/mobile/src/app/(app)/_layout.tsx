import { useCallback, useMemo } from "react";
import { Drawer } from "expo-router/drawer";
import { Redirect, useRouter } from "expo-router";
import { DrawerActions } from "@react-navigation/native";
import type { DrawerContentComponentProps } from "@react-navigation/drawer";

import { useUnistyles } from "react-native-unistyles";

import {
  buildProjectGroups,
  deriveExtensionPanels,
  deriveExtensionSidebarFilters,
  deriveThreadTags,
} from "@falcondeck/client-core";

import { useRelayStore, useSessionStore } from "@/store";
import { SidebarView } from "@/components/navigation";
import { triggerThreadSelectionHaptic } from "@/lib/haptics";

export default function AppLayout() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const sessionId = useRelayStore((s) => s.sessionId);
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
  const extensionPanelCount = useMemo(
    () => deriveExtensionPanels(snapshot?.extensions).length,
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

  const handleOpenSettings = useCallback(() => {
    router.navigate("/(app)/settings");
  }, [router]);

  // The drawer covers the whole screen, so there is no scrim left to tap:
  // closing it has to come from a control inside the sidebar.
  const renderDrawerContent = useCallback(
    ({ navigation }: DrawerContentComponentProps) => (
      <SidebarView
        groups={groups}
        selectedThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onOpenSettings={handleOpenSettings}
        onClose={() => navigation.dispatch(DrawerActions.closeDrawer())}
        threadTagsById={threadTags.byThreadId}
        extensionSnapshot={snapshot?.extensions}
        extensionSidebarFilters={extensionSidebarFilters}
        extensionPanelCount={extensionPanelCount}
      />
    ),
    [
      extensionSidebarFilters,
      snapshot?.extensions,
      extensionPanelCount,
      groups,
      handleSelectThread,
      handleNewThread,
      handleOpenSettings,
      selectedThreadId,
      threadTags.byThreadId,
    ],
  );

  if (!sessionId) {
    return <Redirect href="/(auth)/pair" />;
  }

  return (
    <Drawer
      screenOptions={{
        headerShown: false,
        // Keep the native drawer gesture available on iOS and give users a
        // forgiving edge target for opening the sidebar.
        swipeEnabled: true,
        swipeEdgeWidth: 80,
        // Full-width sidebar: thread titles are long and the 300pt panel
        // truncated most of them. 'front' keeps the conversation in place
        // underneath instead of shoving it entirely off-screen.
        drawerType: "front",
        drawerStyle: {
          backgroundColor: theme.colors.surface[1],
          width: "100%",
        },
        sceneStyle: {
          backgroundColor: theme.colors.surface[0],
        },
      }}
      drawerContent={renderDrawerContent}
    />
  );
}
