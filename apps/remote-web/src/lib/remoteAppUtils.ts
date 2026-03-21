import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  generateBoxKeyPair,
  normalizeEventEnvelope,
  REMOTE_SESSION_STORAGE_VERSION,
  restoreBoxKeyPair,
  secretKeyToBase64,
  upsertConversationItem,
  workspaceModels,
  type AgentProvider,
  type ConversationItem,
  type DaemonSnapshot,
  type EventEnvelope,
  type PersistedRemoteSession,
  type RelayClientMessage,
  type ThreadDetail,
} from '@falcondeck/client-core'

export const STORAGE_KEY = 'falcondeck.remote.session.v1'
export const PENDING_ACTIONS_KEY = 'falcondeck.remote.pending-actions.v1'
export const CLIENT_KEYPAIR_STORAGE_KEY = 'falcondeck.remote.client-keypair.v1'

export type ConnectionHelpState = {
  tone: 'warning' | 'danger'
  title: string
  description: string
  steps: string[]
}

export function getDeviceLabel(): string {
  const ua = navigator.userAgent
  let browser = 'Browser'
  if (ua.includes('Firefox/')) browser = 'Firefox'
  else if (ua.includes('Edg/')) browser = 'Edge'
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera'
  else if (ua.includes('Chrome/') && !ua.includes('Edg/')) browser = 'Chrome'
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Safari'

  let os = ''
  if (ua.includes('iPhone')) os = 'iPhone'
  else if (ua.includes('iPad')) os = 'iPad'
  else if (ua.includes('Android')) os = 'Android'
  else if (ua.includes('Mac OS')) os = 'macOS'
  else if (ua.includes('Windows')) os = 'Windows'
  else if (ua.includes('Linux')) os = 'Linux'

  return os ? `${browser} on ${os}` : browser
}

export function parseDaemonEvent(payload: unknown): EventEnvelope | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    'event' in payload &&
    (payload as { kind?: string }).kind === 'daemon-event'
  ) {
    return normalizeEventEnvelope((payload as { event: EventEnvelope }).event)
  }
  return null
}

export function encryptedRpcErrorMessage(payload: unknown) {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Remote action failed'
}

