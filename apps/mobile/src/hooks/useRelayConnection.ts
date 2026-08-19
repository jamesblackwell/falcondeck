import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

import {
  captureRelayDisplayFrame,
  encryptedDaemonEventEnvelope,
  normalizeDaemonSnapshot,
  parseDaemonEvents as parseRemoteDaemonEvents,
  publicKeyToBase64,
  relayBacklogWouldOverflow,
  REMOTE_EVENT_BATCH_FEATURE,
  relayReconnectDelayMs,
  resolveRelayTruncationCursor,
} from '@falcondeck/client-core'
import type {
  DaemonSnapshot,
  EventEnvelope,
  MachinePresence,
  RelayServerMessage,
  RelayUpdate,
  RelayWebSocketTicketResponse,
} from '@falcondeck/client-core'

import { fetchWithTimeout } from '@/lib/fetch-timeout'
import { clearPushToken, isPushEnabled, registerPushToken } from '@/lib/push-notifications'
import { realtimeAudioPlayer } from '@/lib/realtime-audio-player'
import { logConnection } from '@/store/connection-log-store'
import { persistSessionCacheNow, useRelayStore, useSessionStore } from '@/store'

// The relay disconnects peers silent for 45s; the daemon pings every 15s.
const RELAY_PING_INTERVAL_MS = 15_000
// Only treat a connection as healthy (and reset backoff) after it stays open this long.
const RELAY_BACKOFF_RESET_MS = 10_000
const MAX_PENDING_ENCRYPTED_UPDATES = 1_000
const MAX_PENDING_SNAPSHOT_EVENTS = 2_000
// Retry cadence for asking the daemon to republish the session bootstrap
// while the connection is up but the session data key is missing.
const BOOTSTRAP_REQUEST_RETRY_MS = 30_000
const SNAPSHOT_REFETCH_DELAY_MS = 1_000
// A WebSocket stuck in CONNECTING never fires close on some platforms; give
// the handshake a hard deadline so the UI cannot park at "Connecting…".
const RELAY_CONNECT_TIMEOUT_MS = 20_000

/**
 * iOS kills the relay socket when the app backgrounds; waiting for the dead
 * socket to error plus the backoff delay makes resume feel slow. When the app
 * returns to the foreground and the socket is not OPEN, reconnect immediately.
 * Transitions away from 'active' do nothing — the OS tears the socket down.
 */
export function shouldReconnectOnAppForeground(
  nextAppState: string,
  socketReadyState: number | null,
) {
  return nextAppState === 'active' && socketReadyState !== WebSocket.OPEN
}
/**
 * Matches only the relay's own structured error strings (exact, anchored) for
 * conditions that permanently invalidate the saved session. Substring or
 * status-code matching is dangerous here: a proxy/CDN 404 or an unrelated
 * message that merely mentions these words must never wipe local key material.
 */
export function isInvalidSavedSessionError(message: string | null) {
  return !!message && /^(invalid session token|session not found|trusted device is revoked or missing|trusted device is revoked|trusted device not found)$/i.test(
    message.trim(),
  )
}

/**
 * A snapshot response is safe when every event that raced it has finished
 * flushing into the replay buffer. An active flush may still be decrypting an
 * earlier update, while an overflow means the buffer is incomplete; either
 * condition requires a fresh request instead of applying a known-stale base.
 */
export function shouldDeferSnapshotApplication(
  relayFlushInProgress: boolean,
  snapshotRaceOverflowed: boolean,
) {
  return relayFlushInProgress || snapshotRaceOverflowed
}

/**
 * A replay cursor may only be checkpointed after every event it represents is
 * either in the applied snapshot or has been applied directly. During a
 * snapshot race, advancing the durable cursor first can make a crash restart
 * after the cursor and permanently skip the events that were still buffered.
 */
export function canCheckpointReplayCursor(params: {
  authoritativeSnapshot: boolean
  snapshotRequestInFlight: boolean
  pendingSnapshotEventCount: number
  snapshotRaceOverflowed: boolean
  parkedUpdateCount: number
}) {
  return (
    params.authoritativeSnapshot &&
    !params.snapshotRequestInFlight &&
    params.pendingSnapshotEventCount === 0 &&
    !params.snapshotRaceOverflowed &&
    params.parkedUpdateCount === 0
  )
}

/**
 * Buffers each daemon event at most once while snapshot.current is in flight.
 * Returns true when the bounded buffer cannot safely represent the race and
 * the caller must discard the snapshot response and retry.
 */
export function bufferSnapshotRaceEvent(
  buffer: EventEnvelope[],
  seenSeqs: Set<number>,
  event: EventEnvelope,
  maxEvents = MAX_PENDING_SNAPSHOT_EVENTS,
) {
  if (seenSeqs.has(event.seq)) return false
  if (buffer.length >= maxEvents) return true
  seenSeqs.add(event.seq)
  buffer.push(event)
  return false
}

