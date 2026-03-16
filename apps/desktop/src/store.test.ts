import { describe, expect, it } from 'vitest'

import { DEFAULT_UI_STATE, buildTimeline, uiReducer } from './store'
import type { EventEnvelope } from './types'

function createSnapshot() {
  return {
    daemon: { version: '0.1.0', started_at: new Date().toISOString() },
    workspaces: [
      {
        id: 'w1',
        path: '/tmp/falcondeck',
        status: 'ready' as const,
        models: [],
        account: { status: 'ready' as const, label: 'Signed in' },
        current_thread_id: 't1',
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      },
    ],
    threads: [
      {
        id: 't1',
        workspace_id: 'w1',
        title: 'Hello',
        status: 'idle' as const,
        updated_at: new Date().toISOString(),
        last_message_preview: null,
        latest_turn_id: null,
        latest_plan: null,
        latest_diff: null,
        last_tool: null,
        last_error: null,
      },
    ],
    approvals: [],
  }
}

describe('uiReducer', () => {
  it('hydrates selection from snapshot', () => {
    const next = uiReducer(DEFAULT_UI_STATE, {
      type: 'snapshot-loaded',
      snapshot: createSnapshot(),
    })

    expect(next.selectedWorkspaceId).toBe('w1')
    expect(next.selectedThreadId).toBe('t1')
  })

  it('adds approval requests from events', () => {
    const hydrated = uiReducer(DEFAULT_UI_STATE, {
      type: 'snapshot-loaded',
      snapshot: createSnapshot(),
    })

    const next = uiReducer(hydrated, {
      type: 'event-received',
      event: {
        seq: 1,
        emitted_at: new Date().toISOString(),
        workspace_id: 'w1',
        thread_id: 't1',
        event: {
          type: 'approval-request',
          request: {
            request_id: 'approval-1',
            workspace_id: 'w1',
            thread_id: 't1',
            method: 'item/commandExecution/requestApproval',
            title: 'Approve command',
            detail: null,
            command: 'rm -rf /tmp/demo',
            path: null,
            created_at: new Date().toISOString(),
          },
        },
      },
    })

    expect(next.snapshot?.approvals).toHaveLength(1)
    expect(next.snapshot?.approvals[0].request_id).toBe('approval-1')
  })

  it('replaces stale approvals when a snapshot event arrives', () => {
    const base = uiReducer(DEFAULT_UI_STATE, {
      type: 'snapshot-loaded',
      snapshot: {
        ...createSnapshot(),
        approvals: [
          {
            request_id: 'approval-1',
            workspace_id: 'w1',
            thread_id: 't1',
            method: 'item/commandExecution/requestApproval',
            title: 'Approve command',
            detail: null,
            command: 'echo hi',
            path: null,
            created_at: new Date().toISOString(),
          },
        ],
      },
    })

    const next = uiReducer(base, {
      type: 'event-received',
      event: {
        seq: 2,
        emitted_at: new Date().toISOString(),
        workspace_id: null,
        thread_id: null,
        event: {
          type: 'snapshot',
          snapshot: createSnapshot(),
        },
      },
    })

    expect(next.snapshot?.approvals).toHaveLength(0)
  })
})

describe('buildTimeline', () => {
  it('merges adjacent text deltas', () => {
    const base = {
      emitted_at: new Date().toISOString(),
      workspace_id: 'w1',
      thread_id: 't1',
    }

    const events: EventEnvelope[] = [
      {
        ...base,
        seq: 1,
        event: { type: 'text', item_id: 'msg-1', delta: 'Hello' },
      },
      {
        ...base,
        seq: 2,
        event: { type: 'text', item_id: 'msg-1', delta: ' world' },
      },
    ]

    const entries = buildTimeline(events)
    expect(entries).toHaveLength(1)
    expect(entries[0].markdown).toBe('Hello world')
  })

  it('formats turn lifecycle events for readable output', () => {
    const base = {
      emitted_at: new Date().toISOString(),
      workspace_id: 'w1',
      thread_id: 't1',
    }

    const entries = buildTimeline([
      {
        ...base,
        seq: 1,
        event: { type: 'turn-start', turn_id: 'turn-1' },
      },
      {
        ...base,
        seq: 2,
        event: { type: 'turn-end', turn_id: 'turn-1', status: 'completed', error: null },
      },
    ])

    expect(entries.map((entry) => entry.text)).toEqual(['Turn started', 'Turn completed'])
  })

  it('does not merge text across non-text events', () => {
    const base = {
      emitted_at: new Date().toISOString(),
      workspace_id: 'w1',
      thread_id: 't1',
    }

    const entries = buildTimeline([
      {
        ...base,
        seq: 1,
        event: { type: 'text', item_id: 'msg-1', delta: 'Hello' },
      },
      {
        ...base,
        seq: 2,
        event: { type: 'service', level: 'info', message: 'Thinking', raw_method: null },
      },
      {
        ...base,
        seq: 3,
        event: { type: 'text', item_id: 'msg-1', delta: ' again' },
      },
    ])

    expect(entries).toHaveLength(3)
    expect(entries[0].markdown).toBe('Hello')
    expect(entries[2].markdown).toBe(' again')
  })
})
