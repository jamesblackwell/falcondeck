import { useCallback, useEffect, useRef, useState } from 'react'

import type { ProjectGroup } from '@falcondeck/client-core'

import { useRelayStore, useSessionStore } from '@/store'

export function useWorkspaceIcons(groups: ProjectGroup[]) {
  const [uris, setUris] = useState<Record<string, string>>({})
  const cacheRef = useRef(new Map<string, string>())
  const iconPreferences = useSessionStore(
    (state) => state.snapshot?.preferences.workspace_icons,
  )
  const signature = groups
    .map(
      (group) =>
        `${group.workspace.id}:${group.workspace.icon?.kind ?? ''}:${group.workspace.icon?.etag ?? ''}`,
    )
    .join('|')

  useEffect(() => {
    let cancelled = false
    const callRpc = useRelayStore.getState()._callRpc
    for (const group of groups) {
      const workspace = group.workspace
      if (workspace.icon?.kind !== 'image') continue
      const cacheKey = `${workspace.id}:${workspace.icon.etag ?? ''}`
      const cached = cacheRef.current.get(cacheKey)
      if (cached) {
        setUris((current) =>
          current[workspace.id] === cached
            ? current
            : { ...current, [workspace.id]: cached },
        )
        continue
      }
      void callRpc<{
        kind?: string
        content_type?: string
        data?: string
      }>('workspace.icon', { workspace_id: workspace.id })
        .then((payload) => {
          if (
            cancelled ||
            payload.kind !== 'image' ||
            !payload.data ||
            !payload.content_type
          ) {
            return
          }
          const uri = `data:${payload.content_type};base64,${payload.data}`
          cacheRef.current.set(cacheKey, uri)
          setUris((current) => ({ ...current, [workspace.id]: uri }))
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
    // Signature covers id + resolved icon etag; `groups` is listed so we read
    // the current workspace objects without refetching on unrelated snapshot
    // churn.
  }, [groups, signature])

  return useCallback(
    (workspaceId: string) => {
      if (iconPreferences?.[workspaceId]?.mode === 'folder') return null
      return uris[workspaceId] ?? null
    },
    [iconPreferences, uris],
  )
}
