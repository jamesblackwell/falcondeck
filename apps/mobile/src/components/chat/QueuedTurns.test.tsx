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

function findButton(renderer: ReturnType<typeof renderComponent>, label: string) {
  const button = renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => node.props.accessibilityLabel === label)
  if (!button) throw new Error(`no button labelled "${label}"`)
  return button
}

function pressButton(renderer: ReturnType<typeof renderComponent>, label: string) {
  findButton(renderer, label).props.onPress()
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
  it('offers edit, steer and remove', () => {
    expect(queuedTurnActions(true).map((item) => item.value)).toEqual(['edit', 'steer', 'remove'])
  })

  it('disables steering with a reason rather than hiding it', () => {
    const steer = queuedTurnActions(false)[1]!
    expect(steer.disabled).toBe(true)
    expect(steer.disabledReason).toBe(STEER_UNAVAILABLE_REASON)
    // Remove stays available — the daemon never refuses it.
    expect(queuedTurnActions(false)[2]!.disabled).toBeUndefined()
  })
})

describe('QueuedTurns', () => {
  it('renders nothing when the queue is empty', () => {
    const r = renderComponent(
      <QueuedTurns queuedTurns={[]} canSteer onRemove={noop} onSteer={noop} onEdit={noop} />,
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
        onEdit={noop}
      />,
    )
    expect(chipsOf(r)).toHaveLength(2)
    expect(textOf(r)).toContain('Also update the changelog')
    expect(textOf(r)).toContain('Then run the tests')
  })

  it('shows the attachment count only when there are attachments', () => {
    const without = renderComponent(
      <QueuedTurns queuedTurns={[queued()]} canSteer onRemove={noop} onSteer={noop} onEdit={noop} />,
    )
    expect(textOf(without)).not.toContain('2')

    const with2 = renderComponent(
      <QueuedTurns
        queuedTurns={[queued({ attachment_count: 2 })]}
        canSteer
        onRemove={noop}
        onSteer={noop}
        onEdit={noop}
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
        onEdit={noop}
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
      <QueuedTurns queuedTurns={[queued()]} canSteer onRemove={onRemove} onSteer={noop} onEdit={noop} />,
    )

    act(() => {
      chipsOf(r)[0]!.props.onPress()
    })
    await act(async () => {
      pressSheetAction(r, 'Remove')
    })

    expect(onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('prompts with the full text and saves the edited message', async () => {
    const { Alert } = await import('react-native')
    const prompt = vi.spyOn(Alert, 'prompt')
    const onEdit = vi.fn(async () => {})
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued({ text: 'Also update the changelog and the docs' })]}
        canSteer
        onRemove={noop}
        onSteer={noop}
        onEdit={onEdit}
      />,
    )

    act(() => {
      chipsOf(r)[0]!.props.onPress()
    })
    await act(async () => {
      pressSheetAction(r, 'Edit message')
    })

    // Prefilled with the untruncated text, not the preview.
    expect(prompt).toHaveBeenCalled()
    const [, , buttons, type, defaultValue] = prompt.mock.calls[0]! as unknown as [
      string,
      string | undefined,
      { text: string; onPress?: (text?: string) => void }[],
      string,
      string,
    ]
    expect(type).toBe('plain-text')
    expect(defaultValue).toBe('Also update the changelog and the docs')

    await act(async () => {
      buttons.find((button) => button.text === 'Save')!.onPress!('  Ship it instead  ')
    })
    expect(onEdit).toHaveBeenCalledWith('queued-1', 'Ship it instead')

    // A blank edit is dropped rather than sent.
    await act(async () => {
      buttons.find((button) => button.text === 'Save')!.onPress!('   ')
    })
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('steers and removes straight from the row buttons', async () => {
    const onSteer = vi.fn(async () => {})
    const onRemove = vi.fn(async () => {})
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued(), queued({ id: 'queued-2' })]}
        canSteer
        onRemove={onRemove}
        onSteer={onSteer}
        onEdit={noop}
      />,
    )

    await act(async () => {
      pressButton(r, 'Steer queued message: Also update the changelog')
    })
    expect(onSteer).toHaveBeenCalledWith('queued-1')

    await act(async () => {
      pressButton(r, 'Remove queued message: Also update the changelog')
    })
    expect(onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('disables the row steer button rather than hiding it', () => {
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued()]}
        canSteer={false}
        onRemove={noop}
        onSteer={noop}
        onEdit={noop}
      />,
    )

    const steer = findButton(r, 'Steer queued message: Also update the changelog')
    expect(steer.props.disabled).toBe(true)
    expect(steer.props.accessibilityHint).toBe(STEER_UNAVAILABLE_REASON)
  })

  it('shows the attachment thumbnail once the daemon returns one', async () => {
    const getAttachmentPreview = vi.fn(async () => 'data:image/png;base64,AAAA')
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued({ attachment_count: 1 })]}
        canSteer
        onRemove={noop}
        onSteer={noop}
        onEdit={noop}
        getAttachmentPreview={getAttachmentPreview}
      />,
    )
    await act(async () => {})

    expect(getAttachmentPreview).toHaveBeenCalledWith('queued-1')
    const image = r.root.findAllByType('ExpoImage' as never)[0]
    expect(image?.props.source).toEqual({ uri: 'data:image/png;base64,AAAA' })
  })

  it('renders no thumbnail when the message has no attachment', async () => {
    const getAttachmentPreview = vi.fn(async () => 'data:image/png;base64,AAAA')
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued()]}
        canSteer
        onRemove={noop}
        onSteer={noop}
        onEdit={noop}
        getAttachmentPreview={getAttachmentPreview}
      />,
    )
    await act(async () => {})

    expect(getAttachmentPreview).not.toHaveBeenCalled()
    expect(r.root.findAllByType('ExpoImage' as never)).toHaveLength(0)
  })

  it('keeps the row image-free when the preview cannot be loaded', async () => {
    const r = renderComponent(
      <QueuedTurns
        queuedTurns={[queued({ attachment_count: 1 })]}
        canSteer
        onRemove={noop}
        onSteer={noop}
        onEdit={noop}
        getAttachmentPreview={async () => {
          throw new Error('preview unavailable')
        }}
      />,
    )
    await act(async () => {})

    expect(r.root.findAllByType('ExpoImage' as never)).toHaveLength(0)
    expect(textOf(r)).toContain('Also update the changelog')
  })

  it('keeps the chip after a failed action instead of dropping it', async () => {
    const onSteer = vi.fn(async () => {
      throw new Error('the running turn ended before the message could be steered')
    })
    const r = renderComponent(
      <QueuedTurns queuedTurns={[queued()]} canSteer onRemove={noop} onSteer={onSteer} onEdit={noop} />,
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
