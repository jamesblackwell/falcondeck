import { useCallback, useMemo } from 'react'
import { Drawer } from 'expo-router/drawer'
import { Redirect, useRouter } from 'expo-router'

import { buildProjectGroups } from '@falcondeck/client-core'

import { colors } from '@/theme/tokens'
import { useRelayConnection } from '@/hooks/useRelayConnection'
import { useRelayStore, useSessionStore, useUIStore } from '@/store'
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
      // Reset provider/model/effort so the new thread uses workspace defaults
      // instead of inheriting from the previously viewed thread
      const ui = useUIStore.getState()
      ui.setSelectedProvider(null)
      ui.setSelectedModel(null)
      ui.setSelectedEffort(null)
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
