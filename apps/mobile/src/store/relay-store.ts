/**
 * Relay connection store.
 *
 * Manages the encrypted WebSocket relay lifecycle:
 * pairing → connect → encrypted session → reconnect.
 *
 * Mirrors the relay protocol from apps/remote-web/src/App.tsx
 * but structured as a Zustand store instead of React useState/useEffect.
 */
import { Platform } from 'react-native'
import * as Device from 'expo-device'
import { create } from 'zustand'

import {
  buildPairingPublicKeyBundle,
  generateBoxKeyPair,
  restoreBoxKeyPair,
  publicKeyToBase64,
  identityPublicKeyToBase64,
  deriveIdentityKeyPair,
  secretKeyToBase64,
  signPairingClaimChallenge,
  bootstrapSessionCrypto,
  encryptJson,
  decryptJson,
  bytesToBase64,
  base64ToBytes,
  verifyPairingPublicKeyBundle,
  verifySessionKeyMaterial,
  RELAY_RPC_TIMEOUT_MS,
  relayRpcFailureMessage,
  REMOTE_SESSION_STORAGE_VERSION,
  type ClaimPairingRequest,
  type ClaimPairingResponse,
  type PairingChallengeRequest,
  type PairingChallengeResponse,
  type BoxKeyPair,
  type SessionCryptoState,
  type EncryptedEnvelope,
  type MachinePresence,
  type RelayClientMessage,
  type RelayServerMessage,
  type RelayUpdate,
} from '@falcondeck/client-core'

import { fetchWithTimeout } from '@/lib/fetch-timeout'
import { clearPushToken } from '@/lib/push-notifications'
import { getJson, setJson, removeKey } from '@/storage/mmkv'
import {
  persistClientSecretKey,
  loadClientSecretKey,
  persistDataKey,
  loadDataKey,
  persistClientToken,
  loadClientToken,
  clearDataKey,
  clearSecureSession,
} from '@/storage/secure'
import { clearMobileSessionCache } from '@/storage/mobile-session-cache'
import { logConnection } from './connection-log-store'
import { useSessionStore } from './session-store'

// ── Types ──────────────────────────────────────────────────────────

type ConnectionStatus =
  | 'not_connected'
  | 'claiming'
  | 'connecting'
  | 'connected'
  | 'encrypted'
  | 'disconnected'

interface PersistedRelay {
  version: typeof REMOTE_SESSION_STORAGE_VERSION
  relayUrl: string
  pairingCode: string
  pairingId: string
  sessionId: string
  deviceId: string
  daemonPublicKey: string
  daemonIdentityPublicKey: string
  lastReceivedSeq: number
}

export interface RelayState {
  relayUrl: string
  pairingCode: string
  sessionId: string | null
  deviceId: string | null
  connectionStatus: ConnectionStatus
  machinePresence: MachinePresence | null
  error: string | null
  isConnected: boolean
  isEncrypted: boolean
  /** A snapshot RPC is in flight — the project/thread list is still catching up. */
  isSyncing: boolean
  /** A snapshot has landed at least once since launch (or unpair). */
  hasSyncedOnce: boolean
  /** Timing and retry detail for the current authoritative snapshot sync. */
  syncDiagnostics: SyncDiagnostics
}

export interface SyncDiagnostics {
  startedAt: number | null
  attempt: number
  lastAttemptAt: number | null
  nextRetryAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  lastSuccessAt: number | null
}

interface RelayActions {
  setRelayUrl: (url: string) => void
  setPairingCode: (code: string) => void
  claimPairing: () => Promise<void>
  restoreSession: () => Promise<boolean>
  disconnect: () => Promise<void>
  // Internal — exposed for hook-based WebSocket management
  _setConnectionStatus: (status: ConnectionStatus) => void
  _setMachinePresence: (presence: MachinePresence | null) => void
  _setError: (error: string | null) => void
  _setSyncing: (isSyncing: boolean) => void
  _startSyncAttempt: () => void
  _setSyncRetry: (error: string | null, nextRetryAt: number | null) => void
  _finishSync: () => void
  _getSocket: () => WebSocket | null
  _setSocket: (socket: WebSocket | null) => void
  _getSessionCrypto: () => SessionCryptoState | null
  _getKeyPair: () => BoxKeyPair | null
  _getLastReceivedSeq: () => number
  _setLastReceivedSeq: (seq: number) => void
  _getClientToken: () => string | null
  _setSessionCrypto: (crypto: SessionCryptoState | null) => void
  _persistSession: () => void
  _encryptJson: (value: unknown) => Promise<EncryptedEnvelope>
  _decryptJson: <T>(envelope: EncryptedEnvelope) => Promise<T>
  _sendMessage: (message: RelayClientMessage) => void
  _callRpc: <T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: {
      requestIdPrefix?: string
      timeoutMs?: number
    },
  ) => Promise<T>
  _handleRpcResult: (payload: Extract<RelayServerMessage, { type: 'rpc-result' }>) => Promise<boolean>
  _failPendingRpcs: (message: string) => void
  _processBootstrap: (update: RelayUpdate) => Promise<void>
  _requestBootstrap: () => boolean
}

