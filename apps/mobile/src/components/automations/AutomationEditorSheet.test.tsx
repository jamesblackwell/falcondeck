import React from 'react'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { renderComponent } from '@/test/render'

import { AutomationEditorSheet } from './AutomationEditorSheet'

describe('AutomationEditorSheet', () => {
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
