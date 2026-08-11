import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ConversationItem, FalconDeckPreferences, ToolCallDisplay } from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import { Conversation } from '@falcondeck/chat-ui'

/** Expanded mode keeps every tool call at the top level, one card each. */
function expandedPreferences(): FalconDeckPreferences {
  const base = normalizePreferences(null)
  return { ...base, conversation: { ...base.conversation, tool_details_mode: 'expanded' } }
}

function toolCall(
  display: Partial<ToolCallDisplay>,
  overrides: Partial<Extract<ConversationItem, { kind: 'tool_call' }>> = {},
): ConversationItem {
  return {
    kind: 'tool_call',
    id: 'tool-1',
    title: 'Do the thing',
    tool_kind: 'other',
    status: 'completed',
    output: 'output text',
    exit_code: 0,
    display: {
      is_read_only: false,
      has_side_effect: false,
      is_error: false,
      artifact_kind: 'none',
      activity_kind: 'other',
      history_mode: 'full',
      summary_hint: null,
      ...display,
    },
    created_at: '2026-08-06T10:00:00Z',
    completed_at: '2026-08-06T10:00:01Z',
    ...overrides,
  }
}

function renderTool(item: ConversationItem) {
  return render(<Conversation items={[item]} preferences={expandedPreferences()} />)
}

function tier() {
  return screen.getByRole('button', { name: /^Toggle / }).closest('[data-tool-tier]')
}

describe('tool card tiers', () => {
  it('gives edits and terminal work a bordered card', () => {
    for (const activityKind of ['edit', 'diff', 'command', 'test'] as const) {
      const { unmount } = renderTool(toolCall({ activity_kind: activityKind }))
      expect(tier()).toHaveAttribute('data-tool-tier', 'card')
      unmount()
    }
  })

  it('leaves reads, searches, and fetches as quiet rows', () => {
    for (const activityKind of ['read', 'search', 'list', 'web_search', 'context'] as const) {
      const { unmount } = renderTool(toolCall({ activity_kind: activityKind }))
      expect(tier()).toHaveAttribute('data-tool-tier', 'row')
      unmount()
    }
  })

  it('forces a call awaiting confirmation open and disables its collapse', () => {
    renderTool(
      toolCall({ artifact_kind: 'approval_related', activity_kind: 'approval' }, {
        status: 'running',
      }),
    )

    const toggle = screen.getByRole('button', { name: /^Toggle / })
    expect(toggle.closest('[data-tool-tier]')).toHaveAttribute('data-tool-tier', 'confirm')
    // You cannot hide what you are being asked to approve.
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument()
  })

  it('stops treating an approval as pending once it has resolved', () => {
    renderTool(
      toolCall({ artifact_kind: 'approval_related', activity_kind: 'approval' }, {
        status: 'completed',
      }),
    )

    const toggle = screen.getByRole('button', { name: /^Toggle / })
    expect(toggle.closest('[data-tool-tier]')).not.toHaveAttribute('data-tool-tier', 'confirm')
    expect(toggle).toBeEnabled()
  })

  it('summarizes test counts without replacing authoritative output', () => {
    renderTool(toolCall({
      artifact_kind: 'test',
      activity_kind: 'test',
      lifecycle: 'failed',
      is_error: true,
      test_summary: {
        framework: 'vitest', total: 43, passed: 42, failed: 1, skipped: 0,
        suites_total: 5, suites_passed: 4, suites_failed: 1, duration_ms: 1_240,
      },
    }, {
      title: 'npm test', status: 'failed', exit_code: 1,
      output: 'FAIL src/markdown.test.tsx\nExpected safe link',
    }))

    expect(screen.getByRole('button', { name: 'Toggle npm test details, Failed, 1 failed' })).toBeVisible()
    expect(screen.getByRole('region', {
      name: 'Test results, Vitest, 42 passed, 1 failed, 0 skipped, 4 suites passed, 1 suite failed, 1.2 s',
    })).toBeVisible()
    expect(screen.getByText(/Expected safe link/)).toBeVisible()
  })
})