type RelayStore = RelayState & RelayActions

// ── Internal refs (not in React state — avoids re-renders) ─────────

let _socket: WebSocket | null = null
let _sessionCrypto: SessionCryptoState | null = null
let _clientKeyPair: BoxKeyPair | null = null
let _clientToken: string | null = null
let _lastReceivedSeq = 0
let _pairingId: string | null = null
let _trustedDaemonPublicKey: string | null = null
let _trustedDaemonIdentityPublicKey: string | null = null
let _rpcRequestCounter = 0

type PendingRpc = {
  method: string
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const _pendingRpc = new Map<string, PendingRpc>()

function hasLiveRelayConnection(status: ConnectionStatus) {
  return status === 'connected' || status === 'encrypted'
}

/**
 * Best-effort removal of this phone's trusted-device record when unpairing so
 * it does not linger in the desktop's device list. Two DELETEs because the
 * relay's endpoint is revoke-then-purge. Never throws — unpairing must not
 * block on the network.
 */
async function removeOwnTrustedDevice(
  relayUrl: string,
  sessionId: string,
  deviceId: string,
  clientToken: string,
): Promise<void> {
  const base = relayUrl.trim().replace(/\/$/, '')
  const url = `${base}/v1/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}`
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchWithTimeout(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${clientToken}` },
      })
      if (!response.ok) return
    }
  } catch {
    // Orphaned rows are eventually pruned relay-side by retention.
  }
}

function encryptedRpcErrorMessage(payload: unknown) {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Remote action failed'
}

function emptySyncDiagnostics(lastSuccessAt: number | null = null): SyncDiagnostics {
  return {
    startedAt: null,
    attempt: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt,
  }
}

// ── Store ──────────────────────────────────────────────────────────

export const useRelayStore = create<RelayStore>((set, get) => ({
  relayUrl: 'https://connect.falcondeck.com',
  pairingCode: '',
  sessionId: null,
  deviceId: null,
  connectionStatus: 'not_connected',
  machinePresence: null,
  error: null,
  isConnected: false,
  isEncrypted: false,
  isSyncing: false,
  hasSyncedOnce: false,
  syncDiagnostics: emptySyncDiagnostics(),

  setRelayUrl: (url) => set({ relayUrl: url }),
  setPairingCode: (code) => set({ pairingCode: code.toUpperCase() }),

  claimPairing: async () => {
    const { relayUrl, pairingCode } = get()
    if (!relayUrl.trim() || !pairingCode.trim()) return

    logConnection('info', 'Claiming pairing with the relay…')
    set({ connectionStatus: 'claiming', error: null })

    // Reuse the stored identity keypair when one exists: the relay dedupes
    // trusted devices by client public key, so re-pairing with the same key
    // reattaches this phone to its existing device record instead of minting
    // a duplicate entry that lingers on the desktop forever.
    let keyPair: BoxKeyPair
    try {
      const existingSecret = await loadClientSecretKey()
      keyPair = existingSecret ? restoreBoxKeyPair(existingSecret) : generateBoxKeyPair()
    } catch {
      keyPair = generateBoxKeyPair()
    }

    try {
      const relayBase = relayUrl.replace(/\/$/, '')
      // The relay normalizes pairing codes to uppercase; sign the exact
      // string the relay verifies against.
      const normalizedPairingCode = pairingCode.trim().toUpperCase()

      // Claims are challenge-bound: fetch a single-use challenge and prove
      // possession of the identity secret key by signing it.
      const challengeResponse = await fetchWithTimeout(`${relayBase}/v1/pairings/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: normalizedPairingCode,
        } satisfies PairingChallengeRequest),
      })
      if (!challengeResponse.ok) {
        _clientKeyPair = null
        const payload = (await challengeResponse.json().catch(() => null)) as { error?: string } | null
        set({
          sessionId: null,
          deviceId: null,
          connectionStatus: 'not_connected',
          machinePresence: null,
          error: payload?.error ?? `Failed with status ${challengeResponse.status}`,
          isConnected: false,
          isEncrypted: false,
        })
        return
      }
      const challenge = (await challengeResponse.json()) as PairingChallengeResponse
      if (!challenge.challenge) {
        throw new Error('Relay challenge response is missing a challenge')
      }

      const clientBundle = buildPairingPublicKeyBundle(keyPair)
      const response = await fetchWithTimeout(`${relayBase}/v1/pairings/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: normalizedPairingCode,
          label: Device.deviceName ?? `FalconDeck ${Platform.OS === 'ios' ? 'iPhone' : 'Android'}`,
          client_bundle: clientBundle,
          challenge_signature: signPairingClaimChallenge(keyPair, normalizedPairingCode, challenge.challenge),
        } satisfies ClaimPairingRequest),
      })

      if (!response.ok) {
        _clientKeyPair = null
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        set({
          sessionId: null,
          deviceId: null,
          connectionStatus: 'not_connected',
          machinePresence: null,
          error: payload?.error ?? `Failed with status ${response.status}`,
          isConnected: false,
          isEncrypted: false,
        })
        return
      }

      const claim = (await response.json()) as ClaimPairingResponse
      if (!claim.daemon_bundle) {
        throw new Error('Relay claim response is missing daemon key material')
      }
      verifyPairingPublicKeyBundle(claim.daemon_bundle)

      // Persist to secure storage. Any stored data key belongs to the
      // previous session and must not survive into this pairing; the
      // identity keypair and client token are overwritten in place.
      await clearDataKey()
      await Promise.all([
        persistClientSecretKey(secretKeyToBase64(keyPair)),
        persistClientToken(claim.client_token),
      ])

      _socket?.close()
      _socket = null
      _sessionCrypto = null
      _clientKeyPair = keyPair
      _clientToken = claim.client_token
      _lastReceivedSeq = 0
      _pairingId = claim.pairing_id
      _trustedDaemonPublicKey = claim.daemon_bundle.public_key
      _trustedDaemonIdentityPublicKey = claim.daemon_bundle.identity_public_key

      // Persist non-secret session data to MMKV
      setJson('relay.session', {
        version: REMOTE_SESSION_STORAGE_VERSION,
        relayUrl: relayUrl.trim(),
        pairingCode: pairingCode.trim(),
        pairingId: claim.pairing_id,
        sessionId: claim.session_id,
        deviceId: claim.device_id,
        daemonPublicKey: claim.daemon_bundle.public_key,
        daemonIdentityPublicKey: claim.daemon_bundle.identity_public_key,
        lastReceivedSeq: 0,
      } satisfies PersistedRelay)

      set({
        sessionId: claim.session_id,
        deviceId: claim.device_id,
        connectionStatus: 'connecting',
        isConnected: false,
        isEncrypted: false,
        machinePresence: null,
        error: null,
        isSyncing: false,
        hasSyncedOnce: false,
        syncDiagnostics: emptySyncDiagnostics(),
      })
    } catch (e) {
      set({
        sessionId: null,
        deviceId: null,
        connectionStatus: 'not_connected',
        machinePresence: null,
        error: e instanceof Error ? e.message : 'Failed to claim pairing',
        isConnected: false,
        isEncrypted: false,
        isSyncing: false,
        hasSyncedOnce: false,
        syncDiagnostics: emptySyncDiagnostics(),
      })
    }
  },

  restoreSession: async () => {
    const persisted = getJson<PersistedRelay>('relay.session')
    if (!persisted) return false
    if (persisted.version !== REMOTE_SESSION_STORAGE_VERSION) {
      _socket = null
      _sessionCrypto = null
      _clientKeyPair = null
      _clientToken = null
      _lastReceivedSeq = 0
      _pairingId = null
      _trustedDaemonPublicKey = null
      _trustedDaemonIdentityPublicKey = null
      set({
        sessionId: null,
        deviceId: null,
        connectionStatus: 'not_connected',
        machinePresence: null,
        error: null,
        isConnected: false,
        isEncrypted: false,
      })
      removeKey('relay.session')
      clearMobileSessionCache()
      await clearSecureSession()
      return false
    }

    const [secretKey, dataKey, clientToken] = await Promise.all([
      loadClientSecretKey(),
      loadDataKey(),
      loadClientToken(),
    ])

    if (!secretKey || !clientToken) {
      _socket = null
      _sessionCrypto = null
      _clientKeyPair = null
      _clientToken = null
      _lastReceivedSeq = 0
      _pairingId = null
      _trustedDaemonPublicKey = null
      _trustedDaemonIdentityPublicKey = null
      set({
        sessionId: null,
        deviceId: null,
        connectionStatus: 'not_connected',
        machinePresence: null,
        error: null,
        isConnected: false,
        isEncrypted: false,
      })
      removeKey('relay.session')
      clearMobileSessionCache()
      await clearSecureSession()
      return false
    }

    try {
      _clientKeyPair = restoreBoxKeyPair(secretKey)
      _clientToken = clientToken
      _lastReceivedSeq = persisted.lastReceivedSeq ?? 0
      _pairingId = persisted.pairingId
      _trustedDaemonPublicKey = persisted.daemonPublicKey
      _trustedDaemonIdentityPublicKey = persisted.daemonIdentityPublicKey

      _sessionCrypto = dataKey
        ? { dataKey: base64ToBytes(dataKey), material: null }
        : null

      set({
        relayUrl: persisted.relayUrl,
        pairingCode: persisted.pairingCode,
        sessionId: persisted.sessionId,
        deviceId: persisted.deviceId,
        connectionStatus: 'connecting',
        machinePresence: null,
        error: null,
        isConnected: false,
        isEncrypted: false,
        isSyncing: false,
        hasSyncedOnce: false,
        syncDiagnostics: emptySyncDiagnostics(),
      })

      return true
    } catch {
      _socket = null
      _sessionCrypto = null
      _clientKeyPair = null
      _clientToken = null
      _lastReceivedSeq = 0
      _pairingId = null
      _trustedDaemonPublicKey = null
      _trustedDaemonIdentityPublicKey = null
      set({
        sessionId: null,
        deviceId: null,
        connectionStatus: 'not_connected',
        machinePresence: null,
        error: null,
        isConnected: false,
        isEncrypted: false,
      })
      removeKey('relay.session')
      clearMobileSessionCache()
      await clearSecureSession()
      return false
    }
  },

  disconnect: async () => {
    logConnection('warn', 'Disconnecting this device from the relay…')
    // Best-effort: ask the relay to stop pushing to this device while we still
    // hold the client token the call needs. Fire-and-forget — clearPushToken
    // never throws, and unpairing must not block on the network.
    const { relayUrl, sessionId, deviceId } = get()
    if (sessionId && deviceId && _clientToken) {
      void clearPushToken(relayUrl, sessionId, deviceId, _clientToken)
      void removeOwnTrustedDevice(relayUrl, sessionId, deviceId, _clientToken)
    }

    const socket = _socket
    _socket = null
    get()._failPendingRpcs('Remote session disconnected')
    _sessionCrypto = null
    _clientKeyPair = null
    _clientToken = null
    _lastReceivedSeq = 0
    _pairingId = null
    _trustedDaemonPublicKey = null
    _trustedDaemonIdentityPublicKey = null
    useSessionStore.getState().reset()

    set({
      sessionId: null,
      deviceId: null,
      connectionStatus: 'not_connected',
      machinePresence: null,
      error: null,
      isConnected: false,
      isEncrypted: false,
      isSyncing: false,
      hasSyncedOnce: false,
      syncDiagnostics: emptySyncDiagnostics(),
    })

    socket?.close()
    removeKey('relay.session')
    clearMobileSessionCache()
    await clearSecureSession()
  },

  // Internal accessors
  _setConnectionStatus: (status) => {
    const previous = get().connectionStatus
    if (previous !== status) {
      logConnection(
        status === 'encrypted' || status === 'connected' ? 'success' : 'info',
        `Relay: ${status.replace('_', ' ')}`,
        status === 'connected'
          ? 'Socket is up; waiting for the session key.'
          : undefined,
      )
    }
    set({
      connectionStatus: status,
      isConnected: hasLiveRelayConnection(status),
      isEncrypted: status === 'encrypted' && !!_sessionCrypto,
    })
  },
  _setMachinePresence: (presence) => {
    const previous = get().machinePresence
    set({ machinePresence: presence })
    if (presence && previous?.daemon_connected !== presence.daemon_connected) {
      logConnection(
        presence.daemon_connected ? 'success' : 'warn',
        presence.daemon_connected
          ? 'Your Mac is connected to the relay.'
          : 'Your Mac is not connected to the relay.',
      )
    }
  },
  _setError: (error) => {
    if (error && error !== get().error) {
      logConnection('error', 'Error', error)
    }
    set({ error })
  },
  // `_finishSync` is the only path that marks a snapshot as landed. Toggling
  // the in-flight flag after a failure must not hide the retry banner while
  // nothing authoritative has loaded.
  _setSyncing: (isSyncing) => set({ isSyncing }),
  _startSyncAttempt: () => {
    const attempt = get().syncDiagnostics.attempt + 1
    logConnection('info', `Fetching project list from your Mac (attempt ${attempt})`)
    set((state) => {
      const now = Date.now()
      return {
        isSyncing: true,
        syncDiagnostics: {
          ...state.syncDiagnostics,
          startedAt: state.syncDiagnostics.startedAt ?? now,
          attempt,
          lastAttemptAt: now,
          nextRetryAt: null,
        },
      }
    })
  },
  _setSyncRetry: (error, nextRetryAt) => {
    if (error) {
      logConnection(
        'warn',
        nextRetryAt !== null ? 'Sync failed; will retry' : 'Sync failed',
        nextRetryAt !== null
          ? `${error} (retrying in ${Math.max(1, Math.round((nextRetryAt - Date.now()) / 1000))}s)`
          : error,
      )
    }
    set((state) => ({
      syncDiagnostics: {
        ...state.syncDiagnostics,
        nextRetryAt,
        ...(error
          ? {
              lastError: error,
              lastErrorAt: Date.now(),
            }
          : null),
      },
    }))
  },
  _finishSync: () => {
    const now = Date.now()
    logConnection('success', 'Projects synced.')
    set({
      isSyncing: false,
      hasSyncedOnce: true,
      syncDiagnostics: emptySyncDiagnostics(now),
    })
  },
  _getSocket: () => _socket,
  _setSocket: (socket) => { _socket = socket },
  _getSessionCrypto: () => _sessionCrypto,
  _setSessionCrypto: (crypto) => {
    _sessionCrypto = crypto
    if (crypto) {
      logConnection('success', 'Session key installed — channel is encrypted.')
    }
    set((state) => ({
      isEncrypted: state.connectionStatus === 'encrypted' && !!crypto,
    }))
  },
  _getKeyPair: () => _clientKeyPair,
  _getLastReceivedSeq: () => _lastReceivedSeq,
  _setLastReceivedSeq: (seq) => { _lastReceivedSeq = Math.max(_lastReceivedSeq, seq) },
  _getClientToken: () => _clientToken,

  _persistSession: () => {
    const { relayUrl, pairingCode, sessionId, deviceId } = get()
    if (
      !sessionId ||
      !_pairingId ||
      !_trustedDaemonPublicKey ||
      !_trustedDaemonIdentityPublicKey
    ) return
    setJson('relay.session', {
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl,
      pairingCode,
      pairingId: _pairingId,
      sessionId,
      deviceId: deviceId ?? '',
      daemonPublicKey: _trustedDaemonPublicKey,
      daemonIdentityPublicKey: _trustedDaemonIdentityPublicKey,
      lastReceivedSeq: _lastReceivedSeq,
    } satisfies PersistedRelay)
    if (_sessionCrypto) {
      void persistDataKey(bytesToBase64(_sessionCrypto.dataKey))
    }
  },

  _encryptJson: async (value) => {
    if (!_sessionCrypto) throw new Error('Encrypted relay session is not ready')
    return encryptJson(_sessionCrypto.dataKey, value)
  },

  _decryptJson: async <T>(envelope: EncryptedEnvelope) => {
    if (!_sessionCrypto) throw new Error('Encrypted relay session is not ready')
    return decryptJson<T>(_sessionCrypto.dataKey, envelope)
  },

  _sendMessage: (message) => {
    /* v8 ignore start — requires live WebSocket, tested via E2E */
    if (_socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Remote connection is not ready')
    }
    _socket.send(JSON.stringify(message))
    /* v8 ignore stop */
  },

  _callRpc: async <T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: {
      requestIdPrefix?: string
      timeoutMs?: number
    },
  ) => {
    const requestId = `${options?.requestIdPrefix ?? 'mobile-rpc'}-${_rpcRequestCounter++}`
    const encrypted = await get()._encryptJson(params)

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        _pendingRpc.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}`))
      }, options?.timeoutMs ?? RELAY_RPC_TIMEOUT_MS)

      _pendingRpc.set(requestId, {
        method,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      })

      try {
        get()._sendMessage({
          type: 'rpc-call',
          request_id: requestId,
          method,
          params: encrypted,
        })
      } catch (error) {
        clearTimeout(timeout)
        _pendingRpc.delete(requestId)
        reject(error instanceof Error ? error : new Error('Remote action failed'))
      }
    })
  },

  _handleRpcResult: async (payload) => {
    const pending = _pendingRpc.get(payload.request_id)
    if (!pending) {
      return false
    }

    _pendingRpc.delete(payload.request_id)
    clearTimeout(pending.timeout)

    try {
      if (payload.ok) {
        pending.resolve(payload.result ? await get()._decryptJson(payload.result) : null)
        return true
      }

      if (!payload.error) {
        pending.reject(new Error(relayRpcFailureMessage(payload.failure, pending.method)))
        return true
      }

      const decrypted = await get()._decryptJson<unknown>(payload.error)
      pending.reject(new Error(encryptedRpcErrorMessage(decrypted)))
      return true
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(`Failed to process ${pending.method} response`))
      return true
    }
  },

  _failPendingRpcs: (message) => {
    for (const [requestId, pending] of _pendingRpc.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(message))
      _pendingRpc.delete(requestId)
    }
  },

  _processBootstrap: async (update) => {
    if (update.body.t !== 'session-bootstrap') return
    const kp = _clientKeyPair
    if (!kp) {
      set({ error: 'Missing local pairing key material' })
      return
    }
    /* v8 ignore start — requires module-level _clientKeyPair from claimPairing, tested via E2E */
    const expectedClientPublicKey = publicKeyToBase64(kp)
    const expectedClientIdentityPublicKey = identityPublicKeyToBase64(deriveIdentityKeyPair(kp))
    if (update.body.material.client_public_key !== expectedClientPublicKey) return

    try {
      // The daemon may republish a recovery bootstrap under a newer pairing
      // lineage than the one this client originally claimed (re-pairing and
      // additional-device pairings mint fresh pairing ids while reusing the
      // session and data key). Trust is anchored in the pinned daemon
      // identity, the session id, and this client's own key material, so
      // adopt the material's pairing id instead of pinning the possibly
      // stale one.
      verifySessionKeyMaterial(update.body.material, {
        expectedSessionId: get().sessionId,
        expectedDaemonPublicKey: _trustedDaemonPublicKey,
        expectedDaemonIdentityPublicKey: _trustedDaemonIdentityPublicKey,
        expectedClientPublicKey,
        expectedClientIdentityPublicKey,
      })
      _pairingId = update.body.material.pairing_id
      get()._setSessionCrypto(bootstrapSessionCrypto(kp, update.body.material))
      get()._setConnectionStatus('encrypted')
      get()._persistSession()
      // A stale error from an earlier attempt must not linger over a now
      // successfully secured session.
      set({ error: null })
    } catch (e) {
      // A malformed or unverifiable bootstrap must not unpair the device:
      // bootstraps are durable updates the relay replays, so one bad update
      // from a buggy or compromised relay would otherwise wipe key material
      // on every mobile client, permanently. Match remote-web: surface the
      // error, skip the update, and leave stored key material untouched.
      set({ error: e instanceof Error ? e.message : 'Failed to establish encrypted session' })
    }
    /* v8 ignore stop */
  },

  // A restored trusted session can hold the client token and local key pair
  // but no session data key (the daemon deliberately skips the bootstrap for
  // restored trusted sessions). Ask the daemon for a fresh bootstrap over the
  // relay's plaintext ephemeral channel; the reply arrives as a durable
  // session-bootstrap update and _processBootstrap installs the key through
  // the normal replay path. Returns true when the request was sent.
  _requestBootstrap: () => {
    if (_sessionCrypto) return false
    const keyPair = _clientKeyPair
    const { deviceId } = get()
    if (!keyPair || !_clientToken || !deviceId) return false
    try {
      get()._sendMessage({
        type: 'ephemeral',
        body: {
          kind: 'request-bootstrap',
          device_id: deviceId,
          client_bundle: buildPairingPublicKeyBundle(keyPair),
        },
      })
      return true
    } catch {
      // Socket not ready — the caller retries on its own schedule.
      return false
    }
  },
}))
