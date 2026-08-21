import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ComposerSuggestionOffer } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '../../test/render'
import { ComposerSuggestionPill } from './ComposerSuggestionPill'
import { ComposerSuggestionSheet } from './ComposerSuggestionSheet'

afterEach(cleanup)

const SHIP = {
  id: 'ship',
  label: 'Ship it',
  description: 'Open a pull request',
  prompt: 'Open a pull request for this change.',
}
const TEST = { id: 'test', label: 'Run the tests', prompt: 'Run the suite.' }

const offer: ComposerSuggestionOffer = {
  extensionId: 'falcondeck.follow-up-suggestions',
  primary: SHIP,
  actions: [SHIP, TEST],
  key: 'falcondeck.follow-up-suggestions:1:ship,test',
}

function pressButton(renderer: ReturnType<typeof renderComponent>, label: string) {
  const button = renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => node.props.accessibilityLabel === label)
  if (!button) throw new Error(`no button labelled "${label}"`)
  button.props.onPress()
}

describe('ComposerSuggestionPill', () => {
  it('renders nothing without an offer', () => {
    const renderer = renderComponent(
      <ComposerSuggestionPill
        offer={null}
        onSubmit={vi.fn()}
        onShowAlternatives={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(renderer.toJSON()).toBeNull()
  })

  it('submits the primary action and keeps the pill to one row', () => {
    const onSubmit = vi.fn()
    const renderer = renderComponent(
      <ComposerSuggestionPill
        offer={offer}
        onSubmit={onSubmit}
        onShowAlternatives={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(textOf(renderer)).toContain('Ship it')
    expect(textOf(renderer)).not.toContain('Run the tests')
    pressButton(renderer, 'Suggested next step: Ship it')
    expect(onSubmit).toHaveBeenCalledWith(SHIP)
  })

  it('offers the alternatives and the dismissal separately', () => {
    const onShowAlternatives = vi.fn()
    const onDismiss = vi.fn()
    const renderer = renderComponent(
      <ComposerSuggestionPill
        offer={offer}
        onSubmit={vi.fn()}
        onShowAlternatives={onShowAlternatives}
        onDismiss={onDismiss}
      />,
    )

    pressButton(renderer, 'Show 1 more suggestion')
    expect(onShowAlternatives).toHaveBeenCalledOnce()
    pressButton(renderer, 'Dismiss suggestions')
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('hides the alternatives control when there is only one action', () => {
    const renderer = renderComponent(
      <ComposerSuggestionPill
        offer={{ ...offer, actions: [SHIP] }}
        onSubmit={vi.fn()}
        onShowAlternatives={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(() => pressButton(renderer, 'Show 0 more suggestions')).toThrow()
  })
})

describe('ComposerSuggestionSheet', () => {
  it('lists every action with its description', () => {
    const renderer = renderComponent(
      <ComposerSuggestionSheet offer={offer} onSubmit={vi.fn()} onClose={vi.fn()} />,
    )

    const text = textOf(renderer)
    expect(text).toContain('Suggested next steps')
    expect(text).toContain('Ship it')
    expect(text).toContain('Open a pull request')
    expect(text).toContain('Run the tests')
  })

  it('closes before submitting so the sheet never outlives its offer', () => {
    const order: string[] = []
    const renderer = renderComponent(
      <ComposerSuggestionSheet
        offer={offer}
        onSubmit={() => order.push('submit')}
        onClose={() => order.push('close')}
      />,
    )

    pressButton(renderer, 'Run the tests')
    expect(order).toEqual(['close', 'submit'])
  })
})
