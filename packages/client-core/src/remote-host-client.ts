// Framework-free relay client for talking to a remote falcondeck-daemon
// (an enrolled server host) over the E2E-encrypted relay. This is the same
// protocol remote-web speaks, extracted so desktop and mobile can hold one
// connection per enrolled host without duplicating the crypto and cursor
// rules. remote-web's App.tsx remains the reference implementation for the
// browser-session flavor (localStorage persistence, snapshot buffering);
// this class stops at "ordered decrypted daemon events + encrypted RPC" and
// leaves snapshot application to the caller.
import {
  base64ToBytes,
  bootstrapSessionCrypto,
  buildPairingPublicKeyBundle,
  bytesToBase64,
  decryptJson,
  decryptJsonBatch,
  deriveIdentityKeyPair,
  encryptJson,
  generateBoxKeyPair,
  identityPublicKeyToBase64,
  publicKeyToBase64,
  restoreBoxKeyPair,
  secretKeyToBase64,
  signPairingClaimChallenge,
  verifyPairingPublicKeyBundle,
  verifySessionKeyMaterial,
  type BoxKeyPair,
  type SessionCryptoState,
} from './crypto'
import { parseDaemonEvents as parseRemoteDaemonEvents } from './remote-events'
import { encryptedDaemonEventEnvelope, isLiveRealtimeEvent } from './realtime-audio'
import {
  REMOTE_SESSION_STORAGE_VERSION,
  relayBacklogWouldOverflow,
  relayReconnectDelayMs,
  type PersistedRemoteSession,
} from './remote-session'
import { RELAY_RPC_TIMEOUT_MS, relayRpcFailureMessage } from './remote-rpc'
import { fetchWithTimeout, WEBSOCKET_CONNECT_TIMEOUT_MS } from './transport-timeout'
import type {
  ClaimPairingRequest,
  ClaimPairingResponse,
  EncryptedEnvelope,
  EventEnvelope,
  MachinePresence,
  PairingChallengeRequest,
  PairingChallengeResponse,
  RelayClientMessage,
  RelayRpcFailureCode,
  RelayServerMessage,
  RelayUpdate,
  RelayWebSocketTicketResponse,
} from './types'

const RELAY_PING_INTERVAL_MS = 15_000
// Only treat a connection as healthy (and reset backoff) after it stays open this long.
const RELAY_BACKOFF_RESET_MS = 10_000
const MAX_PENDING_ENCRYPTED_UPDATES = 1_000
const BOOTSTRAP_REQUEST_RETRY_MS = 30_000

export type RemoteHostStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'encrypted'
  | 'disconnected'

export function isInvalidRemoteSessionError(message: string | null) {
  return (
    !!message &&
    /^(invalid session token|session not found|trusted device is revoked or missing|trusted device is revoked|trusted device not found)$/i.test(
      message.trim(),
    )
  )
}

export function encryptedRpcErrorMessage(payload: unknown) {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Remote action failed'
}

function relayHttpBase(relayUrl: string) {
  return relayUrl.trim().replace(/\/$/, '')
}

