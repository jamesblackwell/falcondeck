import { describe, expect, it } from 'vitest'

import { deriveConversationPresentation } from './conversation'
import { normalizePreferences } from './normalization'
import type {
  ConversationItem,
  FalconDeckPreferences,
  ToolDetailsMode,
  ToolHookOutputEntry,
  ToolLifecycle,
} from './types'

function hookRun(
  lifecycle: ToolLifecycle,
  entries: ToolHookOutputEntry[] = [],
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>> = {},
): Extract<ConversationItem, { kind: 'tool_call' }> {
  return {
    kind: 'tool_call',
    id: `hook-${lifecycle}`,
    title: 'Hook · post tool use',
    tool_kind: 'hookRun',
    status: 'provider_specific',
    output: null,
    exit_code: null,
    display: {
      is_read_only: false,
      has_side_effect: true,
      is_error: lifecycle === 'failed',
      lifecycle,
      artifact_kind: 'command_output',
      activity_kind: 'other',
      history_mode: 'full',
      summary_hint: null,
    },
    detail: {
      kind: 'hook',
      event_name: 'postToolUse',
      handler_type: 'command',
      execution_mode: 'blocking',
      scope: 'project',
      source_path: '.claude/hooks/check.sh',
      duration_ms: 12,
      status_message: null,
      entries,
    },
    created_at: '2026-08-09T12:00:00Z',
    completed_at: '2026-08-09T12:00:01Z',
    ...overrides,
  }
}

function readTool(
  id: string,
): Extract<ConversationItem, { kind: 'tool_call' }> {
  return {
    kind: 'tool_call',
    id,
    title: 'Read file',
    tool_kind: 'read',
    status: 'completed',
    output: null,
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle: 'succeeded',
      artifact_kind: 'none',
      activity_kind: 'read',
      history_mode: 'summary',
      summary_hint: 'Read file',
    },
    detail: null,
    created_at: '2026-08-09T12:00:00Z',
    completed_at: '2026-08-09T12:00:01Z',
  }
}

function preferences(mode: ToolDetailsMode): FalconDeckPreferences {
  const defaults = normalizePreferences(null)
  return {
    ...defaults,
    conversation: {
      ...defaults.conversation,
      group_read_only_tools: true,
      tool_details_mode: mode,
    },
  }
}

describe('hook run presentation', () => {
  it.each(['auto', 'compact', 'hide_read_only_details'] as const)(
    'drops an uneventful hook run from the timeline in %s mode',
    (mode) => {
      const presentation = deriveConversationPresentation(
        [hookRun('succeeded')],
        preferences(mode),
      )

      expect(presentation.history_blocks).toHaveLength(0)
    },
  )

  it('keeps every hook run visible in expanded mode', () => {
    const presentation = deriveConversationPresentation(
      [hookRun('succeeded')],
      preferences('expanded'),
    )

    expect(presentation.history_blocks).toHaveLength(1)
    expect(presentation.history_blocks[0]).toMatchObject({
      kind: 'item',
      id: 'tool_call:hook-succeeded',
    })
  })

  it.each(['failed', 'denied'] as const)(
    'keeps a %s hook run as a first-class row in compact mode',
    (lifecycle) => {
      const presentation = deriveConversationPresentation(
        [hookRun(lifecycle)],
        preferences('compact'),
      )

      expect(presentation.history_blocks).toHaveLength(1)
      expect(presentation.history_blocks[0]).toMatchObject({
        kind: 'item',
        id: `tool_call:hook-${lifecycle}`,
      })
    },
  )

  it.each(['warning', 'error', 'stop'] as const)(
    'keeps a succeeded hook run that emitted a %s entry',
    (entryKind) => {
      const presentation = deriveConversationPresentation(
        [hookRun('succeeded', [{ entry_kind: entryKind, text: 'heads up' }])],
        preferences('auto'),
      )

      expect(presentation.history_blocks).toHaveLength(1)
      expect(presentation.history_blocks[0]).toMatchObject({ kind: 'item' })
    },
  )

  it('drops a hook run whose entries are all informational', () => {
    const presentation = deriveConversationPresentation(
      [hookRun('succeeded', [{ entry_kind: 'info', text: 'ran fine' }])],
      preferences('auto'),
    )

    expect(presentation.history_blocks).toHaveLength(0)
  })

  it('does not let a hook run split a grouped read summary', () => {
    const presentation = deriveConversationPresentation(
      [readTool('read-a'), hookRun('succeeded'), readTool('read-b')],
      preferences('auto'),
    )

    expect(presentation.history_blocks).toHaveLength(1)
    expect(presentation.history_blocks[0]).toMatchObject({
      kind: 'tool_summary',
      id: 'tool-summary:read-a',
    })
  })

  it('still buries hook runs inside the work session in collapsed mode', () => {
    const presentation = deriveConversationPresentation(
      [readTool('read-a'), hookRun('failed')],
      preferences('collapsed'),
    )

    expect(presentation.history_blocks).toHaveLength(1)
    expect(presentation.history_blocks[0]).toMatchObject({
      kind: 'work_session',
      id: 'tool_call:read-a',
    })
  })
})
