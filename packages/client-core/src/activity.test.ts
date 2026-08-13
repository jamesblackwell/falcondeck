import { describe, expect, it } from 'vitest'

import { collectActivityEntries, countActivityEntries } from './activity'
import type { ProjectGroup } from './grouping'
import type { InteractiveRequest, ThreadSummary, WorkspaceSummary } from './types'

const workspace = { id: 'workspace', path: '/projects/falcon' } as WorkspaceSummary

function thread(overrides: Partial<ThreadSummary> & Pick<ThreadSummary, 'id'>): ThreadSummary {
  return {
    workspace_id: workspace.id,
    title: overrides.id,
    provider: 'codex',
    status: 'idle',
    updated_at: '2026-08-13T12:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {},
    attention: {
      level: 'none',
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  } as ThreadSummary
}

function request(
  threadId: string,
  overrides: Partial<InteractiveRequest> = {},
): InteractiveRequest {
  return {
    request_id: `request-${threadId}`,
    workspace_id: workspace.id,
    thread_id: threadId,
    method: 'command',
    kind: 'approval',
    title: 'Run command',
    detail: null,
    command: 'npm test',
    path: '/projects/falcon',
    turn_id: null,
    item_id: null,
    questions: [],
    created_at: '2026-08-13T11:00:00Z',
    ...overrides,
  }
}

function group(threads: ThreadSummary[]): ProjectGroup {
  return { workspace, threads }
}

describe('collectActivityEntries', () => {
  it('assigns each thread to the highest-priority matching section', () => {
    const blocked = thread({
      id: 'blocked',
      status: 'running',
      attention: {
        ...thread({ id: 'base' }).attention,
        level: 'error',
        unread: true,
        pending_approval_count: 1,
      },
    })
    const failed = thread({
      id: 'failed',
      attention: { ...thread({ id: 'base' }).attention, level: 'error', unread: true },
    })
    const ready = thread({
      id: 'ready',
      attention: { ...thread({ id: 'base' }).attention, level: 'unread', unread: true },
    })
    const running = thread({
      id: 'running',
      status: 'running',
      attention: { ...thread({ id: 'base' }).attention, level: 'running' },
    })

    expect(collectActivityEntries([group([running, ready, failed, blocked])], []))
      .toMatchObject([
        { section: 'blocked', thread: { id: 'blocked' } },
        { section: 'failed', thread: { id: 'failed' } },
        { section: 'ready', thread: { id: 'ready' } },
        { section: 'running', thread: { id: 'running' } },
      ])
  })

  it('recognizes both blocked signals and keeps request payloads oldest-first', () => {
    const countOnly = thread({
      id: 'count-only',
      attention: { ...thread({ id: 'base' }).attention, pending_question_count: 1 },
    })
    const requestOnly = thread({ id: 'request-only', status: 'running' })
    const question = request('request-only', {
      request_id: 'question',
      kind: 'question',
      created_at: '2026-08-13T10:00:00Z',
    })
    const approval = request('request-only', {
      request_id: 'approval',
      created_at: '2026-08-13T09:00:00Z',
    })

    const entries = collectActivityEntries([group([countOnly, requestOnly])], [question, approval])
    expect(entries.map((entry) => entry.thread.id)).toEqual(['request-only', 'count-only'])
    expect(entries[0]?.requests.map(({ request_id }) => request_id)).toEqual(['approval', 'question'])
  })

  it('excludes archived and acknowledged failures', () => {
    const archived = thread({ id: 'archived', is_archived: true })
    const acknowledged = thread({
      id: 'acknowledged',
      attention: { ...thread({ id: 'base' }).attention, level: 'error', unread: false },
    })
    expect(collectActivityEntries([group([archived, acknowledged])], [])).toEqual([])
  })

  it('sorts blocked approvals before questions and ready/failed by newest update', () => {
    const oldFailure = thread({
      id: 'old-failure',
      updated_at: '2026-08-13T08:00:00Z',
      attention: { ...thread({ id: 'base' }).attention, level: 'error', unread: true },
    })
    const newFailure = thread({
      id: 'new-failure',
      updated_at: '2026-08-13T09:00:00Z',
      attention: { ...thread({ id: 'base' }).attention, level: 'error', unread: true },
    })
    const approvalThread = thread({ id: 'approval-thread' })
    const questionThread = thread({ id: 'question-thread' })

    const entries = collectActivityEntries(
      [group([oldFailure, questionThread, newFailure, approvalThread])],
      [
        request('question-thread', { kind: 'question', created_at: '2026-08-13T07:00:00Z' }),
        request('approval-thread', { created_at: '2026-08-13T10:00:00Z' }),
      ],
    )
    expect(entries.map((entry) => entry.thread.id)).toEqual([
      'approval-thread',
      'question-thread',
      'new-failure',
      'old-failure',
    ])
  })

  it('counts only attention sections', () => {
    const blocked = thread({
      id: 'blocked',
      attention: { ...thread({ id: 'base' }).attention, pending_approval_count: 1 },
    })
    const failed = thread({
      id: 'failed',
      attention: { ...thread({ id: 'base' }).attention, level: 'error', unread: true },
    })
    const ready = thread({
      id: 'ready',
      attention: { ...thread({ id: 'base' }).attention, level: 'unread', unread: true },
    })
    const running = thread({
      id: 'running',
      status: 'running',
      attention: { ...thread({ id: 'base' }).attention, level: 'running' },
    })
    expect(countActivityEntries([group([blocked, failed, ready, running])], [])).toEqual({
      blocked: 1,
      failed: 1,
      ready: 1,
    })
  })
})
