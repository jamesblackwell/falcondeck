import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from './crypto'
import { RELAY_CHUNK_BYTES, RELAY_MESSAGE_BYTES, RelayTransport } from './relay-transport'

function setup() {
  const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 }
  const transport = new RelayTransport(socket)
  transport.receive('{"type":"transport-ready","version":"chunks-v1"}')
  return { socket, transport }
}
afterEach(() => vi.useRealTimers())

describe('relay transport', () => {
  it('keeps legacy wire messages until capability negotiation', () => {
    const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 }
    const transport = new RelayTransport(socket)
    const payload = JSON.stringify({ data: 'x'.repeat(RELAY_CHUNK_BYTES * 2) })
    transport.send(payload)
    expect(socket.send).toHaveBeenCalledWith(payload)
    transport.dispose()
  })

  it('sends small requests while bulk waits for acknowledgement', () => {
    const { socket, transport } = setup()
    transport.send(JSON.stringify({ data: 'x'.repeat(RELAY_CHUNK_BYTES * 3) }))
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.send.mock.calls[0][0].length).toBeLessThan(16 * 1024)
    const first = JSON.parse(socket.send.mock.calls[0][0])
    transport.send('{"type":"rpc-call","request_id":"interactive"}')
    expect(socket.send.mock.calls[1][0]).toContain('interactive')
    transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index: first.index }))
    expect(JSON.parse(socket.send.mock.calls[2][0]).index).toBe(1)
    transport.dispose()
  })

  it('reassembles UTF-8 without exposing partial state and rejects duplicate chunks', () => {
    const { transport } = setup()
    const data = new TextEncoder().encode(JSON.stringify({ data: '🦅'.repeat(6000) }))
    let complete: string | null = null
    for (let offset = 0, index = 0; offset < data.length; offset += RELAY_CHUNK_BYTES, index++) {
      complete = transport.receive(JSON.stringify({ type: 'transport-chunk', id: 1, index, total: data.length, data: bytesToBase64(data.subarray(offset, offset + RELAY_CHUNK_BYTES)) }))
      if (offset + RELAY_CHUNK_BYTES < data.length) expect(complete).toBeNull()
    }
    expect(JSON.parse(complete!).data).toBe('🦅'.repeat(6000))
    const chunk = JSON.stringify({ type: 'transport-chunk', id: 2, index: 0, total: data.length, data: bytesToBase64(data.subarray(0, RELAY_CHUNK_BYTES)) })
    transport.receive(chunk)
    expect(() => transport.receive(chunk)).toThrow('Inconsistent')
    transport.dispose()
  })

  it('cancels a timed-out upload instead of submitting it after its caller has failed', () => {
    const { socket, transport } = setup()
    transport.send('x'.repeat(RELAY_CHUNK_BYTES * 3), 'expired')
    const first = JSON.parse(socket.send.mock.calls[0][0])
    transport.send('y'.repeat(RELAY_CHUNK_BYTES * 2), 'queued-expired')
    transport.cancel('queued-expired')
    transport.cancel('expired')
    expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({ type: 'transport-cancel', id: first.id })
    transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index: 0 }))
    expect(socket.send).toHaveBeenCalledTimes(2)
    transport.send('z'.repeat(RELAY_CHUNK_BYTES * 2), 'next')
    expect(JSON.parse(socket.send.mock.calls[2][0]).index).toBe(0)
    transport.dispose()
  })

  it('bounds declared sizes and clears stalled transfers', () => {
    vi.useFakeTimers()
    const { socket, transport } = setup()
    expect(() => transport.receive(JSON.stringify({ type: 'transport-chunk', id: 1, index: 0, total: RELAY_MESSAGE_BYTES + 1, data: 'eA==' }))).toThrow()
    transport.send('x'.repeat(RELAY_CHUNK_BYTES * 2))
    vi.advanceTimersByTime(30_001)
    expect(socket.close).toHaveBeenCalledOnce()
  })
})
