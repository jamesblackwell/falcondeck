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
  bootstrapSessionCrypto,
  encryptJson,
  decryptJson,
  bytesToBase64,
  base64ToBytes,
  verifyPairingPublicKeyBundle,
  verifySessionKeyMaterial,
  REMOTE_SESSION_STORAGE_VERSION,
  type ClaimPairingResponse,
  type BoxKeyPair,
  type SessionCryptoState,
  type EncryptedEnvelope,
  type MachinePresence,
  type RelayClientMessage,
  type RelayServerMessage,
  type RelayWebSocketTicketResponse,
  type RelayUpdate,
} from '@falcondeck/client-core'

import { getJson, setJson, removeKey } from '@/storage/mmkv'
import {
  persistClientSecretKey,
  loadClientSecretKey,
  persistDataKey,
  loadDataKey,
  persistClientToken,
  loadClientToken,
  clearSecureSession,
} from '@/storage/secure'
import { clearMobileSessionCache } from '@/storage/mobile-session-cache'
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

function encryptedRpcErrorMessage(payload: unknown) {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Remote action failed'
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

  setRelayUrl: (url) => set({ relayUrl: url }),
  setPairingCode: (code) => set({ pairingCode: code.toUpperCase() }),

  claimPairing: async () => {
    const { relayUrl, pairingCode } = get()
    if (!relayUrl.trim() || !pairingCode.trim()) return

    set({ connectionStatus: 'claiming', error: null })

    const keyPair = generateBoxKeyPair()

    try {
      const clientBundle = buildPairingPublicKeyBundle(keyPair)
      const response = await fetch(`${relayUrl.replace(/\/$/, '')}/v1/pairings/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: pairingCode.trim(),
          label: Device.deviceName ?? `FalconDeck ${Platform.OS === 'ios' ? 'iPhone' : 'Android'}`,
          client_bundle: clientBundle,
        }),
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

      // Persist to secure storage
      await clearSecureSession()
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
    })

    socket?.close()
    removeKey('relay.session')
    clearMobileSessionCache()
    await clearSecureSession()
  },

  // Internal accessors
  _setConnectionStatus: (status) => {
    set({
      connectionStatus: status,
      isConnected: hasLiveRelayConnection(status),
      isEncrypted: status === 'encrypted' && !!_sessionCrypto,
    })
  },
  _setMachinePresence: (presence) => set({ machinePresence: presence }),
  _setError: (error) => set({ error }),
  _getSocket: () => _socket,
  _setSocket: (socket) => { _socket = socket },
  _getSessionCrypto: () => _sessionCrypto,
  _setSessionCrypto: (crypto) => {
    _sessionCrypto = crypto
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
      }, options?.timeoutMs ?? 20_000)

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
        pending.reject(new Error('Remote action failed'))
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
      verifySessionKeyMaterial(update.body.material, {
        expectedSessionId: get().sessionId,
        expectedPairingId: _pairingId,
        expectedDaemonPublicKey: _trustedDaemonPublicKey,
        expectedDaemonIdentityPublicKey: _trustedDaemonIdentityPublicKey,
        expectedClientPublicKey,
        expectedClientIdentityPublicKey,
      })
      get()._setSessionCrypto(bootstrapSessionCrypto(kp, update.body.material))
      get()._setConnectionStatus('encrypted')
      get()._persistSession()
    } catch (e) {
      await get().disconnect()
      set({ error: e instanceof Error ? e.message : 'Failed to establish encrypted session' })
    }
    /* v8 ignore stop */
  },
}))
