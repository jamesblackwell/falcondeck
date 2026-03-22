import { useCallback, useMemo } from 'react'
import { Drawer } from 'expo-router/drawer'
import { Redirect, useRouter } from 'expo-router'

import { buildProjectGroups } from '@falcondeck/client-core'

import { colors } from '@/theme/tokens'
import { useRelayConnection } from '@/hooks/useRelayConnection'
import { useRelayStore, useSessionStore } from '@/store'
import { SidebarView } from '@/components/navigation'

export default function AppLayout() {
  const router = useRouter()
  const sessionId = useRelayStore((s) => s.sessionId)
  const snapshot = useSessionStore((s) => s.snapshot)
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  useRelayConnection()
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
        drawerStyle: {
          backgroundColor: colors.surface[1],
          width: 300,
        },
        sceneStyle: {
          backgroundColor: colors.surface[0],
        },
      }}
      drawerContent={renderDrawerContent}
    />
  )
}