/**
 * A truncated sync can carry no replayable updates at all (e.g. an idle
 * session aged out server-side). The cursor still has to advance to the
 * truncation point or every reconnect replays the lost window forever — but
 * only once nothing is parked, because parked updates must stay ahead of the
 * cursor until they are actually processed. Returns the cursor seq to adopt,
 * or null when no advance should happen.
 */

/**
 * True while this launch still owes the user an authoritative snapshot.
 *
 * `snapshot` alone is not enough: the offline cache hydrates it before the
 * socket is even open, so guarding on `!snapshot` skips the fetch entirely on
 * every warm start — leaving the "Syncing your projects…" banner up forever
 * (hasSyncedOnce never flips) on top of a list that is only as fresh as the
 * relay replay. hasSyncedOnce survives reconnects, so this still costs at most
 * one snapshot RPC per app session.
 */
function needsAuthoritativeSnapshot() {
  return !useSessionStore.getState().snapshot || !useRelayStore.getState().hasSyncedOnce
}

export function useRelayConnection() {
  const sessionId = useRelayStore((s) => s.sessionId)
  const deviceId = useRelayStore((s) => s.deviceId)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const hasSyncedOnce = useRelayStore((s) => s.hasSyncedOnce)
  const snapshot = useSessionStore((s) => s.snapshot)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotRetryAttempt = useRef(0)
  const reconnectAttempt = useRef(0)
  const pendingEncrypted = useRef<RelayUpdate[]>([])
  const evictedWhileParked = useRef(false)
  const pendingTruncationNextSeq = useRef<number | null>(null)
  // A sync response carries the relay's current presence separately from its
  // replay window. Presence updates already in that window predate next_seq,
  // so they must not overwrite the authoritative value after a reconnect.
  const syncedPresenceFloor = useRef<number | null>(null)
  const pendingRelayUpdates = useRef<RelayUpdate[]>([])
  const ephemeralAudioChain = useRef<Promise<void>>(Promise.resolve())
  const relayFlushFrame = useRef<number | null>(null)
  const relayFlushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relayFlushInProgress = useRef(false)
  const relayFlushGeneration = useRef(0)
  const snapshotRequestInFlight = useRef(false)
  const snapshotRequestGeneration = useRef(0)
  const pendingSnapshotEvents = useRef<EventEnvelope[]>([])
  const pendingSnapshotEventSeqs = useRef<Set<number>>(new Set())
  const snapshotRaceOverflowed = useRef(false)
  const pendingSnapshotCursor = useRef<number | null>(null)
  const snapshotAfterCrypto = useRef(false)
  // A snapshot request that arrived while the daemon was offline (or its RPC
  // methods unregistered) is deferred, not dropped: the next presence update
  // that shows the daemon back re-issues it. Without this, an ungated request
  // (history truncation, post-bootstrap recovery) that hits the presence gate
  // latches isSyncing with nothing scheduled to clear it.
  const snapshotWaitingForDaemon = useRef(false)
  const [reconnectGeneration, setReconnectGeneration] = useState(0)

  const checkpointPendingSnapshotCursor = useCallback((allowSnapshotRequestInFlight = false) => {
    const relay = useRelayStore.getState()
    if (!useSessionStore.getState().snapshot) return
    if (!allowSnapshotRequestInFlight && snapshotRequestInFlight.current) return
    if (
      pendingEncrypted.current.length > 0 ||
      pendingSnapshotEvents.current.length > 0 ||
      snapshotRaceOverflowed.current
    ) return

    const snapshotCursor = pendingSnapshotCursor.current
    const truncationCursor = resolveRelayTruncationCursor(
      pendingTruncationNextSeq.current,
      pendingEncrypted.current.length,
    )
    if (snapshotCursor === null && truncationCursor === null) return

    relay._setLastReceivedSeq(Math.max(
      relay._getLastReceivedSeq(),
      snapshotCursor ?? 0,
      truncationCursor ?? 0,
    ))
    persistSessionCacheNow()
    relay._persistSession()
    pendingSnapshotCursor.current = null
    if (truncationCursor !== null) {
      pendingTruncationNextSeq.current = null
    }
  }, [])

  const requestSnapshot = useCallback(async () => {
    const relay = useRelayStore.getState()
    if (!relay._getSessionCrypto() || snapshotRequestInFlight.current) return
    const presence = relay.machinePresence
    if (!presence?.daemon_connected || presence.daemon_rpc_ready === false) {
      snapshotWaitingForDaemon.current = true
      relay._setSyncing(true)
      return
    }
    snapshotWaitingForDaemon.current = false

    const requestGeneration = snapshotRequestGeneration.current + 1
    snapshotRequestGeneration.current = requestGeneration
    snapshotRequestInFlight.current = true
    relay._startSyncAttempt()
    pendingSnapshotEvents.current = []
    pendingSnapshotEventSeqs.current.clear()
    snapshotRaceOverflowed.current = false
    // Keep any cursor held by a decrypt that completed between snapshot
    // attempts. It belongs to this relay session and can only be durably
    // acknowledged after the replacement snapshot lands.
    let shouldRefetch = false
    try {
      const nextSnapshot = normalizeDaemonSnapshot(
        await relay._callRpc<DaemonSnapshot>(
          'snapshot.current',
          { include_archived_threads: false },
          { requestIdPrefix: 'mobile-snapshot' },
        ),
      )
      if (requestGeneration !== snapshotRequestGeneration.current) return
      if (
        shouldDeferSnapshotApplication(
          relayFlushInProgress.current,
          snapshotRaceOverflowed.current,
        )
      ) {
        // The flush has not yet finished buffering every raced event, or the
        // bounded buffer overflowed. Never knowingly replace live state with
        // an incomplete snapshot; retry after the frame-batched flush settles.
        shouldRefetch = true
        return
      }
      const racedEvents = pendingSnapshotEvents.current
      useSessionStore.getState().applyDaemonEvents([
        {
          seq: 0,
          emitted_at: new Date().toISOString(),
          workspace_id: null,
          thread_id: null,
          event: { type: 'snapshot', snapshot: nextSnapshot },
        },
        ...racedEvents,
      ])
      pendingSnapshotEvents.current = []
      pendingSnapshotEventSeqs.current.clear()
      snapshotRaceOverflowed.current = false

      // The cursor for updates consumed during the snapshot race was held
      // back. Commit it only after the fresh snapshot and every raced event
      // have been applied together. A truncation cursor can be adopted at the
      // same point because this snapshot is the recovery base for the lost
      // history.
      if (
        canCheckpointReplayCursor({
          authoritativeSnapshot: true,
          snapshotRequestInFlight: false,
          pendingSnapshotEventCount: 0,
          snapshotRaceOverflowed: false,
          parkedUpdateCount: pendingEncrypted.current.length,
        }) &&
        (pendingSnapshotCursor.current !== null || pendingTruncationNextSeq.current !== null)
      ) {
        // Keep the explicit invariant check here as documentation for the
        // snapshot RPC path; the shared helper also flushes the cache before
        // acknowledging the held cursor.
        checkpointPendingSnapshotCursor(true)
      }
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }
      relay._setError(null)
      relay._finishSync()
    } catch (e) {
      if (requestGeneration !== snapshotRequestGeneration.current) return
      const message = e instanceof Error ? e.message : 'Failed to load snapshot'
      // Sync failures are almost always a reconnect flap that the retry loop
      // absorbs in seconds; they belong in the sync banner's diagnostics (via
      // _setSyncRetry below), NOT the red error toast. Painting the toast here
      // bombarded users with "Your Mac disconnected while snapshot.current was
      // running" for outages that self-healed before they could read it.
      let nextRetryAt: number | null = null
      // Retry every failed snapshot the app decided it needed — including
      // recovery fetches after the first sync (history truncation, parked-key
      // eviction), otherwise one failure silently abandons the resync. When
      // the daemon is genuinely offline, the retry lands in the presence gate
      // above and waits for it instead of spinning.
      if (!snapshotRetryTimer.current) {
        const delay = Math.min(1000 * 2 ** snapshotRetryAttempt.current, 5_000)
        snapshotRetryAttempt.current += 1
        nextRetryAt = Date.now() + delay
        snapshotRetryTimer.current = setTimeout(() => {
          snapshotRetryTimer.current = null
          // Deliberate self-reference for the retry: the callback has no deps
          // and all mutable state lives in refs, so the binding stays valid.
          // eslint-disable-next-line react-hooks/immutability
          void requestSnapshot()
        }, delay)
      }
      relay._setSyncRetry(message, nextRetryAt)
    } finally {
      if (requestGeneration === snapshotRequestGeneration.current) {
        snapshotRequestInFlight.current = false
        // The sync indicator tracks the whole catch-up, not this one RPC: a
        // queued refetch or error retry means the list is still stale.
        relay._setSyncing(shouldRefetch || snapshotRetryTimer.current !== null)
        pendingSnapshotEvents.current = []
        pendingSnapshotEventSeqs.current.clear()
        snapshotRaceOverflowed.current = false
        if (shouldRefetch && !snapshotRefetchTimer.current) {
          relay._setSyncRetry(null, Date.now() + SNAPSHOT_REFETCH_DELAY_MS)
          snapshotRefetchTimer.current = setTimeout(() => {
            snapshotRefetchTimer.current = null
            void requestSnapshot()
          }, SNAPSHOT_REFETCH_DELAY_MS)
        }
      }
    }
  }, [checkpointPendingSnapshotCursor])

  const processRpcResult = useCallback(async (payload: Extract<RelayServerMessage, { type: 'rpc-result' }>) => {
    const relay = useRelayStore.getState()
    if (await relay._handleRpcResult(payload)) {
      return
    }
    if (!payload.ok) {
      // A reply landing after its 35s client timeout is diagnostics, not
      // something the user can act on — keep it out of the error toast.
      const reason = payload.failure?.replace(/_/g, ' ') ?? 'no relay detail'
      logConnection('warn', 'Late remote response failed', reason)
    }
  }, [])

  const flushRelayUpdates = useCallback(async () => {
    if (relayFlushInProgress.current) return

    const flushGeneration = relayFlushGeneration.current
    relayFlushInProgress.current = true

    try {
      if (pendingRelayUpdates.current.length === 0) return
      if (flushGeneration !== relayFlushGeneration.current) return
      // Capture one paint-frame batch. Updates that arrive while async
      // decryption is running stay queued for the next scheduled frame.
        const relay = useRelayStore.getState()
        const batch = captureRelayDisplayFrame(pendingRelayUpdates.current)
        const daemonEvents: EventEnvelope[] = []
        let nextPresence: MachinePresence | null | undefined = undefined
        let shouldPersistCursor = false
        let deferredBootstrapSeq: number | null = null

        // The cursor may only advance for updates that were actually consumed;
        // otherwise a parked or failed update can never be replayed by a later
        // sync. While updates are parked the cursor must stay before them.
        const advanceCursor = (seq: number) => {
          if (pendingEncrypted.current.length > 0) return
          if (snapshotRequestInFlight.current || !useSessionStore.getState().snapshot) {
            pendingSnapshotCursor.current = Math.max(
              pendingSnapshotCursor.current ?? 0,
              seq,
            )
            return
          }
          relay._setLastReceivedSeq(seq)
          shouldPersistCursor = true
        }

        for (let index = 0; index < batch.length; index += 1) {
          const update = batch[index]

          if (update.body.t === 'session-bootstrap') {
            await relay._processBootstrap(update)
            if (flushGeneration !== relayFlushGeneration.current) return
            if (pendingEncrypted.current.length > 0) {
              batch.splice(index + 1, 0, ...pendingEncrypted.current)
              pendingEncrypted.current = []
              // Keep the cursor before the parked updates until the inserted
              // replay window has been consumed.
              deferredBootstrapSeq = update.seq
            }
            if (evictedWhileParked.current && relay._getSessionCrypto()) {
              // Updates were evicted while parked waiting for this key, so
              // the drained window has a silent gap; rebuild derived state
              // from a fresh snapshot instead of trusting the partial replay.
              evictedWhileParked.current = false
              snapshotAfterCrypto.current = true
            }
            if (deferredBootstrapSeq === null) {
              advanceCursor(update.seq)
            }
            if (snapshotAfterCrypto.current && relay._getSessionCrypto()) {
              snapshotAfterCrypto.current = false
              void requestSnapshot()
            }
            continue
          }

          if (update.body.t === 'presence') {
            // The sync response's presence is a later, authoritative view of
            // every replayed update. A subsequent live update has a sequence
            // at or above the sync response's next_seq and may replace it.
            if (
              syncedPresenceFloor.current === null ||
              update.seq >= syncedPresenceFloor.current
            ) {
              nextPresence = update.body.presence
            }
            advanceCursor(update.seq)
            continue
          }

          if (update.body.t === 'action-status') {
            advanceCursor(update.seq)
            continue
          }

          if (update.body.t !== 'encrypted') {
            advanceCursor(update.seq)
            continue
          }

          const sessionCrypto = relay._getSessionCrypto()
          if (!sessionCrypto) {
            if (pendingEncrypted.current.length >= MAX_PENDING_ENCRYPTED_UPDATES) {
              console.warn('Dropping oldest parked encrypted relay update; buffer is full')
              pendingEncrypted.current.shift()
              evictedWhileParked.current = true
            }
            pendingEncrypted.current.push(update)
            continue
          }

          try {
            const decrypted = await relay._decryptJson(update.body.envelope)
            if (flushGeneration !== relayFlushGeneration.current) return
            advanceCursor(update.seq)
            const events = parseRemoteDaemonEvents(decrypted)
            for (const event of events) {
              realtimeAudioPlayer.handleEvent(event)
              daemonEvents.push(event)
              if (snapshotRequestInFlight.current) {
                snapshotRaceOverflowed.current ||= bufferSnapshotRaceEvent(
                  pendingSnapshotEvents.current,
                  pendingSnapshotEventSeqs.current,
                  event,
                )
              }
            }
          } catch (e) {
            // Decryption failed: the cursor is not advanced for this update.
            // If nothing later in the batch decrypts either, a later sync
            // replays it; if a later update does decrypt, the cursor advances
            // past this one — skipping a single undecryptable update is the
            // accepted trade-off over stalling the stream.
            relay._setError(e instanceof Error ? e.message : 'Failed to decrypt update')
          }
        }

        if (deferredBootstrapSeq !== null) {
          advanceCursor(deferredBootstrapSeq)
        }

        if (flushGeneration !== relayFlushGeneration.current) return

        if (nextPresence !== undefined) {
          relay._setMachinePresence(nextPresence)
        }

        if (daemonEvents.length > 0) {
          useSessionStore.getState().applyDaemonEvents(daemonEvents)
        }

        checkpointPendingSnapshotCursor()

        if (
          shouldPersistCursor &&
          canCheckpointReplayCursor({
            authoritativeSnapshot: !!useSessionStore.getState().snapshot,
            snapshotRequestInFlight: snapshotRequestInFlight.current,
            pendingSnapshotEventCount: pendingSnapshotEvents.current.length,
            snapshotRaceOverflowed: snapshotRaceOverflowed.current,
            parkedUpdateCount: pendingEncrypted.current.length,
          })
        ) {
          persistSessionCacheNow()
          relay._persistSession()
        }

        if (
          relay._getSessionCrypto() &&
          (needsAuthoritativeSnapshot() || snapshotWaitingForDaemon.current)
        ) {
          void requestSnapshot()
        }

      if (flushGeneration !== relayFlushGeneration.current) return

      // A truncated sync may deliver no replayable updates at all (idle
      // session aged out), so the per-update cursor advance above never runs;
      // adopt the truncation point here once nothing is parked, otherwise the
      // cursor stays stuck and every reconnect replays the truncation.
      const truncationCursor = pendingRelayUpdates.current.length === 0 && canCheckpointReplayCursor({
        authoritativeSnapshot: !!useSessionStore.getState().snapshot,
        snapshotRequestInFlight: snapshotRequestInFlight.current,
        pendingSnapshotEventCount: pendingSnapshotEvents.current.length,
        snapshotRaceOverflowed: snapshotRaceOverflowed.current,
        parkedUpdateCount: pendingEncrypted.current.length,
      })
        ? resolveRelayTruncationCursor(
            pendingTruncationNextSeq.current,
            pendingEncrypted.current.length,
          )
        : null
      if (truncationCursor !== null) {
        pendingTruncationNextSeq.current = null
        const relay = useRelayStore.getState()
        relay._setLastReceivedSeq(truncationCursor)
        persistSessionCacheNow()
        relay._persistSession()
      }
    } finally {
      relayFlushInProgress.current = false
      if (pendingRelayUpdates.current.length > 0 && relayFlushFrame.current === null && relayFlushTimeout.current === null) {
        if (globalThis.requestAnimationFrame) {
          relayFlushFrame.current = globalThis.requestAnimationFrame(() => {
            relayFlushFrame.current = null
            void flushRelayUpdates()
          })
        } else {
          relayFlushTimeout.current = globalThis.setTimeout(() => {
            relayFlushTimeout.current = null
            void flushRelayUpdates()
          }, 0)
        }
      }
    }
  }, [checkpointPendingSnapshotCursor, requestSnapshot])

  const scheduleRelayFlush = useCallback(() => {
    if (relayFlushFrame.current !== null || relayFlushTimeout.current !== null) {
      return
    }

    if (globalThis.requestAnimationFrame) {
      relayFlushFrame.current = globalThis.requestAnimationFrame(() => {
        relayFlushFrame.current = null
        void flushRelayUpdates()
      })
      return
    }

    relayFlushTimeout.current = globalThis.setTimeout(() => {
      relayFlushTimeout.current = null
      void flushRelayUpdates()
    }, 0)
  }, [flushRelayUpdates])

  useEffect(() => {
    const relay = useRelayStore.getState()
    if (!sessionId) return

    const clientToken = relay._getClientToken()
    if (!clientToken) return

    let isCurrent = true
    let shouldReconnect = true
    let activeSocket: WebSocket | null = null
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let backoffResetTimer: ReturnType<typeof setTimeout> | null = null
    // Effect-run-local timers: a component-level ref here would let a stale
    // socket's close handler cancel the CURRENT run's retry chain (the old
    // "bootstrap retry silently stops" bug).
    let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null
    let connectTimeout: ReturnType<typeof setTimeout> | null = null
    const snapshotEventSeqs = pendingSnapshotEventSeqs.current
    const relayUrl = relay.relayUrl.trim().replace(/\/$/, '')
    const wsUrl = relayUrl.startsWith('https://')
      ? `wss://${relayUrl.slice('https://'.length)}`
      : relayUrl.startsWith('http://')
        ? `ws://${relayUrl.slice('http://'.length)}`
        : relayUrl

    relay._setConnectionStatus('connecting')
    relay._setMachinePresence(null)
    relay._setError(null)
    pendingEncrypted.current = []
    evictedWhileParked.current = false
    pendingTruncationNextSeq.current = null
    syncedPresenceFloor.current = null
    pendingRelayUpdates.current = []
    relayFlushGeneration.current += 1
    snapshotRequestGeneration.current += 1
    snapshotRequestInFlight.current = false
    relay._setSyncing(false)
    pendingSnapshotEvents.current = []
    snapshotEventSeqs.clear()
    snapshotRaceOverflowed.current = false
    pendingSnapshotCursor.current = null
    snapshotAfterCrypto.current = false
    snapshotWaitingForDaemon.current = false
    snapshotRetryAttempt.current = 0
    if (snapshotRetryTimer.current) {
      clearTimeout(snapshotRetryTimer.current)
      snapshotRetryTimer.current = null
    }
    if (snapshotRefetchTimer.current) {
      clearTimeout(snapshotRefetchTimer.current)
      snapshotRefetchTimer.current = null
    }
    // A fresh connection run starts with fresh sync timers; stale attempt
    // counts and errors from the previous run otherwise defeat the sync
    // banner's grace period on every warm reconnect.
    relay._resetSyncDiagnostics()
    if (relayFlushFrame.current !== null && globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame(relayFlushFrame.current)
      relayFlushFrame.current = null
    }
    if (relayFlushTimeout.current !== null) {
      clearTimeout(relayFlushTimeout.current)
      relayFlushTimeout.current = null
    }

    const clearSocketTimers = () => {
      if (pingInterval !== null) {
        clearInterval(pingInterval)
        pingInterval = null
      }
      if (backoffResetTimer !== null) {
        clearTimeout(backoffResetTimer)
        backoffResetTimer = null
      }
      if (bootstrapRetryTimer !== null) {
        clearTimeout(bootstrapRetryTimer)
        bootstrapRetryTimer = null
      }
      if (connectTimeout !== null) {
        clearTimeout(connectTimeout)
        connectTimeout = null
      }
    }

    // A restored trusted session may hold the client token and key pair but
    // no session data key; without it the encrypted channel is unusable. Ask
    // the daemon for a fresh bootstrap over the relay's plaintext ephemeral
    // channel once per connect, retrying every 30s while the key is absent.
    // The reply lands as a session-bootstrap update through the normal replay
    // path and _processBootstrap installs the key.
    const requestBootstrapWhileKeyless = () => {
      if (!isCurrent || !shouldReconnect) return
      const current = useRelayStore.getState()
      if (current._getSessionCrypto()) return
      logConnection(
        'info',
        'Asking your Mac to republish the session key…',
        'The encrypted channel needs it before anything can sync.',
      )
      current._requestBootstrap()
      bootstrapRetryTimer = setTimeout(() => {
        bootstrapRetryTimer = null
        requestBootstrapWhileKeyless()
      }, BOOTSTRAP_REQUEST_RETRY_MS)
    }

    const scheduleReconnect = () => {
      // Guards must run BEFORE touching any timers: a stale socket's close
      // event otherwise reaches into the live run and cancels its retry
      // chains.
      if (!isCurrent || !shouldReconnect || !useRelayStore.getState().sessionId) return
      clearSocketTimers()
      realtimeAudioPlayer.stop()
      relay._setConnectionStatus('disconnected')
      relay._setMachinePresence(null)
      relay._setSocket(null)
      relay._failPendingRpcs('Remote connection dropped')
      pendingEncrypted.current = []
      evictedWhileParked.current = false
      pendingTruncationNextSeq.current = null
      syncedPresenceFloor.current = null
      pendingRelayUpdates.current = []
      relayFlushGeneration.current += 1
      snapshotRequestGeneration.current += 1
      snapshotRequestInFlight.current = false
      relay._setSyncing(false)
      pendingSnapshotEvents.current = []
      snapshotEventSeqs.clear()
      snapshotRaceOverflowed.current = false
      pendingSnapshotCursor.current = null
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }
      if (snapshotRefetchTimer.current) {
        clearTimeout(snapshotRefetchTimer.current)
        snapshotRefetchTimer.current = null
      }
      relay._setSyncRetry(null, null)
      if (relayFlushFrame.current !== null && globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame(relayFlushFrame.current)
        relayFlushFrame.current = null
      }
      if (relayFlushTimeout.current !== null) {
        clearTimeout(relayFlushTimeout.current)
        relayFlushTimeout.current = null
      }

      const delay = relayReconnectDelayMs(reconnectAttempt.current, Math.random(), 15_000)
      reconnectAttempt.current += 1
      logConnection(
        'warn',
        'Connection dropped; reconnecting',
        `Attempt ${reconnectAttempt.current} in ${Math.max(1, Math.round(delay / 1000))}s`,
      )
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null
        setReconnectGeneration((value) => value + 1)
      }, delay)
    }

    const resetInvalidSavedSession = async (message: string) => {
      if (!shouldReconnect) return
      shouldReconnect = false
      await relay.disconnect()
      useRelayStore.getState()._setError(message)
    }

    // iOS kills the socket on background; on foreground, skip the dead-socket
    // error + backoff dance and reconnect right away. Leaving 'active' does
    // nothing — the OS tears the socket down naturally.
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (!isCurrent || !shouldReconnect) return
      if (!shouldReconnectOnAppForeground(nextAppState, activeSocket?.readyState ?? null)) return
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      reconnectAttempt.current = 0
      logConnection('info', 'App returned to the foreground; reconnecting right away.')
      setReconnectGeneration((value) => value + 1)
    })

    void fetchWithTimeout(`${relayUrl}/v1/sessions/${encodeURIComponent(sessionId)}/ws-ticket`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientToken}`,
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(payload?.error ?? `Failed with status ${response.status}`)
        }
        return response.json() as Promise<RelayWebSocketTicketResponse>
      })
      .then((ticket) => {
        if (!isCurrent) return
        const socket = new WebSocket(
          `${wsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket.ticket)}`,
        )
        activeSocket = socket
        relay._setSocket(socket)
        connectTimeout = setTimeout(() => {
          connectTimeout = null
          if (socket.readyState !== WebSocket.OPEN) {
            // close() on a CONNECTING socket fires onclose → scheduleReconnect.
            socket.close()
          }
        }, RELAY_CONNECT_TIMEOUT_MS)

        socket.onopen = () => {
          if (!isCurrent) return
          if (connectTimeout !== null) {
            clearTimeout(connectTimeout)
            connectTimeout = null
          }
          logConnection('success', 'Relay socket connected.')
          // The relay drops peers that stay silent for 45s.
          pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }))
            }
          }, RELAY_PING_INTERVAL_MS)
          // Resetting backoff immediately would defeat it when the relay
          // closes the socket right after the handshake.
          backoffResetTimer = setTimeout(() => {
            backoffResetTimer = null
            reconnectAttempt.current = 0
          }, RELAY_BACKOFF_RESET_MS)
          relay._setConnectionStatus('connected')
          relay._sendMessage({
            type: 'ephemeral',
            body: {
              kind: 'client-capabilities',
              features: [REMOTE_EVENT_BATCH_FEATURE],
            },
          })
          relay._sendMessage({ type: 'sync', after_seq: relay._getLastReceivedSeq() })
          if (!relay._getSessionCrypto()) {
            requestBootstrapWhileKeyless()
          }
        }

        socket.onmessage = (msg) => {
          let payload: RelayServerMessage
          try {
            payload = JSON.parse(msg.data) as RelayServerMessage
          } catch {
            relay._setError('Received malformed relay message')
            socket.close()
            return
          }

          switch (payload.type) {
            case 'ready':
              if (relay._getSessionCrypto()) {
                relay._setConnectionStatus('encrypted')
              }
              break
            case 'sync':
              if (
                relayBacklogWouldOverflow(
                  pendingRelayUpdates.current.length,
                  payload.updates.length,
                )
              ) {
                console.warn('Remote event backlog exceeded the safe limit; reconnecting for snapshot recovery')
                logConnection(
                  'warn',
                  'Event backlog overflowed; reconnecting for snapshot recovery.',
                )
                socket.close()
                return
              }
              if (payload.presence) {
                syncedPresenceFloor.current = payload.next_seq
                relay._setMachinePresence(payload.presence)
              }
              if (payload.history_truncated) {
                // Updates were lost server-side; recover derived state from a
                // fresh snapshot, but keep the offline cache so the UI does
                // not go blank if the app restarts before it arrives. The
                // cursor is left to the flush: retained updates advance it as
                // they are consumed, and the truncation's next_seq is adopted
                // at flush end so a truncated sync with no updates at all
                // still advances past the lost window.
                pendingTruncationNextSeq.current = Math.max(
                  pendingTruncationNextSeq.current ?? 0,
                  payload.next_seq,
                )
                useSessionStore.getState().reset({
                  preserveCache: true,
                  preserveSelection: true,
                })
                if (relay._getSessionCrypto()) {
                  void requestSnapshot()
                } else {
                  snapshotAfterCrypto.current = true
                }
              }
              pendingRelayUpdates.current.push(...payload.updates)
              scheduleRelayFlush()
              if (
                relay._getSessionCrypto() &&
                (needsAuthoritativeSnapshot() || snapshotWaitingForDaemon.current)
              ) {
                void requestSnapshot()
              }
              break
            case 'update':
              if (relayBacklogWouldOverflow(pendingRelayUpdates.current.length, 1)) {
                console.warn('Remote event backlog exceeded the safe limit; reconnecting for snapshot recovery')
                logConnection(
                  'warn',
                  'Event backlog overflowed; reconnecting for snapshot recovery.',
                )
                socket.close()
                return
              }
              pendingRelayUpdates.current.push(payload.update)
              scheduleRelayFlush()
              break
            case 'ephemeral': {
              // The daemon refuses bootstrap requests from bundles it does
              // not recognize (e.g. after its trusted list was reset). Without
              // surfacing this, the pairing screen spins on "Securing
              // session…" forever with no hint that re-pairing is required.
              const refusal = payload.body as { kind?: unknown; client_public_key?: unknown } | null
              if (refusal?.kind === 'bootstrap-refused') {
                const keyPair = useRelayStore.getState()._getKeyPair()
                if (
                  keyPair &&
                  typeof refusal.client_public_key === 'string' &&
                  refusal.client_public_key === publicKeyToBase64(keyPair) &&
                  !useRelayStore.getState()._getSessionCrypto()
                ) {
                  relay._setError(
                    'The desktop does not recognize this device. Start over and pair again.',
                  )
                }
                break
              }
              const envelope = encryptedDaemonEventEnvelope(payload.body)
              if (!envelope) break
              const ephemeralGeneration = relayFlushGeneration.current
              ephemeralAudioChain.current = ephemeralAudioChain.current
                .then(async () => {
                  if (!isCurrent || ephemeralGeneration !== relayFlushGeneration.current) return
                  const current = useRelayStore.getState()
                  const crypto = current._getSessionCrypto()
                  if (!crypto) return
                  const events = parseRemoteDaemonEvents(await current._decryptJson(envelope))
                  if (
                    !isCurrent ||
                    ephemeralGeneration !== relayFlushGeneration.current ||
                    crypto !== useRelayStore.getState()._getSessionCrypto()
                  ) return
                  for (const event of events) {
                    realtimeAudioPlayer.handleEvent(event)
                    if (event.event.type === 'realtime-item-added') {
                      useSessionStore.getState().applyDaemonEvent(event)
                    }
                  }
                })
                .catch((error: unknown) => {
                  if (isCurrent && ephemeralGeneration === relayFlushGeneration.current) {
                    useRelayStore.getState()._setError(
                      error instanceof Error
                        ? error.message
                        : 'Failed to decrypt live audio event',
                    )
                  }
                })
              break
            }
            case 'rpc-result':
              void processRpcResult(payload)
              break
            case 'presence':
              relay._setMachinePresence(payload.presence)
              if (
                relay._getSessionCrypto() &&
                (needsAuthoritativeSnapshot() || snapshotWaitingForDaemon.current)
              ) {
                void requestSnapshot()
              }
              break
            case 'error':
              relay._setError(payload.message)
              if (isInvalidSavedSessionError(payload.message)) {
                void resetInvalidSavedSession(payload.message)
              }
              break
          }
        }

        socket.onclose = () => {
          scheduleReconnect()
        }
      })
      .catch((error) => {
        if (!isCurrent) return
        const message = error instanceof Error ? error.message : 'Failed to connect to relay'
        if (isInvalidSavedSessionError(message)) {
          void resetInvalidSavedSession(message)
          return
        }
        // Reconnect handles it; the toast would flash on every retry of an
        // outage the connecting banner is already narrating.
        logConnection('error', 'Could not reach the relay', message)
        scheduleReconnect()
      })

    return () => {
      isCurrent = false
      shouldReconnect = false
      realtimeAudioPlayer.stop()
      appStateSubscription.remove()
      clearSocketTimers()
      activeSocket?.close()
      relay._setSocket(null)
      relay._failPendingRpcs('Remote connection closed')
      pendingEncrypted.current = []
      evictedWhileParked.current = false
      pendingTruncationNextSeq.current = null
      pendingRelayUpdates.current = []
      relayFlushGeneration.current += 1
      snapshotRequestGeneration.current += 1
      snapshotRequestInFlight.current = false
      pendingSnapshotEvents.current = []
      snapshotEventSeqs.clear()
      snapshotRaceOverflowed.current = false
      pendingSnapshotCursor.current = null
      snapshotRetryAttempt.current = 0
      if (snapshotRetryTimer.current) {
        clearTimeout(snapshotRetryTimer.current)
        snapshotRetryTimer.current = null
      }
      if (snapshotRefetchTimer.current) {
        clearTimeout(snapshotRefetchTimer.current)
        snapshotRefetchTimer.current = null
      }
      relay._setSyncRetry(null, null)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      if (relayFlushFrame.current !== null && globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame(relayFlushFrame.current)
        relayFlushFrame.current = null
      }
      if (relayFlushTimeout.current !== null) {
        clearTimeout(relayFlushTimeout.current)
        relayFlushTimeout.current = null
      }
    }
  }, [
    sessionId,
    reconnectGeneration,
    processRpcResult,
    requestSnapshot,
    scheduleRelayFlush,
  ])

  useEffect(() => {
    if (!sessionId || !isEncrypted || !needsAuthoritativeSnapshot()) {
      return
    }

    const relay = useRelayStore.getState()
    const socket = relay._getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    void requestSnapshot()
  }, [hasSyncedOnce, isEncrypted, requestSnapshot, sessionId, snapshot])

  // Once the session is usable (encrypted), register this device's push token
  // with the relay so it can alert us when an agent needs attention while the
  // app is disconnected. Skipped entirely while the user has push
  // notifications turned off — the settings toggle re-registers on re-enable.
  // Fire-and-forget: registerPushToken never throws and dedupes
  // re-registration internally.
  const notificationEnabled = useSessionStore(
    (state) => state.snapshot?.preferences.notifications.enabled ?? true,
  )
  useEffect(() => {
    if (!isEncrypted || !sessionId || !deviceId) return
    const relay = useRelayStore.getState()
    const clientToken = relay._getClientToken()
    if (!clientToken) return
    if (!notificationEnabled || !isPushEnabled()) {
      void clearPushToken(relay.relayUrl, sessionId, deviceId, clientToken)
      return
    }
    void registerPushToken(relay.relayUrl, sessionId, deviceId, clientToken)
  }, [deviceId, isEncrypted, notificationEnabled, sessionId])
}
