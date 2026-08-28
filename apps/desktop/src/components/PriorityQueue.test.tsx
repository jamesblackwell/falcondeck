import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectGroup, ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'

import { DesktopSidebar } from './Sidebar'

const workspace = {
  id: 'workspace-1',
  path: '/projects/falcon',
  status: 'ready',
  agents: [],
  models: [],
  collaboration_modes: [],
  account: { status: 'ready', label: 'Ready' },
  current_thread_id: null,
  connected_at: '2026-08-13T09:00:00Z',
  updated_at: '2026-08-13T09:00:00Z',
  last_error: null,
} as WorkspaceSummary

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    workspace_id: workspace.id,
    title: id,
    provider: 'codex',
    status: 'idle',
    updated_at: '2026-08-13T10:00:00Z',
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
    is_pinned_in_project: false,
    ...overrides,
  } as ThreadSummary
}

function sidebar(groups: ProjectGroup[], selectedThreadId: string | null) {
  return <DesktopSidebar
    groups={groups}
    selectedWorkspaceId={workspace.id}
    selectedThreadId={selectedThreadId}
    onSelectWorkspace={vi.fn()}
    onSelectThread={vi.fn()}
    threadSort="priority"
  />
}

function precedes(left: string, right: string) {
  const projects = screen.getByRole('region', { name: 'Projects' })
  return within(projects).getByText(left).compareDocumentPosition(within(projects).getByText(right))
}

function precedesIn(regionName: string, left: string, right: string) {
  const region = screen.getByRole('region', { name: regionName })
  return within(region).getByText(left).compareDocumentPosition(within(region).getByText(right))
}

describe('Priority chat queue', () => {
  it('keeps the initial order stable while snapshot timestamps churn', () => {
    const alpha = thread('Alpha', { status: 'running', updated_at: '2026-08-13T11:00:00Z' })
    const beta = thread('Beta', { status: 'running', updated_at: '2026-08-13T10:00:00Z' })
    const { rerender } = render(sidebar([{ workspace, threads: [alpha, beta] }], null))
    expect(precedes('Alpha', 'Beta')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    rerender(sidebar([{ workspace, threads: [{ ...beta, updated_at: '2026-08-13T12:00:00Z' }, alpha] }], null))
    expect(precedes('Alpha', 'Beta')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('preserves source order when several chats arrive in one snapshot', () => {
    const existing = thread('Existing', { status: 'running' })
    const { rerender } = render(sidebar([{ workspace, threads: [existing] }], null))
    const firstArrival = thread('First arrival', { status: 'running' })
    const secondArrival = thread('Second arrival', { status: 'running' })

    rerender(sidebar([{
      workspace,
      threads: [firstArrival, secondArrival, existing],
    }], null))

    expect(precedes('First arrival', 'Second arrival')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(precedes('Second arrival', 'Existing')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps pinned Priority rows stable while timestamps churn', () => {
    const alpha = thread('Pinned Alpha', {
      is_pinned: true,
      is_pinned_in_project: false,
      status: 'running',
      updated_at: '2026-08-13T11:00:00Z',
    })
    const beta = thread('Pinned Beta', {
      is_pinned: true,
      is_pinned_in_project: false,
      status: 'running',
      updated_at: '2026-08-13T10:00:00Z',
    })
    const { rerender } = render(sidebar([{ workspace, threads: [alpha, beta] }], null))
    expect(precedesIn('Pinned', 'Pinned Alpha', 'Pinned Beta'))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    rerender(sidebar([{
      workspace,
      threads: [{ ...beta, updated_at: '2026-08-13T12:00:00Z' }, alpha],
    }], null))
    expect(precedesIn('Pinned', 'Pinned Alpha', 'Pinned Beta'))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('promotes immediately without reordering when selection changes', () => {
    const blocked = thread('Blocked', {
      attention: {
        ...thread('base').attention,
        level: 'awaiting_response',
        pending_approval_count: 1,
      },
    })
    const running = thread('Running', { status: 'running' })
    const quiet = thread('Quiet')
    const { rerender } = render(sidebar([{ workspace, threads: [quiet, running, blocked] }], blocked.id))

    const promoted = thread('Quiet', {
      attention: { ...quiet.attention, level: 'error', unread: true },
    })
    const read = thread('Blocked')
    const changed = [{ workspace, threads: [promoted, running, read] }]
    rerender(sidebar(changed, blocked.id))
    expect(precedes('Blocked', 'Quiet')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(precedes('Quiet', 'Running')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    rerender(sidebar(changed, running.id))
    expect(precedes('Blocked', 'Quiet')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(precedes('Quiet', 'Running')).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
