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
import { normalizeEventEnvelope } from './normalization'
import {
  REMOTE_SESSION_STORAGE_VERSION,
  type PersistedRemoteSession,
} from './remote-session'
import type {
  ClaimPairingRequest,
  ClaimPairingResponse,
  EncryptedEnvelope,
  EventEnvelope,
  MachinePresence,
  PairingChallengeRequest,
  PairingChallengeResponse,
  RelayClientMessage,
  RelayServerMessage,
  RelayUpdate,
  RelayWebSocketTicketResponse,
} from './types'

const RELAY_PING_INTERVAL_MS = 15_000
// Only treat a connection as healthy (and reset backoff) after it stays open this long.
const RELAY_BACKOFF_RESET_MS = 10_000
const MAX_PENDING_ENCRYPTED_UPDATES = 1_000
const BOOTSTRAP_REQUEST_RETRY_MS = 30_000
const RPC_TIMEOUT_MS = 20_000

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

function parseDaemonEvent(payload: unknown): EventEnvelope | null {
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
  const challengeResponse = await fetch(`${relayBase}/v1/pairings/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode } satisfies PairingChallengeRequest),
  })
  if (!challengeResponse.ok) throw new Error(await relayErrorMessage(challengeResponse))
  const challenge = (await challengeResponse.json()) as PairingChallengeResponse
  if (!challenge.challenge) throw new Error('Relay challenge response is missing a challenge')

  const claimResponse = await fetch(`${relayBase}/v1/pairings/claim`, {
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
  onEvents?: (events: EventEnvelope[]) => void
  // Relay history was truncated (or the parked buffer overflowed): derived
  // state is no longer trustworthy and must be rebuilt from snapshot.current.
  onHistoryTruncated?: () => void
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
  private running = false
  private generation = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private backoffResetTimer: ReturnType<typeof setTimeout> | null = null
  private bootstrapRetryInterval: ReturnType<typeof setInterval> | null = null
  private pendingUpdates: RelayUpdate[] = []
  private parkedEncryptedUpdates: RelayUpdate[] = []
  private evictedWhileParked = false
  private pendingTruncationNextSeq: number | null = null
  private flushInProgress = false
  private rpcCounter = 0
  private cursor = 0
  private readonly pendingRpc = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
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
      throw new Error('Remote connection is not ready')
    }
    const crypto = this.sessionCrypto
    if (!crypto) throw new Error('Encrypted relay session is not ready')
    const requestId = `host-${this.rpcCounter++}`
    const encrypted = await encryptJson(crypto.dataKey, params)
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}`))
      }, RPC_TIMEOUT_MS)
      this.pendingRpc.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })
      this.send({ type: 'rpc-call', request_id: requestId, method, params: encrypted })
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
    this.setStatus('connecting')
    this.setPresence(null)

    void fetch(
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

        socket.onopen = () => {
          if (generation !== this.generation) return
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
        const message = error instanceof Error ? error.message : 'Failed to connect to relay'
        this.callbacks.onError?.(message)
        if (isInvalidRemoteSessionError(message)) {
          this.abandonInvalidSession(message)
          return
        }
        this.scheduleReconnect()
      })
  }

  private scheduleReconnect() {
    this.clearTimers()
    this.socket = null
    if (!this.running) return
    this.setStatus('disconnected')
    this.setPresence(null)
    this.rejectPendingRpc(new Error('Relay connection closed'))
    this.parkedEncryptedUpdates = []
    this.evictedWhileParked = false
    this.pendingTruncationNextSeq = null
    this.pendingUpdates = []
    const base = Math.min(1000 * 2 ** this.reconnectAttempt, 10_000)
    this.reconnectAttempt += 1
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.running) this.connect()
    }, delay)
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
        if (payload.history_truncated) {
          // Updates were lost server-side; derived state must be rebuilt.
          // The cursor is NOT advanced here: this sync's updates have not
          // been consumed yet. The truncation's next_seq is adopted at flush
          // end instead, once nothing is parked.
          this.pendingTruncationNextSeq = Math.max(
            this.pendingTruncationNextSeq ?? 0,
            payload.next_seq,
          )
          this.callbacks.onHistoryTruncated?.()
        }
        this.pendingUpdates.push(...payload.updates)
        void this.flushUpdates()
        break
      case 'update':
        this.pendingUpdates.push(payload.update)
        void this.flushUpdates()
        break
      case 'presence':
        this.setPresence(payload.presence)
        break
      case 'action-requested':
      case 'action-updated':
      case 'ephemeral':
      case 'rpc-request':
        break
      case 'rpc-result':
        void this.resolveRpc(payload.request_id, payload.ok, payload.result ?? null, payload.error ?? null)
        break
      case 'error':
        this.callbacks.onError?.(payload.message)
        if (isInvalidRemoteSessionError(payload.message)) {
          this.abandonInvalidSession(payload.message)
        }
        break
    }
  }

  private async resolveRpc(
    requestId: string,
    ok: boolean,
    result: EncryptedEnvelope | null,
    errorEnvelope: EncryptedEnvelope | null,
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
        pending.reject(new Error('Remote action failed'))
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
    this.flushInProgress = true
    try {
      while (this.pendingUpdates.length > 0) {
        const batch = this.pendingUpdates.splice(0)
        const daemonEvents: EventEnvelope[] = []
        let cursorChanged = false

        // The cursor may only advance for updates that were actually
        // consumed; otherwise a parked or failed update can never be replayed
        // by a later sync. While updates are parked the cursor stays before
        // them.
        const advanceCursor = (seq: number) => {
          if (this.parkedEncryptedUpdates.length > 0) return
          if (seq > this.cursor) {
            this.cursor = seq
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
              if (this.parkedEncryptedUpdates.length > 0) {
                batch.splice(index + 1, 0, ...this.parkedEncryptedUpdates)
                this.parkedEncryptedUpdates = []
              }
              if (this.evictedWhileParked) {
                // Updates were evicted while parked waiting for this key, so
                // the drained window has a silent gap; derived state must be
                // rebuilt from a fresh snapshot.
                this.evictedWhileParked = false
                this.callbacks.onHistoryTruncated?.()
              }
              advanceCursor(update.seq)
              this.persistSession({
                pairingId: update.body.material.pairing_id,
                daemonPublicKey: update.body.material.daemon_public_key,
                daemonIdentityPublicKey: update.body.material.daemon_identity_public_key,
                dataKey: bytesToBase64(this.sessionCrypto.dataKey),
              })
              cursorChanged = false
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
            this.setPresence(update.body.presence)
            advanceCursor(update.seq)
            continue
          }

          if (update.body.t === 'action-status') {
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

          let decrypted: unknown
          try {
            decrypted = await decryptJson(crypto.dataKey, update.body.envelope)
          } catch (error) {
            // Decryption failed: the cursor is not advanced for this update.
            // If nothing later in the batch decrypts either, a later sync
            // replays it; if a later update does decrypt, the cursor advances
            // past this one — skipping a single undecryptable update beats
            // stalling the stream.
            this.callbacks.onError?.(
              error instanceof Error ? error.message : 'Failed to decrypt relay update',
            )
            continue
          }

          advanceCursor(update.seq)
          const event = parseDaemonEvent(decrypted)
          if (event) daemonEvents.push(event)
        }

        if (cursorChanged) {
          this.persistSession({})
        }
        if (daemonEvents.length > 0) {
          this.callbacks.onEvents?.(daemonEvents)
        }
      }

      // A truncated sync may deliver no replayable updates at all (idle
      // session aged out), so the per-update cursor advance above never runs;
      // adopt the truncation point here once nothing is parked, otherwise the
      // cursor stays stuck and every reconnect replays the truncation.
      if (this.pendingTruncationNextSeq !== null && this.parkedEncryptedUpdates.length === 0) {
        const truncationSeq = Math.max(this.cursor, this.pendingTruncationNextSeq - 1, 0)
        this.pendingTruncationNextSeq = null
        if (truncationSeq !== this.cursor) {
          this.cursor = truncationSeq
          this.persistSession({})
        }
      }
    } finally {
      this.flushInProgress = false
      if (this.pendingUpdates.length > 0) {
        void this.flushUpdates()
      }
    }
  }
}
