import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QueuedTurnSummary } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '../../test/render'
import { QueuedTurns, STEER_UNAVAILABLE_REASON, queuedTurnActions, queuedTurnLabel } from './QueuedTurns'

afterEach(cleanup)

function queued(overrides: Partial<QueuedTurnSummary> = {}): QueuedTurnSummary {
  return {
    id: 'queued-1',
    preview: 'Also update the changelog',
    queued_at: '2026-03-16T10:00:00Z',
    ...overrides,
  }
}

const noop = async () => {}

function chipsOf(renderer: ReturnType<typeof renderComponent>) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .filter((node) => String(node.props.accessibilityLabel ?? '').startsWith('Queued message:'))
}

/** Presses a row in the open sheet by the label the user reads. */
function pressSheetAction(renderer: ReturnType<typeof renderComponent>, label: string) {
  const row = renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => node.props.accessibilityLabel === label)
  if (!row) throw new Error(`no sheet action labelled "${label}"`)
  row.props.onPress()
}

describe('queuedTurnLabel', () => {
  it('uses the preview', () => {
    expect(queuedTurnLabel(queued())).toBe('Also update the changelog')
  })

  it('falls back when the daemon sent a blank preview', () => {
    expect(queuedTurnLabel(queued({ preview: '   ' }))).toBe('Queued message')
  })
})

describe('queuedTurnActions', () => {
  it('offers steer and remove', () => {
    expect(queuedTurnActions(true).map((item) => item.value)).toEqual(['steer', 'remove'])
  })

  it('disables steering with a reason rather than hiding it', () => {
    const steer = queuedTurnActions(false)[0]!
    expect(steer.disabled).toBe(true)
    expect(steer.disabledReason).toBe(STEER_UNAVAILABLE_REASON)
    // Remove stays available — the daemon never refuses it.
    expect(queuedTurnActions(false)[1]!.disabled).toBeUndefined()
  })
})

describe('QueuedTurns', () => {
  it('renders nothing when the queue is empty', () => {
    const r = renderComponent(
      <QueuedTurns queuedTurns={[]} canSteer onRemove={noop} onSteer={noop} />,
    )
    expect(r.toJSON()).toBeNull()
  })

  it('renders one chip per queued message in queue order', () => {
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued(), queued({ id: 'queued-2', preview: 'Then run the tests' })]}
        canSteer
        onRemove={noop}
        onSteer={noop}
      />,
    )
    expect(chipsOf(r)).toHaveLength(2)
    expect(textOf(r)).toContain('Also update the changelog')
    expect(textOf(r)).toContain('Then run the tests')
  })

  it('shows the attachment count only when there are attachments', () => {
    const without = renderComponent(
      <QueuedTurns queuedTurns={[queued()]} canSteer onRemove={noop} onSteer={noop} />,
    )
    expect(textOf(without)).not.toContain('2')

    const with2 = renderComponent(
      <QueuedTurns
        queuedTurns={[queued({ attachment_count: 2 })]}
        canSteer
        onRemove={noop}
        onSteer={noop}
      />,
    )
    expect(textOf(with2)).toContain('2')
  })

  it('steers the tapped message', async () => {
    const onSteer = vi.fn(async () => {})
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued(), queued({ id: 'queued-2' })]}
        canSteer
        onRemove={noop}
        onSteer={onSteer}
      />,
    )

    act(() => {
      chipsOf(r)[1]!.props.onPress()
    })
    await act(async () => {
      pressSheetAction(r, 'Steer instead')
    })

    expect(onSteer).toHaveBeenCalledWith('queued-2')
  })

  it('removes the tapped message', async () => {
    const onRemove = vi.fn(async () => {})
    const r = renderComponent(
      <QueuedTurns queuedTurns={[queued()]} canSteer onRemove={onRemove} onSteer={noop} />,
    )

    act(() => {
      chipsOf(r)[0]!.props.onPress()
    })
    await act(async () => {
      pressSheetAction(r, 'Remove')
    })

    expect(onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('keeps the chip after a failed action instead of dropping it', async () => {
    const onSteer = vi.fn(async () => {
      throw new Error('the running turn ended before the message could be steered')
    })
    const r = renderComponent(
      <QueuedTurns queuedTurns={[queued()]} canSteer onRemove={noop} onSteer={onSteer} />,
    )

    act(() => {
      chipsOf(r)[0]!.props.onPress()
    })
    await act(async () => {
      pressSheetAction(r, 'Steer instead')
    })

    const chips = chipsOf(r)
    expect(chips).toHaveLength(1)
    expect(chips[0]!.props.disabled).toBe(false)
  })
})
