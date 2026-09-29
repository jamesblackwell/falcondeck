import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ProjectGroup } from '@falcondeck/client-core'

import { useRelayStore, useSessionStore } from '@/store'

export function useWorkspaceIcons(groups: ProjectGroup[], paused = false) {
  const [uris, setUris] = useState<Record<string, string>>({})
  const sessionId = useRelayStore((state) => state.sessionId)
  const relayUrl = useRelayStore((state) => state.relayUrl)
  const isEncrypted = useRelayStore((state) => state.isEncrypted)
  const iconPreferences = useSessionStore(
    (state) => state.snapshot?.preferences.workspace_icons,
  )
  // Thread updates replace groups without changing the requested icons.
  const signature = JSON.stringify(groups.flatMap(({ workspace }) =>
    workspace.icon?.kind === 'image' ? [[workspace.id, workspace.icon.etag ?? '']] : [],
  ))
  const icons = useMemo(() => JSON.parse(signature) as [string, string][], [signature])
  const scope = JSON.stringify([relayUrl, sessionId])
  const cache = useMemo(() => ({
    scope,
    resolved: new Map<string, string>(),
    pending: new Map<string, Promise<string | null>>(),
  }), [scope])
  const iconKeys = useMemo(() => new Map(icons.map(([id, etag]) =>
    [id, JSON.stringify([scope, id, etag])],
  )), [icons, scope])

  useEffect(() => {
    if (paused || !sessionId || !isEncrypted) return
    let cancelled = false
    const callRpc = useRelayStore.getState()._callRpc
    for (const [workspaceId, cacheKey] of iconKeys) {
      const publish = (uri: string | null) => {
        if (cancelled || !uri) return
        setUris((current) => current[cacheKey] === uri
          ? current : { ...current, [cacheKey]: uri })
      }
      const cached = cache.resolved.get(cacheKey)
      if (cached) {
        publish(cached)
        continue
      }
      let request = cache.pending.get(cacheKey)
      if (!request) {
        request = callRpc<{
          kind?: string
          content_type?: string
          data?: string
        }>('workspace.icon', { workspace_id: workspaceId })
          .then((payload) => {
            if (payload.kind !== 'image' || !payload.data || !payload.content_type) return null
            const uri = `data:${payload.content_type};base64,${payload.data}`
            // Cache valid responses even if the consumer's effect was superseded.
            cache.resolved.set(cacheKey, uri)
            return uri
          })
          .catch(() => null)
          .finally(() => cache.pending.delete(cacheKey))
        cache.pending.set(cacheKey, request)
      }
      void request.then(publish)
    }
    return () => {
      cancelled = true
    }
  }, [cache, iconKeys, isEncrypted, paused, sessionId])

  return useCallback(
    (workspaceId: string) => {
      if (iconPreferences?.[workspaceId]?.mode === 'folder') return null
      const cacheKey = iconKeys.get(workspaceId)
      return cacheKey ? uris[cacheKey] ?? null : null
    },
    [iconKeys, iconPreferences, uris],
  )
}
