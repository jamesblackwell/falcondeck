import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const unsubscribe = manager.subscribe(() => setTick((value) => value + 1))
    manager.start()
    return unsubscribe
  }, [manager])

  // Views change only when the manager notifies (tick), so memoizing on it
  // keeps the array identity stable across unrelated renders — effects and
  // memos downstream (e.g. workspaceHostIndex) must not churn per keystroke.
  const hosts: HostView[] = useMemo(() => manager.views(), [manager, tick])

  const hostForWorkspace = useCallback(
    (workspaceId: string | null | undefined) =>
      workspaceId ? manager.hostForWorkspace(workspaceId) : null,
    [manager],
  )

  return { manager, hosts, hostForWorkspace }
}
