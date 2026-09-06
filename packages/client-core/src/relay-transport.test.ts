import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from './crypto'
import { RELAY_CHUNK_BYTES, RELAY_MESSAGE_BYTES, RELAY_WINDOW_CHUNKS, RelayTransport } from './relay-transport'

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
    transport.send(JSON.stringify({ data: 'x'.repeat(RELAY_CHUNK_BYTES * (RELAY_WINDOW_CHUNKS + 2)) }))
    // A full window goes out without waiting; the rest needs credit.
    expect(socket.send).toHaveBeenCalledTimes(RELAY_WINDOW_CHUNKS)
    for (const [index, call] of socket.send.mock.calls.entries()) {
      expect(call[0].length).toBeLessThan(16 * 1024)
      expect(JSON.parse(call[0]).index).toBe(index)
    }
    const first = JSON.parse(socket.send.mock.calls[0][0])
    transport.send('{"type":"rpc-call","request_id":"interactive"}')
    expect(socket.send.mock.calls[RELAY_WINDOW_CHUNKS][0]).toContain('interactive')
    // Out-of-order or stale acknowledgements open no credit.
    transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index: 5 }))
    expect(socket.send).toHaveBeenCalledTimes(RELAY_WINDOW_CHUNKS + 1)
    transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index: 0 }))
    expect(JSON.parse(socket.send.mock.calls[RELAY_WINDOW_CHUNKS + 1][0]).index).toBe(RELAY_WINDOW_CHUNKS)
    transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index: 1 }))
    expect(JSON.parse(socket.send.mock.calls[RELAY_WINDOW_CHUNKS + 2][0]).index).toBe(RELAY_WINDOW_CHUNKS + 1)
    expect(socket.send).toHaveBeenCalledTimes(RELAY_WINDOW_CHUNKS + 3)
    transport.dispose()
  })

  it('completes a transfer and starts the next once every chunk is acknowledged', () => {
    const { socket, transport } = setup()
    transport.send('x'.repeat(RELAY_CHUNK_BYTES * 3), 'first')
    transport.send('y'.repeat(RELAY_CHUNK_BYTES * 2), 'second')
    expect(socket.send).toHaveBeenCalledTimes(3)
    const first = JSON.parse(socket.send.mock.calls[0][0])
    for (let index = 0; index < 3; index++) {
      transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index }))
    }
    expect(socket.send).toHaveBeenCalledTimes(5)
    const second = JSON.parse(socket.send.mock.calls[3][0])
    expect(second.id).not.toBe(first.id)
    expect(second.index).toBe(0)
    expect(JSON.parse(socket.send.mock.calls[4][0]).index).toBe(1)
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
    expect(socket.send).toHaveBeenCalledTimes(3)
    const first = JSON.parse(socket.send.mock.calls[0][0])
    transport.send('y'.repeat(RELAY_CHUNK_BYTES * 2), 'queued-expired')
    transport.cancel('queued-expired')
    transport.cancel('expired')
    expect(JSON.parse(socket.send.mock.calls[3][0])).toEqual({ type: 'transport-cancel', id: first.id })
    transport.receive(JSON.stringify({ type: 'transport-ack', id: first.id, index: 0 }))
    expect(socket.send).toHaveBeenCalledTimes(4)
    transport.send('z'.repeat(RELAY_CHUNK_BYTES * 2), 'next')
    expect(JSON.parse(socket.send.mock.calls[4][0]).index).toBe(0)
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