function relayWsBase(relayUrl: string) {
  const trimmed = relayHttpBase(relayUrl)
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`
  return trimmed
}

async function relayErrorMessage(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  return payload?.error ?? `Failed with status ${response.status}`
}

// Claims a pairing code against the relay and returns persistable session
// credentials. The daemon publishes a session-bootstrap update shortly after
// the claim; `RemoteHostClient` installs the data key from it on first
// connect and reports the enriched session through `onSessionChanged`.
export async function claimHostPairing(options: {
  relayUrl: string
  pairingCode: string
  deviceLabel: string
  existingSecretKey?: string | null
}): Promise<PersistedRemoteSession> {
  const keyPair = options.existingSecretKey
    ? restoreBoxKeyPair(options.existingSecretKey)
    : generateBoxKeyPair()
  const relayBase = relayHttpBase(options.relayUrl)
  // The relay normalizes pairing codes to uppercase; sign the exact string
  // the relay verifies against.
  const pairingCode = options.pairingCode.trim().toUpperCase()

  // Claims are challenge-bound: fetch a single-use challenge and prove
  // possession of the identity secret key by signing it.
  const challengeResponse = await fetchWithTimeout(`${relayBase}/v1/pairings/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode } satisfies PairingChallengeRequest),
  })
  if (!challengeResponse.ok) throw new Error(await relayErrorMessage(challengeResponse))
  const challenge = (await challengeResponse.json()) as PairingChallengeResponse
  if (!challenge.challenge) throw new Error('Relay challenge response is missing a challenge')

  const claimResponse = await fetchWithTimeout(`${relayBase}/v1/pairings/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairing_code: pairingCode,
      label: options.deviceLabel,
      client_bundle: buildPairingPublicKeyBundle(keyPair),
      challenge_signature: signPairingClaimChallenge(keyPair, pairingCode, challenge.challenge),
    } satisfies ClaimPairingRequest),
  })
  if (!claimResponse.ok) throw new Error(await relayErrorMessage(claimResponse))
  const claim = (await claimResponse.json()) as ClaimPairingResponse
  if (!claim.daemon_bundle) throw new Error('Relay claim response is missing daemon key material')
  verifyPairingPublicKeyBundle(claim.daemon_bundle)

  return {
    version: REMOTE_SESSION_STORAGE_VERSION,
    relayUrl: relayBase,
    pairingCode,
    pairingId: claim.pairing_id,
    sessionId: claim.session_id,
    deviceId: claim.device_id,
    clientToken: claim.client_token,
    clientSecretKey: secretKeyToBase64(keyPair),
    daemonPublicKey: claim.daemon_bundle.public_key,
    daemonIdentityPublicKey: claim.daemon_bundle.identity_public_key,
    dataKey: null,
    lastReceivedSeq: 0,
  }
}

export type RemoteHostClientCallbacks = {
  onStatusChange?: (status: RemoteHostStatus) => void
  onPresence?: (presence: MachinePresence | null) => void
  // Ordered, decrypted daemon events. The caller applies them to its
  // snapshot/thread state (see applySnapshotEvent and friends).
  onEvents?: (events: EventEnvelope[]) => void | Promise<void>
  // Relay history was truncated (or the parked buffer overflowed): derived
  // state is no longer trustworthy and must be rebuilt from snapshot.current.
  onHistoryTruncated?: () => Promise<void>
  // Session credentials changed (data key installed, cursor advanced) —
  // persist the new value.
  onSessionChanged?: (session: PersistedRemoteSession) => void
  onError?: (message: string) => void
  // The relay rejected the saved credentials; the caller should discard the
  // persisted session and surface a re-pair flow. The client stops itself.
  onInvalidSession?: (message: string) => void
}

export class RemoteHostClient {
  private session: PersistedRemoteSession
  private readonly callbacks: RemoteHostClientCallbacks
  private readonly keyPair: BoxKeyPair
  private socket: WebSocket | null = null
  private sessionCrypto: SessionCryptoState | null = null
  private statusValue: RemoteHostStatus = 'idle'
  private presenceValue: MachinePresence | null = null
  private syncedPresenceFloor: number | null = null
  private running = false
  private generation = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private backoffResetTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimeout: ReturnType<typeof setTimeout> | null = null
  private bootstrapRetryInterval: ReturnType<typeof setInterval> | null = null
  private pendingUpdates: RelayUpdate[] = []
  private parkedEncryptedUpdates: RelayUpdate[] = []
  private evictedWhileParked = false
  private pendingTruncationNextSeq: number | null = null
  private snapshotRecoveryRequired = false
  private snapshotRecoveryPromise: Promise<void> | null = null
  private flushInProgress = false
  private rpcCounter = 0
  private ephemeralChain: Promise<void> = Promise.resolve()
  private cursor = 0
  private readonly pendingRpc = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
      method: string
    }
  >()

  constructor(session: PersistedRemoteSession, callbacks: RemoteHostClientCallbacks = {}) {
    this.session = { ...session }
    this.cursor = session.lastReceivedSeq ?? 0
    this.callbacks = callbacks
    this.keyPair = restoreBoxKeyPair(session.clientSecretKey)
    if (session.dataKey) {
      // Rehydrate the encrypted channel from a persisted data key so a
      // restart does not need a daemon round-trip before decrypting.
      this.sessionCrypto = { dataKey: base64ToBytes(session.dataKey), material: null }
    }
  }

  get status() {
    return this.statusValue
  }

  get presence() {
    return this.presenceValue
  }

  get hasSessionKey() {
    return this.sessionCrypto !== null
  }

  get currentSession(): PersistedRemoteSession {
    return { ...this.session }
  }

  start() {
    if (this.running) return
    this.running = true
    this.connect()
  }

  stop() {
    this.running = false
    this.generation += 1
    this.clearTimers()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectPendingRpc(new Error('Relay connection closed'))
    this.socket?.close()
    this.socket = null
    this.setStatus('idle')
    this.setPresence(null)
  }

  async rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Relay connection is not ready yet')
    }
    const crypto = this.sessionCrypto
    if (!crypto) throw new Error('Encrypted relay session is not ready')
    const requestId = `host-${this.rpcCounter++}`
    const encrypted = await encryptJson(crypto.dataKey, params)
    if (
      this.socket !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.sessionCrypto !== crypto
    ) {
      throw new Error('Remote connection closed before the request could be sent')
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}`))
      }, RELAY_RPC_TIMEOUT_MS)
      this.pendingRpc.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        method,
      })
      try {
        socket.send(JSON.stringify({
          type: 'rpc-call',
          request_id: requestId,
          method,
          params: encrypted,
        } satisfies RelayClientMessage))
      } catch (error) {
        clearTimeout(timeout)
        this.pendingRpc.delete(requestId)
        reject(error instanceof Error ? error : new Error('Failed to send remote request'))
      }
    })
  }

  private setStatus(status: RemoteHostStatus) {
    if (this.statusValue === status) return
    this.statusValue = status
    this.callbacks.onStatusChange?.(status)
  }

  private setPresence(presence: MachinePresence | null) {
    this.presenceValue = presence
    this.callbacks.onPresence?.(presence)
  }

  private send(message: RelayClientMessage) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  private clearTimers() {
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout)
      this.connectTimeout = null
    }
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.backoffResetTimer !== null) {
      clearTimeout(this.backoffResetTimer)
      this.backoffResetTimer = null
    }
    if (this.bootstrapRetryInterval !== null) {
      clearInterval(this.bootstrapRetryInterval)
      this.bootstrapRetryInterval = null
    }
  }

  private rejectPendingRpc(error: Error) {
    for (const [requestId, pending] of this.pendingRpc.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pendingRpc.delete(requestId)
    }
  }

  private connect() {
    const generation = this.generation
    const { relayUrl, sessionId, clientToken } = this.session
    this.pendingUpdates = []
    this.parkedEncryptedUpdates = []
    this.evictedWhileParked = false
    this.pendingTruncationNextSeq = null
    this.syncedPresenceFloor = null
    this.setStatus('connecting')
    this.setPresence(null)

    void fetchWithTimeout(
      `${relayHttpBase(relayUrl)}/v1/sessions/${encodeURIComponent(sessionId)}/ws-ticket`,
      { method: 'POST', headers: { authorization: `Bearer ${clientToken}` } },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(await relayErrorMessage(response))
        return response.json() as Promise<RelayWebSocketTicketResponse>
      })
      .then((ticket) => {
        if (generation !== this.generation || !this.running) return
        const socket = new WebSocket(
          `${relayWsBase(relayUrl)}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket.ticket)}`,
        )
        this.socket = socket
        this.connectTimeout = setTimeout(() => {
          this.connectTimeout = null
          if (generation === this.generation && socket.readyState === WebSocket.CONNECTING) {
            this.callbacks.onError?.('Relay connection timed out; retrying')
            this.scheduleReconnect()
          }
        }, WEBSOCKET_CONNECT_TIMEOUT_MS)

        socket.onopen = () => {
          if (generation !== this.generation) return
          if (this.connectTimeout !== null) {
            clearTimeout(this.connectTimeout)
            this.connectTimeout = null
          }
          // The relay drops peers that stay silent for 45s.
          this.pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) this.send({ type: 'ping' })
          }, RELAY_PING_INTERVAL_MS)
          // Resetting backoff immediately would defeat it when the relay
          // closes the socket right after the handshake.
          this.backoffResetTimer = setTimeout(() => {
            this.backoffResetTimer = null
            this.reconnectAttempt = 0
          }, RELAY_BACKOFF_RESET_MS)
          this.setStatus(this.sessionCrypto ? 'encrypted' : 'connected')
          this.send({ type: 'sync', after_seq: this.cursor })
          this.startBootstrapRecovery()
        }

        socket.onmessage = (message) => {
          if (generation !== this.generation) return
          let payload: RelayServerMessage
          try {
            payload = JSON.parse(String(message.data)) as RelayServerMessage
          } catch {
            this.callbacks.onError?.('Received malformed relay message')
            return
          }
          this.handleServerMessage(payload)
        }

        socket.onclose = () => {
          if (generation !== this.generation) return
          this.scheduleReconnect()
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || !this.running) return
        const message = error instanceof Error ? error.message : 'Could not reach the relay'
        this.callbacks.onError?.(message)
        if (isInvalidRemoteSessionError(message)) {
          this.abandonInvalidSession(message)
          return
        }
        this.scheduleReconnect()
      })
  }

  private scheduleReconnect() {
    // Invalidate any decrypt/flush work that is still awaiting an async
    // boundary on the connection that just failed.
    this.generation += 1
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    if (!this.running) return
    this.setStatus('disconnected')
    this.setPresence(null)
    this.rejectPendingRpc(new Error('Relay connection closed'))
    this.parkedEncryptedUpdates = []
    this.evictedWhileParked = false
    this.pendingTruncationNextSeq = null
    this.syncedPresenceFloor = null
    this.snapshotRecoveryRequired = false
    this.snapshotRecoveryPromise = null
    this.pendingUpdates = []
    const delay = relayReconnectDelayMs(this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.running) this.connect()
    }, delay)
  }

  private requestSnapshotRecovery() {
    this.snapshotRecoveryRequired = true
    if (!this.callbacks.onHistoryTruncated) return
    // A keyless client must consume the plaintext session-bootstrap before
    // snapshot.current can be called over the encrypted RPC channel.
    if (!this.sessionCrypto) return
    const previous = this.snapshotRecoveryPromise ?? Promise.resolve()
    this.snapshotRecoveryPromise = previous.then(() => this.callbacks.onHistoryTruncated!())
  }

  private async waitForSnapshotRecovery() {
    while (this.snapshotRecoveryPromise) {
      const recovery = this.snapshotRecoveryPromise
      try {
        await recovery
      } catch (error) {
        this.callbacks.onError?.(
          error instanceof Error ? error.message : 'Failed to recover remote snapshot',
        )
        this.scheduleReconnect()
        return false
      }
      if (this.snapshotRecoveryPromise === recovery) {
        this.snapshotRecoveryPromise = null
        this.snapshotRecoveryRequired = false
      }
    }
    if (this.snapshotRecoveryRequired) {
      this.callbacks.onError?.('Remote history was truncated but snapshot recovery is unavailable')
      this.scheduleReconnect()
      return false
    }
    return true
  }

  private abandonInvalidSession(message: string) {
    this.stop()
    this.callbacks.onInvalidSession?.(message)
  }

  // A trusted client that still holds its token and key pair but lost the
  // session data key cannot use the encrypted channel. Ask the daemon for a
  // fresh bootstrap over the relay's plaintext ephemeral channel; the reply
  // arrives as a durable session-bootstrap update through the normal replay
  // path.
  private startBootstrapRecovery() {
    const request = () => {
      if (this.sessionCrypto) return
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
      this.send({
        type: 'ephemeral',
        body: {
          kind: 'request-bootstrap',
          device_id: this.session.deviceId ?? '',
          client_bundle: buildPairingPublicKeyBundle(this.keyPair),
        },
      })
    }
    request()
    this.bootstrapRetryInterval = setInterval(request, BOOTSTRAP_REQUEST_RETRY_MS)
  }

  private handleServerMessage(payload: RelayServerMessage) {
    switch (payload.type) {
      case 'ready':
      case 'pong':
        break
      case 'sync':
        if (relayBacklogWouldOverflow(this.pendingUpdates.length, payload.updates.length)) {
          this.callbacks.onError?.('Remote event backlog exceeded the safe limit')
          this.scheduleReconnect()
          return
        }
        if (payload.presence) {
          this.syncedPresenceFloor = payload.next_seq
          this.setPresence(payload.presence)
        }
        if (payload.history_truncated) {
          // Updates were lost server-side; derived state must be rebuilt.
          // The cursor is NOT advanced here: this sync's updates have not
          // been consumed yet. The truncation's next_seq is adopted at flush
          // end instead, once nothing is parked.
          this.pendingTruncationNextSeq = Math.max(
            this.pendingTruncationNextSeq ?? 0,
            payload.next_seq,
          )
          this.requestSnapshotRecovery()
        }
        this.pendingUpdates.push(...payload.updates)
        void this.flushUpdates()
        break
      case 'update':
        if (relayBacklogWouldOverflow(this.pendingUpdates.length, 1)) {
          this.callbacks.onError?.('Remote event backlog exceeded the safe limit')
          this.scheduleReconnect()
          return
        }
        this.pendingUpdates.push(payload.update)
        void this.flushUpdates()
        break
      case 'presence':
        this.setPresence(payload.presence)
        break
      case 'action-requested':
      case 'action-updated':
      case 'rpc-request':
        break
      case 'ephemeral':
        {
          const generation = this.generation
        this.ephemeralChain = this.ephemeralChain
          .then(() => this.handleEncryptedEphemeral(payload.body, generation))
          .catch((error: unknown) => {
            if (generation !== this.generation || !this.running) return
            this.callbacks.onError?.(
              error instanceof Error ? error.message : 'Failed to decrypt live daemon event',
            )
          })
        }
        break
      case 'rpc-result':
        void this.resolveRpc(
          payload.request_id,
          payload.ok,
          payload.result ?? null,
          payload.error ?? null,
          payload.failure,
        )
        break
      case 'error':
        this.callbacks.onError?.(payload.message)
        if (isInvalidRemoteSessionError(payload.message)) {
          this.abandonInvalidSession(payload.message)
        }
        break
    }
  }

  private async handleEncryptedEphemeral(body: unknown, expectedGeneration: number) {
    const envelope = encryptedDaemonEventEnvelope(body)
    const crypto = this.sessionCrypto
    if (
      !envelope ||
      !crypto ||
      !this.running ||
      expectedGeneration !== this.generation
    ) return
    const events = parseRemoteDaemonEvents(await decryptJson(crypto.dataKey, envelope))
    if (
      !this.running ||
      expectedGeneration !== this.generation ||
      crypto !== this.sessionCrypto
    ) return
    const liveEvents = events.filter(isLiveRealtimeEvent)
    if (liveEvents.length > 0) this.callbacks.onEvents?.(liveEvents)
  }

  private async resolveRpc(
    requestId: string,
    ok: boolean,
    result: EncryptedEnvelope | null,
    errorEnvelope: EncryptedEnvelope | null,
    failure: RelayRpcFailureCode | null | undefined,
  ) {
    const pending = this.pendingRpc.get(requestId)
    if (!pending) return
    this.pendingRpc.delete(requestId)
    clearTimeout(pending.timeout)
    try {
      const crypto = this.sessionCrypto
      if (!crypto) throw new Error('Encrypted relay session is not ready')
      if (ok) {
        pending.resolve(result ? await decryptJson(crypto.dataKey, result) : null)
        return
      }
      if (!errorEnvelope) {
        pending.reject(new Error(relayRpcFailureMessage(failure, pending.method)))
        return
      }
      const decrypted = await decryptJson<unknown>(crypto.dataKey, errorEnvelope)
      pending.reject(new Error(encryptedRpcErrorMessage(decrypted)))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('Remote action failed'))
    }
  }

  private persistSession(changes: Partial<PersistedRemoteSession>) {
    this.session = { ...this.session, ...changes, lastReceivedSeq: this.cursor }
    this.callbacks.onSessionChanged?.({ ...this.session })
  }

  private async flushUpdates() {
    if (this.flushInProgress) return
    const flushGeneration = this.generation
    this.flushInProgress = true
    try {
      while (this.pendingUpdates.length > 0) {
        if (flushGeneration !== this.generation || !this.running) return
        if (
          !(this.snapshotRecoveryRequired && !this.sessionCrypto) &&
          !(await this.waitForSnapshotRecovery())
        ) return
        const batch = this.pendingUpdates.splice(0)
        const daemonEvents: EventEnvelope[] = []
        let cursorChanged = false
        let nextCursor = this.cursor
        let deferredBootstrapSeq: number | null = null

        // The cursor may only advance for updates that were actually
        // consumed; otherwise a parked or failed update can never be replayed
        // by a later sync. While updates are parked the cursor stays before
        // them.
        const advanceCursor = (seq: number) => {
          if (this.parkedEncryptedUpdates.length > 0) return
          if (seq > nextCursor) {
            nextCursor = seq
            cursorChanged = true
          }
        }

        for (let index = 0; index < batch.length; index += 1) {
          const update = batch[index]
          if (!update) continue

          if (update.body.t === 'session-bootstrap') {
            const expectedClientPublicKey = publicKeyToBase64(this.keyPair)
            const expectedClientIdentityPublicKey = identityPublicKeyToBase64(
              deriveIdentityKeyPair(this.keyPair),
            )
            if (update.body.material.client_public_key !== expectedClientPublicKey) {
              // Bootstrap addressed to a different device on this session.
              advanceCursor(update.seq)
              continue
            }
            try {
              // Re-pairing mints fresh pairing ids while reusing the session
              // and data key; trust is anchored in the pinned daemon identity
              // and this client's own key material, so adopt the material's
              // pairing id instead of pinning the possibly stale one.
              verifySessionKeyMaterial(update.body.material, {
                expectedSessionId: this.session.sessionId,
                expectedDaemonPublicKey: this.session.daemonPublicKey,
                expectedDaemonIdentityPublicKey: this.session.daemonIdentityPublicKey,
                expectedClientPublicKey,
                expectedClientIdentityPublicKey,
              })
              this.sessionCrypto = bootstrapSessionCrypto(this.keyPair, update.body.material)
              this.setStatus('encrypted')
              if (this.snapshotRecoveryRequired && !this.snapshotRecoveryPromise) {
                this.requestSnapshotRecovery()
              }
              if (this.parkedEncryptedUpdates.length > 0) {
                batch.splice(index + 1, 0, ...this.parkedEncryptedUpdates)
                this.parkedEncryptedUpdates = []
                // Keep the cursor before the parked updates until the
                // inserted replay window has been consumed.
                deferredBootstrapSeq = update.seq
              }
              if (this.evictedWhileParked) {
                // Updates were evicted while parked waiting for this key, so
                // the drained window has a silent gap; derived state must be
                // rebuilt from a fresh snapshot.
                this.evictedWhileParked = false
                this.requestSnapshotRecovery()
              }
              if (deferredBootstrapSeq === null) {
                advanceCursor(update.seq)
              }
              if (cursorChanged) {
                this.cursor = nextCursor
                cursorChanged = false
              }
              this.persistSession({
                pairingId: update.body.material.pairing_id,
                daemonPublicKey: update.body.material.daemon_public_key,
                daemonIdentityPublicKey: update.body.material.daemon_identity_public_key,
                dataKey: bytesToBase64(this.sessionCrypto.dataKey),
              })
            } catch (error) {
              this.callbacks.onError?.(
                error instanceof Error
                  ? error.message
                  : 'Failed to establish encrypted relay session',
              )
              this.scheduleReconnect()
              return
            }
            continue
          }

          if (update.body.t === 'presence') {
            if (
              this.syncedPresenceFloor === null ||
              update.seq >= this.syncedPresenceFloor
            ) {
              this.setPresence(update.body.presence)
            }
            advanceCursor(update.seq)
            continue
          }

          if (update.body.t === 'action-status') {
            advanceCursor(update.seq)
            continue
          }

          // Preserve forward compatibility with durable relay body types
          // introduced after this client. Unknown non-encrypted bodies are
          // safely ignorable; trying to decrypt an absent envelope would
          // stall the cursor forever on every reconnect.
          if (update.body.t !== 'encrypted') {
            advanceCursor(update.seq)
            continue
          }

          const crypto = this.sessionCrypto
          if (!crypto) {
            if (this.parkedEncryptedUpdates.length >= MAX_PENDING_ENCRYPTED_UPDATES) {
              this.parkedEncryptedUpdates.shift()
              this.evictedWhileParked = true
            }
            this.parkedEncryptedUpdates.push(update)
            continue
          }

          const encryptedRun = [update]
          const envelopes = [update.body.envelope]
          while (true) {
            const nextUpdate = batch[index + 1]
            if (!nextUpdate || nextUpdate.body.t !== 'encrypted') break
            encryptedRun.push(nextUpdate)
            envelopes.push(nextUpdate.body.envelope)
            index += 1
          }
          const decryptedRun = await decryptJsonBatch<unknown>(crypto.dataKey, envelopes)
          if (flushGeneration !== this.generation || !this.running) return

          decryptedRun.forEach((result, runIndex) => {
            const encryptedUpdate = encryptedRun[runIndex]!
            if (result.status === 'rejected') {
              // Decryption failed: leave this update behind the cursor unless
              // a later update succeeds, matching the single-update path.
              this.callbacks.onError?.(
                result.reason instanceof Error
                  ? result.reason.message
                  : 'Failed to decrypt relay update',
              )
              return
            }
            advanceCursor(encryptedUpdate.seq)
            daemonEvents.push(...parseRemoteDaemonEvents(result.value))
          })
        }

        if (deferredBootstrapSeq !== null) {
          advanceCursor(deferredBootstrapSeq)
        }

        if (flushGeneration !== this.generation || !this.running) return
        if (daemonEvents.length > 0) {
          try {
            if (!(await this.waitForSnapshotRecovery())) return
            await this.callbacks.onEvents?.(daemonEvents)
          } catch (error) {
            // The cursor is intentionally still at its last acknowledged
            // value here. Reconnect from it so an event that the host failed
            // to apply is replayed instead of being skipped.
            this.callbacks.onError?.(
              error instanceof Error
                ? error.message
                : 'Failed to apply remote daemon events',
            )
            this.scheduleReconnect()
            return
          }
        }
        if (cursorChanged) {
          this.cursor = nextCursor
          this.persistSession({})
        }
      }

      // A truncated sync may deliver no replayable updates at all (idle
      // session aged out), so the per-update cursor advance above never runs;
      // adopt the truncation point here once nothing is parked, otherwise the
      // cursor stays stuck and every reconnect replays the truncation.
      if (flushGeneration !== this.generation || !this.running) return
      if (this.snapshotRecoveryRequired && this.sessionCrypto) {
        if (!(await this.waitForSnapshotRecovery())) return
      }
      if (
        !this.snapshotRecoveryRequired &&
        this.pendingTruncationNextSeq !== null &&
        this.parkedEncryptedUpdates.length === 0
      ) {
        const truncationSeq = Math.max(this.cursor, this.pendingTruncationNextSeq - 1, 0)
        this.pendingTruncationNextSeq = null
        if (truncationSeq !== this.cursor) {
          this.cursor = truncationSeq
          this.persistSession({})
        }
      }
    } finally {
      this.flushInProgress = false
      if (flushGeneration === this.generation && this.running && this.pendingUpdates.length > 0) {
        void this.flushUpdates()
      }
    }
  }
}
