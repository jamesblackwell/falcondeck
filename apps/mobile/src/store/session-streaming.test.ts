import { beforeEach, describe, expect, it } from 'vitest'

import type { ConversationItem, EventEnvelope } from '@falcondeck/client-core'

import {
  assistantMessage,
  conversationItemAddedEvent,
  snapshot,
  snapshotEvent,
} from '../test/factories'
import { useSessionStore } from './session-store'

describe('mobile session streaming', () => {
  beforeEach(() => useSessionStore.getState().reset())

  it('applies an anchored delta to cached and active thread history', () => {
    const store = useSessionStore.getState()
    store.applyDaemonEvent(snapshotEvent(snapshot()))
    store.setThreadDetail({
      workspace: snapshot().workspaces[0]!,
      thread: snapshot().threads[0]!,
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    })
    store.applyDaemonEvent(
      conversationItemAddedEvent(assistantMessage('assistant-1', 'Hello')),
    )

    const delta: EventEnvelope = {
      seq: 3,
      emitted_at: '2026-08-08T20:00:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'text',
        item_id: 'assistant-1',
        delta: ' world',
        target: 'assistant_text',
        start_offset: 5,
        end_offset: 11,
      },
    }
    useSessionStore.getState().applyDaemonEvent(delta)

    expect(
      useSessionStore.getState().threadItems['thread-1']?.[0],
    ).toMatchObject({
      text: 'Hello world',
    })
    expect(useSessionStore.getState().threadDetail?.items[0]).toMatchObject({
      text: 'Hello world',
    })
  })

  it('applies command output deltas to cached and active thread history', () => {
    const store = useSessionStore.getState()
    store.applyDaemonEvent(snapshotEvent(snapshot()))
    store.setThreadDetail({
      workspace: snapshot().workspaces[0]!,
      thread: snapshot().threads[0]!,
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    })
    store.applyDaemonEvent(
      conversationItemAddedEvent({
        kind: 'tool_call',
        id: 'command-1',
        title: 'npm test',
        tool_kind: 'commandExecution',
        status: 'running',
        output: '',
        exit_code: null,
        display: {
          is_read_only: false,
          has_side_effect: true,
          is_error: false,
          lifecycle: 'running',
          artifact_kind: 'command_output',
          activity_kind: 'test',
          history_mode: 'full',
          summary_hint: null,
        },
        created_at: '2026-08-08T20:00:00Z',
        completed_at: null,
      }),
    )

    useSessionStore.getState().applyDaemonEvent({
      seq: 3,
      emitted_at: '2026-08-08T20:00:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'text',
        item_id: 'command-1',
        delta: 'PASS',
        target: 'tool_output',
        start_offset: 0,
        end_offset: 4,
      },
    })

    expect(
      useSessionStore.getState().threadItems['thread-1']?.[0],
    ).toMatchObject({ output: 'PASS' })
    expect(useSessionStore.getState().threadDetail?.items[0]).toMatchObject({
      output: 'PASS',
    })
  })

  it('retains terminal lifecycle when delayed text reaches cached and active history', () => {
    const store = useSessionStore.getState()
    store.applyDaemonEvent(snapshotEvent(snapshot()))
    store.setThreadDetail({
      workspace: snapshot().workspaces[0]!,
      thread: snapshot().threads[0]!,
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    })
    const terminalAssistant = assistantMessage(
      'assistant-1',
      'Partial',
    ) as Extract<ConversationItem, { kind: 'assistant_message' }>
    store.applyDaemonEvent(
      conversationItemAddedEvent({
        ...terminalAssistant,
        lifecycle: 'interrupted',
      }),
    )

    store.applyDaemonEvent({
      seq: 3,
      emitted_at: '2026-08-08T20:00:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'text',
        item_id: 'assistant-1',
        delta: ' answer',
        target: 'assistant_text',
        start_offset: 7,
        end_offset: 14,
      },
    })

    expect(
      useSessionStore.getState().threadItems['thread-1']?.[0],
    ).toMatchObject({
      text: 'Partial answer',
      lifecycle: 'interrupted',
    })
    expect(useSessionStore.getState().threadDetail?.items[0]).toMatchObject({
      text: 'Partial answer',
      lifecycle: 'interrupted',
    })
  })
})
