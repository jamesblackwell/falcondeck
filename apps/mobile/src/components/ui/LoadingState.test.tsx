import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { LoadingState } from './LoadingState'

afterEach(cleanup)

describe('LoadingState', () => {
  it('names the wait for VoiceOver and on screen', () => {
    const renderer = renderComponent(<LoadingState label="Loading automations…" />)
    expect(textOf(renderer)).toContain('Loading automations…')
    const node = renderer.root.findByProps({ accessibilityRole: 'progressbar' })
    expect(node.props.accessibilityLabel).toBe('Loading automations…')
    expect(node.props.accessibilityLiveRegion).toBe('polite')
  })

  it('stays caption-free and silent when a banner already names the wait', () => {
    const renderer = renderComponent(<LoadingState fill />)
    expect(textOf(renderer)).toBe('')
    expect(renderer.root.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0)
  })
})
