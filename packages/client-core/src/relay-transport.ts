import { base64ToBytes, bytesToBase64 } from './crypto'

/** Matches falcondeck-core::relay_transport; each encoded frame is <16 KiB. */
export const RELAY_CHUNK_BYTES = 11 * 1024
export const RELAY_MESSAGE_BYTES = 40 * 1024 * 1024
/** Chunks kept in flight before an acknowledgement is required. One chunk per
 * round trip made a 480 KB handoff prompt take ~7 s from a phone; the window
 * fills the link while bounding buffered data. Receivers acknowledge every
 * chunk in order, so this stays compatible with one-at-a-time peers. */
export const RELAY_WINDOW_CHUNKS = 16
const QUEUE_BYTES = RELAY_MESSAGE_BYTES + 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & Partial<Pick<WebSocket, 'bufferedAmount' | 'addEventListener'>>
/** `sent` chunks are on the wire; `acked` of them are confirmed. */
type Transfer = { id: number; bytes: Uint8Array; sent: number; acked: number; requestId?: string }

/** Transport-only fragments. The original encrypted envelope is authenticated
 * by the existing crypto path after complete reassembly, before applying state. */
export class RelayTransport {
  private enabled = false
  private nextId = 0
  private outgoing: Transfer | null = null
  private incoming: { id: number; index: number; bytes: Uint8Array; offset: number; started: number } | null = null
  private queued: { bytes: Uint8Array; requestId?: string }[] = []
  private queuedBytes = 0
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private receiveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly socket: Socket) {
    socket.addEventListener?.('close', () => this.dispose())
  }

  send(text: string, requestId?: string) {
    const bytes = encoder.encode(text)
    if (bytes.length > RELAY_MESSAGE_BYTES) throw new Error('Relay message exceeds transport limit')
    if (!this.enabled || bytes.length <= RELAY_CHUNK_BYTES) {
      if ((this.socket.bufferedAmount ?? 0) > 512 * 1024) throw new Error('Relay send buffer is full')
      this.socket.send(text)
      return
    }
    if (this.queuedBytes + bytes.length > QUEUE_BYTES || this.queued.length >= 16) {
      throw new Error('Relay bulk queue is full')
    }
    this.queuedBytes += bytes.length
    this.queued.push({ bytes, requestId })
    this.startNext()
  }

  /** Returns only complete application messages. Acks/control consume no app cursor. */
  receive(text: string): string | null {
    if (!text.startsWith('{"type":"transport-')) return text
    if (text.length > 16 * 1024) throw new Error('Relay transport frame too large')
    const frame = JSON.parse(text)
    switch (frame.type) {
      case 'transport-ready':
        if (frame.version !== 'chunks-v1') throw new Error('Unsupported relay transport')
        this.enabled = true
        return null
      case 'transport-ack': {
        const tx = this.outgoing
        // Acknowledgements arrive in order; anything else is stale.
        if (!tx || frame.id !== tx.id || frame.index !== tx.acked) return null
        this.clearSendTimer()
        tx.acked++
        if (tx.acked === chunkCount(tx.bytes)) {
          this.queuedBytes -= tx.bytes.length
          this.outgoing = null
          this.startNext()
        } else {
          this.writeChunks()
          this.armSendTimer()
        }
        return null
      }
      case 'transport-cancel':
        if (this.incoming?.id === frame.id) this.clearIncoming()
        return null
      case 'transport-chunk': {
        if (!this.enabled || !Number.isSafeInteger(frame.id) || frame.id <= 0 ||
            !Number.isSafeInteger(frame.index) || frame.index < 0 ||
            !Number.isSafeInteger(frame.total) || frame.total <= 0 || frame.total > RELAY_MESSAGE_BYTES ||
            typeof frame.data !== 'string' || frame.data.length > Math.ceil(RELAY_CHUNK_BYTES / 3) * 4) {
          throw new Error('Invalid relay transport chunk')
        }
        if (!this.incoming && frame.index === 0) {
          this.incoming = { id: frame.id, index: 0, offset: 0, bytes: new Uint8Array(frame.total), started: Date.now() }
        }
        const rx = this.incoming
        const bytes = base64ToBytes(frame.data)
        if (!rx || rx.id !== frame.id || rx.index !== frame.index || rx.bytes.length !== frame.total ||
            !bytes.length || bytes.length > RELAY_CHUNK_BYTES || rx.offset + bytes.length > frame.total ||
            (bytes.length < RELAY_CHUNK_BYTES && rx.offset + bytes.length !== frame.total) || Date.now() - rx.started > 900_000) {
          throw new Error('Inconsistent relay transfer')
        }
        if (this.receiveTimer !== null) clearTimeout(this.receiveTimer)
        this.receiveTimer = setTimeout(() => this.fail(), Math.min(30_000, 900_000 - (Date.now() - rx.started)))
        rx.bytes.set(bytes, rx.offset)
        rx.offset += bytes.length
        rx.index++
        this.socket.send(JSON.stringify({ type: 'transport-ack', id: frame.id, index: frame.index }))
        if (rx.offset !== rx.bytes.length) return null
        this.clearIncoming()
        return decoder.decode(rx.bytes)
      }
      default: throw new Error('Unknown relay transport frame')
    }
  }

  /** Stop an unsent or incomplete request when its caller times out. This
   * cannot revoke a request whose final chunk has already reached the peer. */
  cancel(requestId: string) {
    this.queued = this.queued.filter(entry => {
      if (entry.requestId !== requestId) return true
      this.queuedBytes -= entry.bytes.length
      return false
    })
    if (this.outgoing?.requestId !== requestId) return
    const transfer = this.outgoing
    this.outgoing = null
    this.queuedBytes -= transfer.bytes.length
    this.clearSendTimer()
    try {
      this.socket.send(JSON.stringify({ type: 'transport-cancel', id: transfer.id }))
      this.startNext()
    } catch { this.fail() }
  }

  dispose() {
    this.clearSendTimer()
    this.clearIncoming()
    this.outgoing = null
    this.queued = []
    this.queuedBytes = 0
  }

  private startNext() {
    if (this.outgoing || !this.queued.length) return
    this.outgoing = { id: ++this.nextId, sent: 0, acked: 0, ...this.queued.shift()! }
    this.writeChunks()
    this.armSendTimer()
  }

  /** Fill the window: send every chunk the peer has credit for. */
  private writeChunks() {
    const tx = this.outgoing!
    const total = chunkCount(tx.bytes)
    while (tx.sent < total && tx.sent - tx.acked < RELAY_WINDOW_CHUNKS) {
      const offset = tx.sent * RELAY_CHUNK_BYTES
      this.socket.send(JSON.stringify({
        type: 'transport-chunk', id: tx.id, index: tx.sent, total: tx.bytes.length,
        data: bytesToBase64(tx.bytes.subarray(offset, offset + RELAY_CHUNK_BYTES)),
      }))
      tx.sent++
    }
  }

  /** The peer must acknowledge progress within the deadline or the link is dead. */
  private armSendTimer() {
    this.clearSendTimer()
    this.sendTimer = setTimeout(() => this.fail(), 30_000)
  }

  private clearSendTimer() {
    if (this.sendTimer !== null) clearTimeout(this.sendTimer)
    this.sendTimer = null
  }

  private clearIncoming() {
    if (this.receiveTimer !== null) clearTimeout(this.receiveTimer)
    this.receiveTimer = null
    this.incoming = null
  }

  private fail() { this.dispose(); this.socket.close() }
}

function chunkCount(bytes: Uint8Array) { return Math.ceil(bytes.length / RELAY_CHUNK_BYTES) }

const transports = new WeakMap<Socket, RelayTransport>()
function transport(socket: Socket) {
  let value = transports.get(socket)
  if (!value) { value = new RelayTransport(socket); transports.set(socket, value) }
  return value
}

export function sendRelayTransport(socket: Socket, text: string, requestId?: string) { transport(socket).send(text, requestId) }
export function cancelRelayTransport(socket: Socket, requestId: string) { transports.get(socket)?.cancel(requestId) }
export function receiveRelayTransport(socket: Socket, text: string) { return transport(socket).receive(text) }
