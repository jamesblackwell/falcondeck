import { afterEach, expect, it, vi } from 'vitest'
import { useRelayStore } from '@/store/relay-store'
import { installReliabilityProbe } from './reliability-probe'

let cleanup: (() => void) | undefined
const original = useRelayStore.getState()._callRpc
const originalResult = useRelayStore.getState()._handleRpcResult
afterEach(() => {
  cleanup?.(); cleanup = undefined
  useRelayStore.setState({ _callRpc: original, _handleRpcResult: originalResult })
  vi.unstubAllGlobals(); vi.useRealTimers()
})

it('does not export diagnostics to non-loopback endpoints', () => {
  expect(installReliabilityProbe('https://example.com')).toBeUndefined()
  expect(installReliabilityProbe('http://127.0.0.1:12@other.example')).toBeUndefined()
  expect(useRelayStore.getState()._callRpc).toBe(original)
})

it('records timing without exporting request parameters or response contents', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetch)
  useRelayStore.setState({ _callRpc: vi.fn().mockResolvedValue({ secret: 'response-secret' }) })
  cleanup = installReliabilityProbe('http://127.0.0.1:1234')
  expect(cleanup).toBeTypeOf('function')
  await useRelayStore.getState()._callRpc('thread.detail', { prompt: 'request-secret' })
  await vi.advanceTimersByTimeAsync(1000)
  const body = fetch.mock.calls[0][1].body as string
  expect(body).toContain('rpc.start')
  expect(body).toContain('rpc.end')
  expect(body).not.toContain('request-secret')
  expect(body).not.toContain('response-secret')
})

it('preserves whether a response matched an outstanding RPC', async () => {
  vi.useFakeTimers()
  useRelayStore.setState({ _handleRpcResult: vi.fn().mockResolvedValue(true) })
  cleanup = installReliabilityProbe('http://127.0.0.1:1234')
  expect(await useRelayStore.getState()._handleRpcResult({ type: 'rpc-result', request_id: 'test', ok: true })).toBe(true)
})
