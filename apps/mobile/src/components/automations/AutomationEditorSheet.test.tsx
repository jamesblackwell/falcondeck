import React from 'react'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { renderComponent } from '@/test/render'

import { AutomationEditorSheet } from './AutomationEditorSheet'

describe('AutomationEditorSheet', () => {
  it('selects a stored grok provider instead of falling back to Codex', () => {
    const renderer = renderComponent(
      <AutomationEditorSheet
        target={{
          kind: 'edit',
          automation: {
            id: 'automation-1',
            revision: 4,
            name: 'Native Support Ticket Sweep',
            trigger: { kind: 'cron', expression: '0 8-17 * * 1-5', timezone: 'UTC' },
            task: { kind: 'prompt', instruction: 'Sweep.' },
            target: {
              workspace_path: '/tmp/project',
              provider: 'grok',
              thread: { kind: 'managed', thread_id: 'grok-thread-abc' },
            },
            state: 'enabled',
            concurrency_policy: 'skip',
            misfire_policy: 'skip',
            elevated: false,
            required_connectors: [],
            created_at: '2026-08-20T08:00:00Z',
            updated_at: '2026-08-20T08:00:00Z',
          },
        }}
        settings={null}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Provider', accessibilityRole: 'radiogroup' }),
    ).toBeTruthy()
    const grok = renderer.root.findByProps({ label: 'Grok', accessibilityRole: 'radio' })
    expect(grok.props.accessibilityState).toEqual({ checked: true })
    expect(renderer.root.findByProps({ label: 'Codex', accessibilityRole: 'radio' }).props.accessibilityState)
      .toEqual({ checked: false })
  })

  it('coalesces repeated create taps while the first submission is pending', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    const onSubmit = vi.fn(() => pending)
    const renderer = renderComponent(
      <AutomationEditorSheet
        target={{ kind: 'create', workspacePath: '/tmp/project' }}
        settings={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Name' }).props.onChangeText('Daily review')
      renderer.root.findByProps({ accessibilityLabel: 'Instruction' }).props.onChangeText('Review the project')
    })
    const submit = renderer.root.findByProps({ label: 'Create automation' })

    act(() => {
      submit.props.onPress()
      submit.props.onPress()
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve()
      await pending
    })
  })
})
