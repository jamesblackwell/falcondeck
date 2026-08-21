import { describe, expect, it } from 'vitest'

import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { SHUTDOWN_INTERRUPTED_TURN_ERROR } from '@falcondeck/client-core'

import {
  normalizeSendError,
  stoppedThreadsToOffer,
  workspaceComposerDisabled,
  workspaceSendBlockReason,
} from './app-utils'

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'workspace-1',
    path: '/Users/james/falcondeck',
    status: 'ready',
    agents: [],
    default_provider: 'codex',
    models: [],
    collaboration_modes: [],
    account: { status: 'ready', label: 'Ready' },
    current_thread_id: null,
    connected_at: '2026-03-20T12:00:00Z',
    updated_at: '2026-03-20T12:00:00Z',
    last_error: null,
    ...overrides,
  }
}

describe('workspaceSendBlockReason', () => {
  it('keeps the composer interactive when only the selected provider needs auth', () => {
    expect(
      workspaceComposerDisabled(
        workspace({
          agents: [
            {
              provider: 'claude',
              label: 'Claude',
              account: { status: 'needs_auth', label: 'Sign in' },
              models: [],
              collaboration_modes: [],
            },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('surfaces concise reconnecting project guidance', () => {
    expect(
      workspaceSendBlockReason(
        workspace({
          status: 'connecting',
          path: '/Users/james/falcondeck/alpha',
        }),
        'codex',
      ),
    ).toBe('Reconnecting to alpha. You can keep drafting while it reconnects.')
  })

  it('blocks when the selected provider needs auth', () => {
    expect(
      workspaceSendBlockReason(
        workspace({
          agents: [
            {
              provider: 'claude',
              label: 'Claude',
              account: { status: 'needs_auth', label: 'Sign in' },
              models: [],
              collaboration_modes: [],
            },
          ],
        }),
        'claude',
      ),
    ).toBe('Claude is logged out. Run `claude auth login` before sending messages.')
  })
})

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Pricing and unlimited',
    provider: 'codex',
    status: 'error',
    updated_at: '2026-08-14T10:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: SHUTDOWN_INTERRUPTED_TURN_ERROR,
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: 'error',
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    ...overrides,
  }
}

describe('stoppedThreadsToOffer', () => {
  it('offers unarchived threads the last shutdown stopped', () => {
    expect(
      stoppedThreadsToOffer({
        threads: [
          thread(),
          thread({ id: 'thread-2', status: 'idle', last_error: null }),
          thread({ id: 'thread-3', is_archived: true }),
          thread({ id: 'thread-4', last_error: 'Something else failed' }),
        ],
        workspaces: [workspace()],
        remoteHosts: [],
      })?.map((entry) => entry.id),
    ).toEqual(['thread-1'])
  })

  it('holds off while a project is still connecting', () => {
    expect(
      stoppedThreadsToOffer({
        threads: [thread()],
        workspaces: [workspace(), workspace({ id: 'workspace-2', status: 'connecting' })],
        remoteHosts: [],
      }),
    ).toBeNull()
  })

  it('holds off until a connected remote host has reported its threads', () => {
    expect(
      stoppedThreadsToOffer({
        threads: [thread()],
        workspaces: [workspace()],
        remoteHosts: [{ isConnected: true, hasSnapshot: false }],
      }),
    ).toBeNull()
    // A host that is not connected is never going to report; waiting on it
    // would suppress the prompt entirely.
    expect(
      stoppedThreadsToOffer({
        threads: [thread()],
        workspaces: [workspace()],
        remoteHosts: [{ isConnected: false, hasSnapshot: false }],
      }),
    ).toHaveLength(1)
  })

  it('answers with an empty offer when nothing was stopped', () => {
    expect(
      stoppedThreadsToOffer({
        threads: [thread({ status: 'idle', last_error: null })],
        workspaces: [workspace()],
        remoteHosts: [],
      }),
    ).toEqual([])
  })
})

describe('normalizeSendError', () => {
  it('rewrites Claude connectivity failures into actionable copy', () => {
    expect(normalizeSendError('workspace is not currently connected to Claude', 'claude')).toContain(
      'not connected to Claude yet',
    )
  })

  it('rewrites Antigravity connectivity failures into actionable copy', () => {
    expect(
      normalizeSendError('workspace is not currently connected to Antigravity', 'agy'),
    ).toContain('not connected to Antigravity yet')
  })

  it('preserves unrelated errors', () => {
    expect(normalizeSendError('Something else went wrong', 'codex')).toBe('Something else went wrong')
  })
})
