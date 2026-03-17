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
  generateBoxKeyPair,
  restoreBoxKeyPair,
  publicKeyToBase64,
  secretKeyToBase64,
  bootstrapSessionCrypto,
  encryptJson,
  decryptJson,
  bytesToBase64,
  base64ToBytes,
  type BoxKeyPair,
  type SessionCryptoState,
  type EncryptedEnvelope,
  type MachinePresence,
  type RelayClientMessage,
  type RelayServerMessage,
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

// ── Types ──────────────────────────────────────────────────────────

type ConnectionStatus =
  | 'not_connected'
  | 'claiming'
  | 'connecting'
  | 'connected'
  | 'encrypted'
  | 'disconnected'

interface PersistedRelay {
  relayUrl: string
  pairingCode: string
  sessionId: string
  deviceId: string
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
  _processBootstrap: (update: RelayUpdate) => Promise<void>
}

type RelayStore = RelayState & RelayActions

// ── Internal refs (not in React state — avoids re-renders) ─────────

let _socket: WebSocket | null = null
let _sessionCrypto: SessionCryptoState | null = null
let _clientKeyPair: BoxKeyPair | null = null
let _clientToken: string | null = null
let _lastReceivedSeq = 0

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
    _clientKeyPair = keyPair

    try {
      const response = await fetch(`${relayUrl.replace(/\/$/, '')}/v1/pairings/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: pairingCode.trim(),
          label: Device.deviceName ?? `FalconDeck ${Platform.OS === 'ios' ? 'iPhone' : 'Android'}`,
          client_bundle: {
            encryption_variant: 'data_key_v1',
            public_key: publicKeyToBase64(keyPair),
          },
        }),
      })

      if (!response.ok) {
        _clientKeyPair = null
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        set({
          connectionStatus: 'not_connected',
          error: payload?.error ?? `Failed with status ${response.status}`,
        })
        return
      }

      const claim = (await response.json()) as {
        session_id: string
        device_id: string
        client_token: string
      }

      _clientToken = claim.client_token
      _lastReceivedSeq = 0

      // Persist to secure storage
      await Promise.all([
        persistClientSecretKey(secretKeyToBase64(keyPair)),
        persistClientToken(claim.client_token),
      ])

      // Persist non-secret session data to MMKV
      setJson('relay.session', {
        relayUrl: relayUrl.trim(),
        pairingCode: pairingCode.trim(),
        sessionId: claim.session_id,
        deviceId: claim.device_id,
        lastReceivedSeq: 0,
      } satisfies PersistedRelay)

      set({
        sessionId: claim.session_id,
        deviceId: claim.device_id,
        connectionStatus: 'connecting',
        isConnected: true,
        error: null,
      })
    } catch (e) {
      _clientKeyPair = null
      set({
        connectionStatus: 'not_connected',
        error: e instanceof Error ? e.message : 'Failed to claim pairing',
      })
    }
  },

  restoreSession: async () => {
    const persisted = getJson<PersistedRelay>('relay.session')
    if (!persisted) return false

    const [secretKey, dataKey, clientToken] = await Promise.all([
      loadClientSecretKey(),
      loadDataKey(),
      loadClientToken(),
    ])

    if (!secretKey || !clientToken) {
      removeKey('relay.session')
      await clearSecureSession()
      return false
    }

    try {
      _clientKeyPair = restoreBoxKeyPair(secretKey)
      _clientToken = clientToken
      _lastReceivedSeq = persisted.lastReceivedSeq

      if (dataKey) {
        _sessionCrypto = { dataKey: base64ToBytes(dataKey), material: null }
      }

      set({
        relayUrl: persisted.relayUrl,
        pairingCode: persisted.pairingCode,
        sessionId: persisted.sessionId,
        deviceId: persisted.deviceId,
        connectionStatus: 'connecting',
        isConnected: true,
        isEncrypted: !!dataKey,
      })

      return true
    } catch {
      removeKey('relay.session')
      await clearSecureSession()
      return false
    }
  },

  disconnect: async () => {
    _socket?.close()
    _socket = null
    _sessionCrypto = null
    _clientKeyPair = null
    _clientToken = null
    _lastReceivedSeq = 0

    removeKey('relay.session')
    await clearSecureSession()

    set({
      sessionId: null,
      deviceId: null,
      connectionStatus: 'not_connected',
      machinePresence: null,
      error: null,
      isConnected: false,
      isEncrypted: false,
    })
  },

  // Internal accessors
  _setConnectionStatus: (status) => {
    set({
      connectionStatus: status,
      isEncrypted: status === 'encrypted',
    })
  },
  _setMachinePresence: (presence) => set({ machinePresence: presence }),
  _setError: (error) => set({ error }),
  _getSocket: () => _socket,
  _setSocket: (socket) => { _socket = socket },
  _getSessionCrypto: () => _sessionCrypto,
  _setSessionCrypto: (crypto) => {
    _sessionCrypto = crypto
    set({ isEncrypted: !!crypto })
  },
  _getKeyPair: () => _clientKeyPair,
  _getLastReceivedSeq: () => _lastReceivedSeq,
  _setLastReceivedSeq: (seq) => { _lastReceivedSeq = Math.max(_lastReceivedSeq, seq) },
  _getClientToken: () => _clientToken,

  _persistSession: () => {
    const { relayUrl, pairingCode, sessionId, deviceId } = get()
    if (!sessionId) return
    setJson('relay.session', {
      relayUrl,
      pairingCode,
      sessionId,
      deviceId: deviceId ?? '',
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
    if (_socket?.readyState === WebSocket.OPEN) {
      _socket.send(JSON.stringify(message))
    }
    /* v8 ignore stop */
  },

  _processBootstrap: async (update) => {
    if (update.body.t !== 'session-bootstrap') return
    const kp = _clientKeyPair
    if (!kp) {
      set({ error: 'Missing local pairing key material' })
      return
    }
    /* v8 ignore start — requires module-level _clientKeyPair from claimPairing, tested via E2E */
    if (update.body.material.client_public_key !== publicKeyToBase64(kp)) return

    try {
      _sessionCrypto = bootstrapSessionCrypto(kp, update.body.material)
      set({ isEncrypted: true, connectionStatus: 'encrypted' })
      get()._persistSession()
    } catch (e) {
      await get().disconnect()
      set({ error: e instanceof Error ? e.message : 'Failed to establish encrypted session' })
    }
    /* v8 ignore stop */
  },
}))
