import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BotProfile, TerminalSessionInfo } from '@falcondeck/client-core'

import type { TerminalTab } from './terminal-tabs'

/**
 * What the terminal panel belongs to. A bot owns its terminals across home
 * conversation switches; any other selected thread owns its own; with no
 * thread selected the project (workspace) does.
 */
export type TerminalScope = {
  key: string
  workspaceId: string
  threadId: string | null
  botId: string | null
}

/** The bot whose home (current or previous) conversation `threadId` is. */
export function botIdForThread(
  bots: readonly Pick<BotProfile, 'id' | 'thread_id' | 'previous_thread_ids'>[] | null | undefined,
  threadId: string | null,
): string | null {
  if (!threadId || !bots) return null
  return (
    bots.find(
      (bot) => bot.thread_id === threadId || bot.previous_thread_ids?.includes(threadId),
    )?.id ?? null
  )
}

/** Takes primitives so callers can memoize the scope on them. */
export function terminalScopeFor(
  workspaceId: string | null,
  threadId: string | null,
  botId: string | null,
): TerminalScope | null {
  if (!workspaceId) return null
  if (botId) return { key: `bot:${botId}`, workspaceId, threadId, botId }
  if (threadId) return { key: `thread:${threadId}`, workspaceId, threadId, botId: null }
  return { key: `workspace:${workspaceId}`, workspaceId, threadId: null, botId: null }
}

/** The scope a daemon session was opened for. */
export function sessionScopeKey(session: TerminalSessionInfo): string {
  if (session.bot_id) return `bot:${session.bot_id}`
  if (session.thread_id) return `thread:${session.thread_id}`
  return `workspace:${session.workspace_id}`
}

/**
 * Split layouts outlive a panel instance (an evicted scope remounts later),
 * but not the app: after a reload each surviving session gets its own tab.
 */
export type RememberedLayout = { tabs: TerminalTab[]; activeTabId: string | null }
const layoutMemory = new Map<string, RememberedLayout>()

export function rememberLayout(scopeKey: string, layout: RememberedLayout) {
  layoutMemory.set(scopeKey, layout)
}

export function recallLayout(scopeKey: string): RememberedLayout | undefined {
  return layoutMemory.get(scopeKey)
}

export function forgetLayout(scopeKey: string) {
  layoutMemory.delete(scopeKey)
}

export type TerminalRequestKind = 'create' | 'find' | 'focus'

/** One-shot instruction for a scope's panel, cleared once the panel acts on it. */
export type TerminalRequest = { seq: number; scopeKey: string; kind: TerminalRequestKind }

/** Hidden scopes keep their xterm instances (and scrollback) mounted up to
 * this many; older ones unmount and replay from the daemon when revisited. */
export const MAX_RETAINED_TERMINAL_SCOPES = 6

export type TerminalScopesController = {
  current: TerminalScope | null
  isOpen: boolean
  /** Scopes whose panels stay mounted, most recently used first. */
  retained: TerminalScope[]
  requests: TerminalRequest[]
  toggle: () => void
  openNew: () => void
  requestFind: () => void
  hide: (scopeKey: string) => void
  /** The scope's last tab closed: hide it and unmount its panel. */
  release: (scopeKey: string) => void
  completeRequest: (seq: number) => void
}

export function useTerminalScopes(current: TerminalScope | null): TerminalScopesController {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [retained, setRetained] = useState<TerminalScope[]>([])
  const [requests, setRequests] = useState<TerminalRequest[]>([])
  const seqRef = useRef(0)
  const currentKey = current?.key ?? null
  const isOpen = currentKey !== null && openKeys.has(currentKey)

  const request = useCallback((scopeKey: string, ...kinds: TerminalRequestKind[]) => {
    setRequests((existing) => [
      ...existing,
      ...kinds.map((kind) => ({ seq: (seqRef.current += 1), scopeKey, kind })),
    ])
  }, [])

  // Requests belong to the scope they were made in; switching away drops
  // them so a later visit never steals focus or spawns a shell unasked.
  useEffect(() => {
    setRequests((existing) => {
      const kept = existing.filter((entry) => entry.scopeKey === currentKey)
      return kept.length === existing.length ? existing : kept
    })
  }, [currentKey])

  useEffect(() => {
    if (!current || !isOpen) return
    setRetained((existing) => {
      if (existing[0]?.key === current.key && existing[0] === current) return existing
      const rest = existing.filter((scope) => scope.key !== current.key)
      return [current, ...rest].slice(0, MAX_RETAINED_TERMINAL_SCOPES)
    })
  }, [current, isOpen])

  const toggle = useCallback(() => {
    if (!currentKey) return
    if (openKeys.has(currentKey)) {
      setOpenKeys((keys) => without(keys, currentKey))
      return
    }
    setOpenKeys((keys) => with_(keys, currentKey))
    request(currentKey, 'focus')
  }, [currentKey, openKeys, request])

  const openNew = useCallback(() => {
    if (!currentKey) return
    setOpenKeys((keys) => with_(keys, currentKey))
    request(currentKey, 'create')
  }, [currentKey, request])

  const requestFind = useCallback(() => {
    if (currentKey) request(currentKey, 'find')
  }, [currentKey, request])

  const hide = useCallback((scopeKey: string) => {
    setOpenKeys((keys) => without(keys, scopeKey))
  }, [])

  const release = useCallback((scopeKey: string) => {
    setOpenKeys((keys) => without(keys, scopeKey))
    setRetained((existing) => existing.filter((scope) => scope.key !== scopeKey))
    setRequests((existing) => existing.filter((entry) => entry.scopeKey !== scopeKey))
    forgetLayout(scopeKey)
  }, [])

  const completeRequest = useCallback((seq: number) => {
    setRequests((existing) => existing.filter((entry) => entry.seq !== seq))
  }, [])

  return useMemo(
    () => ({
      current,
      isOpen,
      retained,
      requests,
      toggle,
      openNew,
      requestFind,
      hide,
      release,
      completeRequest,
    }),
    [completeRequest, current, hide, isOpen, openNew, release, requestFind, requests, retained, toggle],
  )
}

function with_(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (keys.has(key)) return keys
  return new Set([...keys, key])
}

function without(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!keys.has(key)) return keys
  const next = new Set(keys)
  next.delete(key)
  return next
}
