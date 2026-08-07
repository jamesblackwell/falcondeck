import { useCallback, useEffect, useRef, useState } from 'react'

import { HostManager, type HostView } from '../hosts'

// One HostManager per window: relay connections should survive React strict
// re-mounts and view switches.
let sharedManager: HostManager | null = null

function getManager(): HostManager {
  if (!sharedManager) sharedManager = new HostManager()
  return sharedManager
}

export function useRemoteHosts() {
  const manager = useRef(getManager()).current
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsubscribe = manager.subscribe(() => setTick((value) => value + 1))
    manager.start()
    return unsubscribe
  }, [manager])

  // Fresh views every render; renders are driven by manager notifications.
  const hosts: HostView[] = manager.views()

  const hostForWorkspace = useCallback(
    (workspaceId: string | null | undefined) =>
      workspaceId ? manager.hostForWorkspace(workspaceId) : null,
    [manager],
  )

  return { manager, hosts, hostForWorkspace }
}
