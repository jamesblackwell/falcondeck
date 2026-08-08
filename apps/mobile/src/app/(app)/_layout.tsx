import { useCallback, useMemo } from 'react'
import { Drawer } from 'expo-router/drawer'
import { Redirect, useRouter } from 'expo-router'

import { useUnistyles } from 'react-native-unistyles'

import { buildProjectGroups } from '@falcondeck/client-core'

import { useRelayStore, useSessionStore } from '@/store'
import { SidebarView } from '@/components/navigation'

export default function AppLayout() {
  const router = useRouter()
  const { theme } = useUnistyles()
  const sessionId = useRelayStore((s) => s.sessionId)
  const snapshot = useSessionStore((s) => s.snapshot)
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const groups = useMemo(
    () => buildProjectGroups(snapshot?.workspaces ?? [], snapshot?.threads ?? []),
    [snapshot?.threads, snapshot?.workspaces],
  )

  const handleSelectThread = useCallback(
    (wId: string, tId: string) => {
      useSessionStore.getState().selectThread(wId, tId)
      router.navigate('/(app)')
    },
    [router],
  )

  const handleNewThread = useCallback(
    (wId: string) => {
      // The composer seed effect reacts to this selection change and applies
      // the workspace's remembered provider/model/effort/modes, so nothing is
      // inherited from the previously viewed thread.
      useSessionStore.getState().selectNewThread(wId)
      router.navigate('/(app)')
    },
    [router],
  )

  const renderDrawerContent = useCallback(
    () => (
      <SidebarView
        groups={groups}
        selectedThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
      />
    ),
    [groups, handleSelectThread, handleNewThread, selectedThreadId],
  )

  if (!sessionId) {
    return <Redirect href="/(auth)/pair" />
  }

  return (
    <Drawer
      screenOptions={{
        headerShown: false,
        // Keep the native drawer gesture available on iOS and give users a
        // forgiving edge target for opening the sidebar.
        swipeEnabled: true,
        swipeEdgeWidth: 80,
        drawerStyle: {
          backgroundColor: theme.colors.surface[1],
          width: 300,
        },
        sceneStyle: {
          backgroundColor: theme.colors.surface[0],
        },
      }}
      drawerContent={renderDrawerContent}
    />
  )
}
