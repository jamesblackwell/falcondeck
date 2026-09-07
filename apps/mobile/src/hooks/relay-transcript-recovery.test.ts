import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type ThreadDetail } from '@falcondeck/client-core'
import { useRelayStore, useSessionStore } from '@/store'
import { assistantMessage, snapshot, snapshotEvent, thread, threadDetail } from '@/test/factories'
import { createRelayTranscriptRecovery } from './relay-transcript-recovery'
import { MOBILE_THREAD_DETAIL_OPTIONS, MOBILE_THREAD_DETAIL_TAIL_LIMIT } from './useSessionActions'

let recovery: ReturnType<typeof createRelayTranscriptRecovery>
let rpc: ReturnType<typeof vi.fn>
function deferred() {
  let resolve!: (detail: ThreadDetail) => void
  const promise = new Promise<ThreadDetail>(done => { resolve = done })
  return { promise, resolve }
}
const complete = () => threadDetail({ items: [assistantMessage('reply', 'complete')] })
async function settle() { await Promise.resolve(); await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  useSessionStore.getState().reset()
  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot({
    threads: [thread(), thread({ id: 'thread-2' })],
  })))
  useSessionStore.getState().selectThread('workspace-1', 'thread-1')
  rpc = vi.fn().mockResolvedValue(complete())
  useRelayStore.setState({ sessionId: 'session', _callRpc: rpc,
    machinePresence: { session_id: 'session', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null } })
  useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket)
  useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null })
  recovery = createRelayTranscriptRecovery()
})
afterEach(() => {
  recovery.cancel()
  useRelayStore.getState()._setSocket(null)
  useRelayStore.getState()._setSessionCrypto(null)
  vi.useRealTimers()
})

it('does not add conversation reads to ordinary index refreshes', () => {
  recovery.snapshotApplied()
  recovery.snapshotApplied()
  expect(rpc).not.toHaveBeenCalled()
})

it('coalesces invalidations behind the authoritative index and uses the shared compact policy', async () => {
  const pending = deferred()
  rpc.mockReturnValue(pending.promise)
  recovery.invalidate()
  recovery.invalidate()
  recovery.invalidate()
  expect(rpc).not.toHaveBeenCalled()
  recovery.snapshotApplied()
  recovery.snapshotApplied()
  expect(rpc).toHaveBeenCalledExactlyOnceWith('thread.detail', {
    workspace_id: 'workspace-1', thread_id: 'thread-1', mode: 'tail',
    limit: MOBILE_THREAD_DETAIL_TAIL_LIMIT, ...MOBILE_THREAD_DETAIL_OPTIONS,
  }, { requestIdPrefix: 'mobile-detail-recovery' })
  pending.resolve(complete())
  await settle()
  recovery.snapshotApplied()
  expect(rpc).toHaveBeenCalledOnce()
})

it('does not apply a recovery page or fetch the replacement thread after navigation', async () => {
  const pending = deferred()
  rpc.mockReturnValue(pending.promise)
  recovery.invalidate()
  recovery.snapshotApplied()
  useSessionStore.getState().selectThread('workspace-1', 'thread-2')
  pending.resolve(complete())
  await settle()
  expect(useSessionStore.getState().threadDetail).toBeNull()
  expect(useSessionStore.getState().threadItems['thread-1']).toBeUndefined()
  expect(rpc).toHaveBeenCalledOnce()
})

it('refetches once after a newer invalidation, without applying the superseded page', async () => {
  const old = deferred()
  const replacement = deferred()
  rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise)
  recovery.invalidate()
  recovery.snapshotApplied()
  recovery.invalidate()
  recovery.snapshotApplied()
  expect(rpc).toHaveBeenCalledOnce()
  old.resolve(complete())
  await settle()
  expect(useSessionStore.getState().threadDetail).toBeNull()
  expect(rpc).toHaveBeenCalledTimes(2)
  replacement.resolve(complete())
  await settle()
  expect(useSessionStore.getState().threadItems['thread-1']?.[0]?.id).toBe('reply')
})

it('retries failed details with bounded backoff, without refetching the index', async () => {
  rpc.mockRejectedValue(new Error('temporary failure'))
  recovery.invalidate()
  recovery.snapshotApplied()
  await settle()
  await vi.advanceTimersByTimeAsync(999)
  expect(rpc).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(rpc).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2000)
  expect(rpc).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(rpc).toHaveBeenCalledTimes(3)
  expect(rpc.mock.calls.every(call => call[0] === 'thread.detail')).toBe(true)
  expect(useSessionStore.getState().threadDetailErrors['thread-1']).toContain("Couldn't sync")
})

it('cancels scheduled recovery when its socket lifecycle ends', async () => {
  rpc.mockRejectedValue(new Error('offline'))
  recovery.invalidate()
  recovery.snapshotApplied()
  await settle()
  recovery.cancel()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(rpc).toHaveBeenCalledOnce()
})

it('does not transfer a retry to a newly selected conversation', async () => {
  rpc.mockRejectedValue(new Error('offline'))
  recovery.invalidate()
  recovery.snapshotApplied()
  await settle()
  useSessionStore.getState().selectThread('workspace-1', 'thread-2')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(rpc).toHaveBeenCalledOnce()
})

it('discards a reply from a replaced socket and does not cancel the current request', async () => {
  const old = deferred()
  const current = deferred()
  rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  recovery.invalidate()
  recovery.snapshotApplied()
  recovery.cancel()
  useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket)
  recovery.invalidate()
  recovery.snapshotApplied()
  old.resolve(complete())
  await settle()
  expect(useSessionStore.getState().threadDetail).toBeNull()
  current.resolve(complete())
  await settle()
  expect(useSessionStore.getState().threadItems['thread-1']?.[0]?.id).toBe('reply')
})
