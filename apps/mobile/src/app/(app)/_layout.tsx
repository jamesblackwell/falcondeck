import { useCallback } from "react";
import { View } from "react-native";
import { Drawer } from "expo-router/drawer";
import { Redirect } from "expo-router";
import type { DrawerContentComponentProps } from "@react-navigation/drawer";

import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { useRelayStore } from "@/store";
import { SidebarDrawerContent } from "@/components/navigation";
import { SIDEBAR_WIDTH, useTabletLayout } from "@/hooks/useTabletLayout";
import { PerfOverlay } from "@/components/debug/PerfOverlay";

export default function AppLayout() {
  const { theme } = useUnistyles();
  const sessionId = useRelayStore((s) => s.sessionId);
  const { isTablet, hasPermanentSidebar } = useTabletLayout();

  // All sidebar state lives inside SidebarDrawerContent so that snapshot
  // updates never re-render this layout (and with it the Drawer navigator).
  const renderDrawerContent = useCallback(
    ({ navigation }: DrawerContentComponentProps) => (
      <SidebarDrawerContent navigation={navigation} />
    ),
    [],
  );

  if (!sessionId) {
    return <Redirect href="/(auth)/pair" />;
  }

  return (
    <View style={styles.root}>
      <Drawer
        screenOptions={{
          headerShown: false,
          // Keep the native drawer gesture available on iOS and give users a
          // forgiving edge target for opening the sidebar.
          swipeEnabled: !hasPermanentSidebar,
          swipeEdgeWidth: 120,
          swipeMinDistance: 24,
          // Phones get a full-width sidebar: thread titles are long and the
          // 300pt panel truncated most of them. 'front' keeps the conversation
          // in place underneath instead of shoving it entirely off-screen.
          // A wide iPad has room to simply leave the sidebar on screen, and a
          // narrow one still shows the conversation beside the panel rather
          // than hiding a 1000pt-wide screen behind a list.
          drawerType: hasPermanentSidebar ? "permanent" : "front",
          drawerStyle: {
            backgroundColor: theme.colors.surface[1],
            width: isTablet ? SIDEBAR_WIDTH : "100%",
            borderRightWidth: hasPermanentSidebar ? 1 : 0,
            borderRightColor: theme.colors.border.subtle,
          },
          sceneStyle: {
            backgroundColor: theme.colors.surface[0],
          },
        }}
        drawerContent={renderDrawerContent}
      />
      <PerfOverlay />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  root: {
    flex: 1,
  },
}));
