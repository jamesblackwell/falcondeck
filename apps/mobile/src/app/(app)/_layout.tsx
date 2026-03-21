import { useCallback, useMemo } from 'react'
import { Drawer } from 'expo-router/drawer'

import { buildProjectGroups } from '@falcondeck/client-core'

import { colors } from '@/theme/tokens'
import { useSessionStore } from '@/store'
import { SidebarView } from '@/components/navigation'

export default function AppLayout() {
  const snapshot = useSessionStore((s) => s.snapshot)
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const { selectThread, selectNewThread } = useSessionStore.getState()
  const groups = useMemo(
    () => buildProjectGroups(snapshot?.workspaces ?? [], snapshot?.threads ?? []),
    [snapshot?.threads, snapshot?.workspaces],
  )
  const renderDrawerContent = useCallback(
    () => (
      <SidebarView
        groups={groups}
        selectedThreadId={selectedThreadId}
        onSelectThread={(wId, tId) => selectThread(wId, tId)}
        onNewThread={selectNewThread}
      />
    ),
    [groups, selectNewThread, selectThread, selectedThreadId],
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
