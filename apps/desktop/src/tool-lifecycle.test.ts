import { describe, expect, it } from 'vitest'

import {
  fileChangeLifecycle,
  toolLifecycle,
  toolLifecycleLabel,
  type ConversationItem,
  type ToolCallDisplay,
  type ToolLifecycle,
} from '@falcondeck/client-core'

const baseDisplay: ToolCallDisplay = {
  is_read_only: false,
  has_side_effect: true,
  is_error: false,
  artifact_kind: 'command_output',
  activity_kind: 'command',
  history_mode: 'full',
  summary_hint: null,
}

function call(
  status: string,
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>> = {},
) {
  return {
    kind: 'tool_call',
    id: `tool-${status}`,
    title: 'Run checks',
    tool_kind: 'commandExecution',
    status,
    output: null,
    exit_code: null,
    display: baseDisplay,
    created_at: '2026-08-08T20:00:00Z',
    completed_at: null,
    ...overrides,
  } satisfies Extract<ConversationItem, { kind: 'tool_call' }>
}

describe('tool lifecycle normalization', () => {
  it.each<[string, ToolLifecycle]>([
    ['pending', 'queued'],
    ['created', 'queued'],
    ['awaiting-confirmation', 'awaiting_approval'],
    ['inProgress', 'running'],
    ['streaming', 'running'],
    ['done', 'succeeded'],
    ['errored', 'failed'],
    ['blocked', 'failed'],
    ['rejected', 'denied'],
    ['cancelled', 'interrupted'],
    ['provider_magic', 'unknown'],
  ])('maps %s to %s for older daemon history', (status, expected) => {
    expect(toolLifecycle(call(status))).toBe(expected)
  })

  it('uses daemon lifecycle metadata when it is available', () => {
    expect(
      toolLifecycle(
        call('provider_magic', {
          display: { ...baseDisplay, lifecycle: 'queued' },
        }),
      ),
    ).toBe('queued')
  })

  it('falls back to raw status when metadata explicitly says unknown', () => {
    expect(
      toolLifecycle(
        call('completed', {
          display: { ...baseDisplay, lifecycle: 'unknown' },
        }),
      ),
    ).toBe('succeeded')
  })

  it('treats a non-zero exit as failed even when provider status says success', () => {
    expect(toolLifecycle(call('completed', { exit_code: 7 }))).toBe('failed')
  })

  it('keeps legacy blocked file changes visibly failed', () => {
    expect(
      fileChangeLifecycle({ status: 'blocked', lifecycle: 'unknown' }),
    ).toBe('failed')
  })

  it('provides concise user-facing labels for every state', () => {
    expect(
      (
        [
          'unknown',
          'queued',
          'awaiting_approval',
          'running',
          'succeeded',
          'failed',
          'denied',
          'interrupted',
        ] as ToolLifecycle[]
      ).map(toolLifecycleLabel),
    ).toEqual([
      'Unknown status',
      'Queued',
      'Awaiting approval',
      'Running',
      'Completed',
      'Failed',
      'Denied',
      'Interrupted',
    ])
  })
})