export function reasoningOptions(
  snapshot: DaemonSnapshot | null,
  workspaceId: string | null,
  provider: AgentProvider,
  modelId: string | null,
) {
  const workspace = snapshot?.workspaces.find((entry) => entry.id === workspaceId)
  const model = workspaceModels(workspace, provider).find((entry) => entry.id === modelId)
  const supported = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (supported.length > 0) return supported
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

export function sendRelayMessage(socket: WebSocket, message: RelayClientMessage) {
  socket.send(JSON.stringify(message))
}

export function connectionLabel(status: string) {
  if (status.startsWith('connected')) return 'Connected'
  if (status === 'connecting') return 'Connecting...'
  if (status === 'disconnected') return 'Disconnected'
  if (status.includes('claimed')) return 'Pairing...'
  return 'Not connected'
}

export function connectionBadgeState(status: string, desktopOnline: boolean) {
  if (status.startsWith('connected')) {
    if (desktopOnline) return { variant: 'success' as const, label: 'Connected' }
    return { variant: 'warning' as const, label: 'Desktop retrying' }
  }

  return {
    variant: status === 'disconnected' ? ('danger' as const) : ('warning' as const),
    label: connectionLabel(status),
  }
}

export function applyDaemonEventsToSnapshot(
  current: DaemonSnapshot | null,
  events: EventEnvelope[],
) {
  let next = current
  for (const event of events) {
    next =
      applySnapshotEvent(next, event) ??
      (event.event.type === 'snapshot' ? event.event.snapshot : next)
  }
  return next
}

export function applyDaemonEventsToThreadItems(
  current: Record<string, ConversationItem[]>,
  updatesByThread: Map<string, ConversationItem[]>,
) {
  let next = current

  for (const [threadId, updates] of updatesByThread) {
    let updated = current[threadId] ?? []
    for (const item of updates) {
      updated = upsertConversationItem(updated, item)
    }
    if (next === current) {
      next = { ...current }
    }
    next[threadId] = updated
  }

  return next
}

export function applyDaemonEventsToThreadDetail(
  current: ThreadDetail | null,
  events: EventEnvelope[],
  updatesByThread: Map<string, ConversationItem[]>,
) {
  let next = current
  for (const event of events) {
    next = applyEventToThreadDetail(next, event)
  }
  if (!next) return next

  const threadUpdates = updatesByThread.get(next.thread.id)
  if (!threadUpdates || threadUpdates.length === 0) {
    return next
  }

  let items = next.items
  for (const item of threadUpdates) {
    items = upsertConversationItem(items, item)
  }

  return items === next.items ? next : { ...next, items }
}

export function collectConversationItemUpdates(events: EventEnvelope[]) {
  const passthroughEvents: EventEnvelope[] = []
  const updatesByThread = new Map<string, Map<string, ConversationItem>>()

  for (const event of events) {
    if (
      event.thread_id &&
      (event.event.type === 'conversation-item-added' ||
        event.event.type === 'conversation-item-updated')
    ) {
      let threadUpdates = updatesByThread.get(event.thread_id)
      if (!threadUpdates) {
        threadUpdates = new Map<string, ConversationItem>()
        updatesByThread.set(event.thread_id, threadUpdates)
      }
      threadUpdates.set(`${event.event.item.kind}:${event.event.item.id}`, event.event.item)
      continue
    }

    passthroughEvents.push(event)
  }

  return {
    passthroughEvents,
    updatesByThread: new Map(
      [...updatesByThread.entries()].map(([threadId, items]) => [threadId, [...items.values()]]),
    ),
  }
}

export function markInteractiveRequestResolved(
  items: ConversationItem[],
  requestId: string,
): ConversationItem[] {
  return items.map((item) =>
    item.kind === 'interactive_request' && item.id === requestId
      ? { ...item, resolved: true }
      : item,
  )
}

export function loadPersistedRemoteSession(): PersistedRemoteSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedRemoteSession
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.version !== REMOTE_SESSION_STORAGE_VERSION) {
      window.localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export function persistRemoteSession(value: PersistedRemoteSession | null) {
  try {
    if (!value) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...value,
        version: REMOTE_SESSION_STORAGE_VERSION,
      } satisfies PersistedRemoteSession),
    )
  } catch {
    // Ignore local persistence failures and keep the live session running.
  }
}

export function loadOrCreateClientKeyPair() {
  try {
    const stored = window.localStorage.getItem(CLIENT_KEYPAIR_STORAGE_KEY)
    if (stored) {
      return restoreBoxKeyPair(stored)
    }
  } catch {
    try {
      window.localStorage.removeItem(CLIENT_KEYPAIR_STORAGE_KEY)
    } catch {
      // Ignore storage cleanup failures.
    }
  }

  const generated = generateBoxKeyPair()
  try {
    window.localStorage.setItem(CLIENT_KEYPAIR_STORAGE_KEY, secretKeyToBase64(generated))
  } catch {
    // Ignore storage failures and keep the in-memory keypair.
  }
  return generated
}

