import { useCallback, useMemo } from 'react'
import { Drawer } from 'expo-router/drawer'
import { useRouter } from 'expo-router'

import { buildProjectGroups } from '@falcondeck/client-core'

import { colors } from '@/theme/tokens'
import { useSessionStore } from '@/store'
import { SidebarView } from '@/components/navigation'

export default function AppLayout() {
  const router = useRouter()
  const snapshot = useSessionStore((s) => s.snapshot)
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const { selectThread, selectNewThread } = useSessionStore.getState()
  const groups = useMemo(
    () => buildProjectGroups(snapshot?.workspaces ?? [], snapshot?.threads ?? []),
    [snapshot?.threads, snapshot?.workspaces],
  )

  const handleSelectThread = useCallback(
    (wId: string, tId: string) => {
      selectThread(wId, tId)
      router.navigate('/(app)')
    },
    [selectThread, router],
  )

  const handleNewThread = useCallback(
    (wId: string) => {
      selectNewThread(wId)
      router.navigate('/(app)')
    },
    [selectNewThread, router],
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
