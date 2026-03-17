import { Drawer } from 'expo-router/drawer'

import { colors } from '@/theme/tokens'
import { useGroups, useSessionStore, useRelayStore } from '@/store'
import { SidebarView } from '@/components/navigation'

export default function AppLayout() {
  const groups = useGroups()
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId)
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const { selectThread } = useSessionStore.getState()

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
      drawerContent={() => (
        <SidebarView
          groups={groups}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedThreadId={selectedThreadId}
          connectionStatus={connectionStatus}
          isEncrypted={isEncrypted}
          onSelectThread={(wId, tId) => selectThread(wId, tId)}
          onNewThread={(wId) => useSessionStore.getState().selectWorkspace(wId)}
        />
      )}
    />
  )
}