export function loadPendingActionIds() {
  try {
    const raw = window.localStorage.getItem(PENDING_ACTIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function persistPendingActionIds(actionIds: string[]) {
  try {
    if (actionIds.length === 0) {
      window.localStorage.removeItem(PENDING_ACTIONS_KEY)
      return
    }
    window.localStorage.setItem(PENDING_ACTIONS_KEY, JSON.stringify(actionIds))
  } catch {
    // Ignore local persistence failures.
  }
}

export function clearPendingActionIds() {
  try {
    window.localStorage.removeItem(PENDING_ACTIONS_KEY)
  } catch {
    // Ignore local persistence failures.
  }
}

export function shouldDiscardPendingAction(error: unknown) {
  if (!(error instanceof Error)) return false
  return /failed with status 401|failed with status 404|queued action not found|invalid session token/i.test(
    error.message,
  )
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function waitForPollInterval(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)

    const handleAbort = () => {
      window.clearTimeout(timeout)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

export function relayHostLabel(relayUrl: string) {
  try {
    return new URL(relayUrl).host
  } catch {
    return relayUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
  }
}

export function maskIdentifier(value: string | null | undefined) {
  if (!value) return 'Unavailable'
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

export function isClaimedPairingError(message: string | null) {
  return !!message && /pairing has already been claimed/i.test(message)
}

export function isInvalidSavedSessionError(message: string | null) {
  return !!message && /invalid session token|session not found|trusted device/i.test(message)
}

export function deriveConnectionHelpState({
  connectionStatus,
  desktopOnline,
  error,
  hasSessionKey,
  isConnected,
}: {
  connectionStatus: string
  desktopOnline: boolean
  error: string | null
  hasSessionKey: boolean
  isConnected: boolean
}): ConnectionHelpState | null {
  if (isClaimedPairingError(error)) {
    return {
      tone: 'warning',
      title: 'This pairing code has already been used',
      description:
        'That usually means this browser already claimed the code before, or another device finished the pairing first.',
      steps: [
        'If this is the same browser you paired earlier, reset the saved browser connection and reopen the pairing link.',
        'If this is a different device, generate a fresh pairing code from FalconDeck on desktop.',
        'Avoid sharing screenshots of this screen while the pairing code is active.',
      ],
    }
  }

  if (isInvalidSavedSessionError(error)) {
    return {
      tone: 'warning',
      title: 'Saved browser pairing is no longer valid',
      description:
        'FalconDeck still has old local browser state, but the relay or desktop no longer accepts that trusted session.',
      steps: [
        'Reset the saved browser connection below.',
        'Open a fresh pairing link or scan a new QR code from desktop.',
        'If the desktop still shows this browser as trusted, remove it there before pairing again.',
      ],
    }
  }

  if (isConnected && connectionStatus.startsWith('connected') && !desktopOnline) {
    return {
      tone: 'warning',
      title: 'Browser connected, desktop retrying',
      description:
        'Your browser is attached to the relay, but the desktop daemon is not currently online for this remote session.',
      steps: [
        'Keep FalconDeck open on your desktop and give it a few seconds to reconnect.',
        'If it stays stuck, generate a fresh pairing code from desktop.',
        'If this browser looks stale, reset the saved browser connection and pair again.',
      ],
    }
  }

  if (connectionStatus.includes('claimed') && !hasSessionKey) {
    return {
      tone: 'warning',
      title: 'Waiting for encrypted session setup',
      description:
        'The browser has claimed the pairing code and is now waiting for the desktop to complete the secure handshake.',
      steps: [
        'Keep FalconDeck open on the desktop that created this pairing code.',
        'If setup does not finish, create a fresh pairing code and try again.',
      ],
    }
  }

  if (connectionStatus === 'disconnected') {
    return {
      tone: 'danger',
      title: 'Relay connection dropped',
      description:
        'The browser lost its live connection to the relay, so FalconDeck cannot receive updates from the desktop right now.',
      steps: [
        'Check that this browser can still reach the internet and the relay.',
        'Leave the page open for a moment while FalconDeck retries.',
        'If reconnect keeps failing, reset the saved browser connection and pair again.',
      ],
    }
  }

  if (error) {
    return {
      tone: 'danger',
      title: 'Remote connection needs attention',
      description: error,
      steps: [
        'Review the local debug details below before pairing again.',
        'If this looks like stale browser state, reset the saved browser connection.',
      ],
    }
  }

  return null
}
