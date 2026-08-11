import { describe, expect, it } from 'vitest'

import { deriveConversationPresentation } from './conversation'
import { normalizePreferences } from './normalization'
import type { ConversationItem, FalconDeckPreferences, ToolLifecycle } from './types'

function tool(
  lifecycle: ToolLifecycle,
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>> = {},
): Extract<ConversationItem, { kind: 'tool_call' }> {
  return {
    kind: 'tool_call',
    id: `tool-${lifecycle}`,
    title: 'Run checks',
    tool_kind: 'commandExecution',
    status: 'provider_specific',
    output: 'Partial output',
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle,
      artifact_kind: 'command_output',
      activity_kind: 'command',
      history_mode: 'summary',
      summary_hint: 'Run checks',
    },
    detail: null,
    created_at: '2026-08-09T12:00:00Z',
    completed_at: '2026-08-09T12:00:01Z',
    ...overrides,
  }
}

function preferences(autoExpandErrors: boolean): FalconDeckPreferences {
  const defaults = normalizePreferences(null)
  return {
    ...defaults,
    conversation: {
      ...defaults.conversation,
      group_read_only_tools: true,
      tool_details_mode: 'hide_read_only_details',
      auto_expand: {
        ...defaults.conversation.auto_expand,
        errors: autoExpandErrors,
      },
    },
  }
}

describe('abnormal tool presentation', () => {
  it.each(['failed', 'denied', 'interrupted'] as const)(
    'keeps %s partial output as a first-class card while auto-expand is on',
    (lifecycle) => {
      const presentation = deriveConversationPresentation(
        [tool(lifecycle)],
        preferences(true),
      )

      expect(presentation.history_blocks).toHaveLength(1)
      expect(presentation.history_blocks[0]).toMatchObject({
        kind: 'item',
        default_open: true,
        suppress_read_only_detail: false,
      })
    },
  )

  // Turning error auto-expand off used to leave the card collapsed but still
  // standing on its own with its detail rendered — the failure kept escaping
  // every fold the mode asked for. Most failed calls are noise the agent
  // recovered from, so they now fold like any other read-only tool.
  it.each(['failed', 'denied', 'interrupted'] as const)(
    'folds a read-only %s tool back into the summary when auto-expand is off',
    (lifecycle) => {
      const presentation = deriveConversationPresentation(
        [tool(lifecycle)],
        preferences(false),
      )

      expect(presentation.history_blocks).toHaveLength(1)
      expect(presentation.history_blocks[0]).toMatchObject({
        kind: 'tool_summary',
        default_open: false,
        suppress_read_only_detail: true,
      })
    },
  )

  // Collapsed mode buries failures no matter how the error auto-expand
  // preference is set: that toggle only governs the summarizing modes.
  it.each([true, false])(
    'buries a failed tool inside the work session in collapsed mode (auto-expand %s)',
    (autoExpandErrors) => {
      const prefs = preferences(autoExpandErrors)
      prefs.conversation.tool_details_mode = 'collapsed'

      const presentation = deriveConversationPresentation(
        [tool('succeeded', { id: 'ok' }), tool('failed', { id: 'boom' })],
        prefs,
      )

      expect(presentation.history_blocks).toHaveLength(1)
      expect(presentation.history_blocks[0]).toMatchObject({
        kind: 'work_session',
        id: 'tool_call:ok',
      })
    },
  )

  it('keeps a failed tool with side effects visible even when auto-expand is off', () => {
    const presentation = deriveConversationPresentation(
      [
        tool('failed', {
          display: {
            ...tool('failed').display,
            is_read_only: false,
            has_side_effect: true,
            history_mode: 'full',
          },
        }),
      ],
      preferences(false),
    )

    expect(presentation.history_blocks[0]).toMatchObject({
      kind: 'item',
      default_open: false,
      suppress_read_only_detail: false,
    })
  })

  it('uses a non-zero exit code as authoritative failure evidence', () => {
    const presentation = deriveConversationPresentation(
      [tool('succeeded', { exit_code: 2 })],
      preferences(true),
    )

    expect(presentation.history_blocks[0]).toMatchObject({
      kind: 'item',
      default_open: true,
      suppress_read_only_detail: false,
    })
  })

  it('keeps the canonical block identity when a running tool is interrupted', () => {
    const collapsed = normalizePreferences(null)
    collapsed.conversation.tool_details_mode = 'collapsed'
    const active = deriveConversationPresentation(
      [tool('running', { id: 'stable-tool', completed_at: null })],
      collapsed,
    )
    const interrupted = deriveConversationPresentation(
      [tool('interrupted', { id: 'stable-tool' })],
      collapsed,
    )

    expect(active.history_blocks[0]).toMatchObject({
      kind: 'work_session',
      id: 'tool_call:stable-tool',
    })
    // Settlement keeps the same block kind and id, so the card never remounts.
    expect(interrupted.history_blocks[0]).toMatchObject({
      kind: 'work_session',
      id: 'tool_call:stable-tool',
    })
  })
})
