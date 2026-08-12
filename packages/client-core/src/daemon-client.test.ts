import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDaemonApiClient } from './daemon-client'

describe('createDaemonApiClient sendTurn', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('serializes the one-shot steer flag for a running follow-up', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await createDaemonApiClient('http://daemon.test').sendTurn({
      workspace_id: 'workspace',
      thread_id: 'thread',
      inputs: [{ type: 'text', text: 'adjust the active turn' }],
      steer: true,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://daemon.test/api/workspaces/workspace/threads/thread/turns')
    expect(JSON.parse(String(init?.body))).toMatchObject({ steer: true })
  })

  it('posts the complete queued message order', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createDaemonApiClient('http://daemon.test').reorderQueuedTurns(
      'workspace',
      'thread',
      ['queued-2', 'queued-1'],
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'http://daemon.test/api/workspaces/workspace/threads/thread/queue/reorder',
    )
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      queued_ids: ['queued-2', 'queued-1'],
    })
  })
})
