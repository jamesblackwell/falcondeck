import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { NativeSheet } from './NativeSheet'

afterEach(cleanup)

function renderSheet() {
  const onClose = vi.fn()
  const renderer = renderComponent(
    <NativeSheet onClose={onClose} accessibilityLabel="Close options">
      <></>
    </NativeSheet>,
  )
  return { renderer, onClose }
}

describe('NativeSheet', () => {
  it('presents as a content-height bottom sheet, not a full-screen card', () => {
    const { renderer, onClose } = renderSheet()
    const modal = renderer.root.findByType('Modal' as never)

    // A transparent modal with bottom-anchored content sizes to the content;
    // the native iOS form sheet fills the screen regardless of content.
    expect(modal.props.transparent).toBe(true)
    expect(modal.props.presentationStyle).toBeUndefined()
    // The backdrop fades while the card itself rises from the bottom edge, so
    // the dimmed page never slides up with it.
    expect(modal.props.animationType).toBe('fade')

    modal.props.onRequestClose()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes from a tap on the backdrop', () => {
    const { renderer, onClose } = renderSheet()
    const backdrop = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => node.props.accessibilityLabel === 'Close options')

    expect(backdrop).toBeDefined()
    backdrop!.props.onPress()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers a close button so the escape hatch does not depend on a gesture', () => {
    const { renderer, onClose } = renderSheet()
    const buttons = renderer.root
      .findAllByType('Pressable' as never)
      .filter((node) => node.props.accessibilityLabel === 'Close options')

    // Backdrop plus an explicit button.
    expect(buttons).toHaveLength(2)
    buttons[1]!.props.onPress()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes from a decisive drag down on the grabber and springs back otherwise', () => {
    const { renderer, onClose } = renderSheet()
    const grabberZone = renderer.root
      .findAllByType('View' as never)
      .find((node) => typeof node.props.onPanResponderRelease === 'function')

    expect(grabberZone).toBeDefined()

    act(() => {
      grabberZone!.props.onPanResponderRelease(undefined, { dy: 20, vy: 0.1 })
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      grabberZone!.props.onPanResponderRelease(undefined, { dy: 120, vy: 0.2 })
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes only once when several dismissals race', () => {
    const { renderer, onClose } = renderSheet()
    const [backdrop, button] = renderer.root
      .findAllByType('Pressable' as never)
      .filter((node) => node.props.accessibilityLabel === 'Close options')

    backdrop!.props.onPress()
    button!.props.onPress()
    renderer.root.findByType('Modal' as never).props.onRequestClose()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('rises from below the screen once it knows its height', () => {
    const { renderer } = renderSheet()
    const frame = renderer.root
      .findAllByType('Animated.View' as never)
      .find((node) => typeof node.props.onLayout === 'function')
    expect(frame).toBeDefined()

    const offset = () =>
      [frame!.props.style]
        .flat(Infinity)
        .find((style) => style && Array.isArray(style.transform))?.transform[0].translateY

    // Before layout the card waits off screen, not at its resting place.
    expect(offset()).toBeGreaterThan(0)
    act(() => {
      frame!.props.onLayout({ nativeEvent: { layout: { height: 320 } } })
    })
  })
})
