import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent, textOf } from '../../test/render'
import { ErrorBanner } from './ErrorBanner'

afterEach(cleanup)

describe('ErrorBanner', () => {
  it('renders nothing when there is no error', () => {
    expect(renderComponent(<ErrorBanner message={null} onDismiss={vi.fn()} />).toJSON()).toBeNull()
  })

  it('shows the failure text', () => {
    const r = renderComponent(
      <ErrorBanner message="Failed to steer queued message" onDismiss={vi.fn()} />,
    )
    expect(textOf(r)).toContain('Failed to steer queued message')
  })

  it('dismisses on tap', () => {
    const onDismiss = vi.fn()
    const r = renderComponent(<ErrorBanner message="Approval action failed" onDismiss={onDismiss} />)

    act(() => {
      r.root.findByType('Pressable' as never).props.onPress()
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('labels the dismiss control for VoiceOver', () => {
    const r = renderComponent(<ErrorBanner message="Something broke" onDismiss={vi.fn()} />)
    expect(r.root.findByType('Pressable' as never).props.accessibilityLabel).toBe('Dismiss error')
  })
})
