import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { QueuedTurns } from '@falcondeck/chat-ui'

const queuedTurns = [
  {
    id: 'queued-1',
    preview: 'also update the changelog',
    attachment_count: 0,
    queued_at: new Date().toISOString(),
  },
]

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Actions for queued message/ }))
}

function queuedRowIds() {
  return [...document.querySelectorAll('[data-queued-turn-id]')].map((node) =>
    node.getAttribute('data-queued-turn-id'),
  )
}

function queuedRow(id: string) {
  const row = document.querySelector(`[data-queued-turn-id="${id}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`Missing queued row ${id}`)
  return row
}

function mockQueuedRow(id: string, top: number, height = 40) {
  const row = queuedRow(id)
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top,
      toJSON() {},
    }),
  })
  Object.defineProperty(row, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(row, 'hasPointerCapture', {
    configurable: true,
    value: vi.fn(() => true),
  })
  Object.defineProperty(row, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  return row
}

function dragQueuedRow(id: string, clientY: number) {
  const row = queuedRow(id)
  fireEvent.pointerDown(row, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 12,
    clientY: 10,
  })
  fireEvent.pointerMove(row, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 12,
    clientY,
  })
  return row
}

describe('QueuedTurns', () => {
  it('offers Steer and Remove directly on each queued row', () => {
    const onSteer = vi.fn()
    const onRemove = vi.fn()
    render(
      <QueuedTurns queuedTurns={queuedTurns} canSteer onSteer={onSteer} onRemove={onRemove} />,
    )

    const steer = screen.getByRole('button', { name: 'Steer' })
    expect(steer).not.toBeDisabled()
    fireEvent.click(steer)
    expect(onSteer).toHaveBeenCalledWith('queued-1')
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Remove queued message/ }))
    expect(onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('disables Steer instead with a reason when the provider cannot steer', () => {
    const onSteer = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={queuedTurns}
        canSteer={false}
        onSteer={onSteer}
        onRemove={vi.fn()}
      />,
    )
    // Disabled rather than hidden, so the capability gap is legible.
    const steer = screen.getByRole('button', { name: 'Steer' })
    expect(steer).toBeDisabled()
    expect(steer).toHaveAttribute('title', 'This agent cannot take a message mid-turn.')
    fireEvent.click(steer)
    expect(onSteer).not.toHaveBeenCalled()

    // Remove still works without steering support.
    expect(screen.getByRole('button', { name: /Remove queued message/ })).not.toBeDisabled()
  })

  it('shows an attachment thumbnail when a preview URL is available', async () => {
    render(
      <QueuedTurns
        queuedTurns={[{ ...queuedTurns[0]!, attachment_count: 1 }]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        getAttachmentPreviewUrl={(id) => `http://daemon.test/${id}.png`}
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('img')).toHaveAttribute(
        'src',
        'http://daemon.test/queued-1.png',
      ),
    )
  })

  it('shows an attachment thumbnail when the preview loader is async', async () => {
    render(
      <QueuedTurns
        queuedTurns={[{ ...queuedTurns[0]!, attachment_count: 1 }]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        getAttachmentPreviewUrl={(id) => Promise.resolve(`data:image/png;base64,${id}`)}
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/png;base64,queued-1',
      ),
    )
  })

  it('reorders queued rows by dragging past the next row', () => {
    const onReorder = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
          { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    mockQueuedRow('queued-3', 80)

    const first = dragQueuedRow('queued-1', 70)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1', 'queued-3'])
    expect(first).toHaveAttribute('aria-grabbed', 'true')

    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })
    expect(onReorder).toHaveBeenCalledWith(['queued-2', 'queued-1', 'queued-3'])
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1', 'queued-3'])
  })

  it('does not reorder a queued row until the pointer actually moves', () => {
    const onReorder = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    const first = dragQueuedRow('queued-1', 12)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).not.toHaveBeenCalled()
    expect(queuedRowIds()).toEqual(['queued-1', 'queued-2'])
  })

  it('cancels a queued reorder with Escape', () => {
    const onReorder = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    const first = dragQueuedRow('queued-1', 70)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).not.toHaveBeenCalled()
    expect(queuedRowIds()).toEqual(['queued-1', 'queued-2'])
  })

  it('puts the queue back when a reorder is rejected', async () => {
    const onReorder = vi.fn(() => Promise.reject(new Error('failed')))
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    const first = dragQueuedRow('queued-1', 70)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).toHaveBeenCalledWith(['queued-2', 'queued-1'])
    await waitFor(() => expect(queuedRowIds()).toEqual(['queued-1', 'queued-2']))
  })

  it('does not save a reorder when the pointer gesture is cancelled', () => {
    const onReorder = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    const first = dragQueuedRow('queued-1', 70)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])

    fireEvent.pointerCancel(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).not.toHaveBeenCalled()
    expect(queuedRowIds()).toEqual(['queued-1', 'queued-2'])
  })

  it('restores the order from before this drag when Escape is pressed', () => {
    const onReorder = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    const first = dragQueuedRow('queued-1', 70)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])

    mockQueuedRow('queued-2', 0)
    mockQueuedRow('queued-1', 40)
    dragQueuedRow('queued-2', 70)
    expect(queuedRowIds()).toEqual(['queued-1', 'queued-2'])
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])
  })

  it('keeps a newer drop when an older reorder fails', async () => {
    let rejectFirst: (error: Error) => void = () => {}
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject
    })
    const onReorder = vi.fn()
    onReorder.mockImplementationOnce(() => firstSave)
    onReorder.mockImplementationOnce(() => Promise.resolve())
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
          { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    mockQueuedRow('queued-3', 80)
    const first = dragQueuedRow('queued-1', 70)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1', 'queued-3'])

    mockQueuedRow('queued-2', 0)
    mockQueuedRow('queued-1', 40)
    mockQueuedRow('queued-3', 80)
    const middle = dragQueuedRow('queued-1', 110)
    fireEvent.pointerUp(middle, { pointerId: 1, isPrimary: true, button: 0 })
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-3', 'queued-1'])

    rejectFirst(new Error('failed'))
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(2))
    expect(onReorder).toHaveBeenLastCalledWith(['queued-2', 'queued-3', 'queued-1'])
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-3', 'queued-1'])
  })

  it('includes a message that arrives before the drop is saved', () => {
    const onReorder = vi.fn()
    const turns = [
      queuedTurns[0]!,
      { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
      { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
    ]
    const { rerender } = render(
      <QueuedTurns
        queuedTurns={turns}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    mockQueuedRow('queued-3', 80)
    const first = dragQueuedRow('queued-1', 70)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1', 'queued-3'])

    rerender(
      <QueuedTurns
        queuedTurns={[...turns, { ...queuedTurns[0]!, id: 'queued-4', preview: 'fourth message' }]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).toHaveBeenCalledWith([
      'queued-2',
      'queued-1',
      'queued-3',
      'queued-4',
    ])
  })

  it('omits a message that leaves before the drop is saved', () => {
    const onReorder = vi.fn()
    const { rerender } = render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
          { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    mockQueuedRow('queued-3', 80)
    const first = dragQueuedRow('queued-1', 70)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1', 'queued-3'])

    rerender(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).toHaveBeenCalledWith(['queued-2', 'queued-1'])
  })

  it('drops a rejected order when that drag is cancelled', async () => {
    let rejectSave: (error: Error) => void = () => {}
    const save = new Promise<void>((_resolve, reject) => {
      rejectSave = reject
    })
    const onReorder = vi.fn(() => save)
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    const first = dragQueuedRow('queued-1', 70)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])

    mockQueuedRow('queued-2', 0)
    mockQueuedRow('queued-1', 40)
    dragQueuedRow('queued-2', 14)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])

    await act(async () => {
      rejectSave(new Error('failed'))
    })
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-1'])
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(queuedRowIds()).toEqual(['queued-1', 'queued-2'])
  })

  it('restores the previous order when the dragged row leaves', () => {
    const onReorder = vi.fn(() => new Promise<void>(() => {}))
    const { rerender } = render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
          { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    mockQueuedRow('queued-3', 80)
    const first = dragQueuedRow('queued-1', 110)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-3', 'queued-1'])

    mockQueuedRow('queued-2', 0)
    mockQueuedRow('queued-3', 40)
    mockQueuedRow('queued-1', 80)
    dragQueuedRow('queued-2', 14)
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-3', 'queued-1'])

    rerender(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(queuedRowIds()).toEqual(['queued-3', 'queued-1'])
  })

  it('keeps a deferred reorder on the queue it started on', async () => {
    let resolveFirst: () => void = () => {}
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const onReorder = vi.fn()
    onReorder.mockImplementationOnce(() => firstSave)
    onReorder.mockImplementationOnce(() => Promise.resolve())
    const onLater = vi.fn()
    const turns = [
      queuedTurns[0]!,
      { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
      { ...queuedTurns[0]!, id: 'queued-3', preview: 'third message' },
    ]
    const { rerender } = render(
      <QueuedTurns
        queuedTurns={turns}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    mockQueuedRow('queued-3', 80)
    const first = dragQueuedRow('queued-1', 70)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })
    expect(onReorder).toHaveBeenCalledTimes(1)

    mockQueuedRow('queued-2', 0)
    mockQueuedRow('queued-1', 40)
    mockQueuedRow('queued-3', 80)
    const middle = dragQueuedRow('queued-1', 110)
    fireEvent.pointerUp(middle, { pointerId: 1, isPrimary: true, button: 0 })
    expect(queuedRowIds()).toEqual(['queued-2', 'queued-3', 'queued-1'])

    rerender(
      <QueuedTurns
        queuedTurns={[...turns, { ...queuedTurns[0]!, id: 'queued-4', preview: 'fourth message' }]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onLater}
      />,
    )
    resolveFirst()
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(2))

    expect(onReorder).toHaveBeenLastCalledWith([
      'queued-2',
      'queued-3',
      'queued-1',
      'queued-4',
    ])
    expect(onLater).not.toHaveBeenCalled()
  })

  it('reorders when the row cannot capture the pointer', () => {
    const onReorder = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    const first = mockQueuedRow('queued-1', 0)
    mockQueuedRow('queued-2', 40)
    Object.defineProperty(first, 'setPointerCapture', {
      configurable: true,
      value: () => {
        throw new Error('no capture')
      },
    })

    dragQueuedRow('queued-1', 70)
    fireEvent.pointerUp(first, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onReorder).toHaveBeenCalledWith(['queued-2', 'queued-1'])
  })

  it('does not start a reorder from the Steer button', () => {
    const onReorder = vi.fn()
    const onSteer = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          queuedTurns[0]!,
          { ...queuedTurns[0]!, id: 'queued-2', preview: 'second message' },
        ]}
        canSteer
        onSteer={onSteer}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    const steer = screen.getAllByRole('button', { name: 'Steer' })[0]!
    fireEvent.pointerDown(steer, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 12,
      clientY: 10,
    })
    fireEvent.pointerMove(steer, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 12,
      clientY: 80,
    })
    fireEvent.pointerUp(steer, { pointerId: 1, isPrimary: true, button: 0 })
    fireEvent.click(steer)

    expect(onReorder).not.toHaveBeenCalled()
    expect(onSteer).toHaveBeenCalledWith('queued-1')
  })

  it('hides Edit message unless an edit handler is wired up', () => {
    render(<QueuedTurns queuedTurns={queuedTurns} canSteer onSteer={vi.fn()} onRemove={vi.fn()} />)
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Edit message' })).toBeNull()
  })

  it('edits the full message text in place', () => {
    const onEdit = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={[
          {
            ...queuedTurns[0]!,
            preview: 'also update the changelog',
            text: 'also update the changelog and the release notes',
          },
        ]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onEdit={onEdit}
      />,
    )

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))

    // Seeded with the untruncated text, not the preview.
    const editor = screen.getByRole('textbox', { name: 'Edit queued message' })
    expect(editor).toHaveValue('also update the changelog and the release notes')

    fireEvent.change(editor, { target: { value: 'ship it instead' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onEdit).toHaveBeenCalledWith('queued-1', 'ship it instead')
    // Editor closes back into the chip after saving.
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull()
  })

  it('cancels an edit with Escape without saving', () => {
    const onEdit = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={queuedTurns}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onEdit={onEdit}
      />,
    )

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit queued message' })
    fireEvent.change(editor, { target: { value: 'discarded' } })
    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull()
  })

  it('does not save a queued edit while an IME candidate is being composed', () => {
    const onEdit = vi.fn()
    render(
      <QueuedTurns
        queuedTurns={queuedTurns}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onEdit={onEdit}
      />,
    )

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit queued message' })
    fireEvent.change(editor, { target: { value: '編集中' } })
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229, isComposing: true })

    expect(onEdit).not.toHaveBeenCalled()
    expect(editor).toBeInTheDocument()
  })

  // Outside-click dismissal is Radix's own concern and does not fire reliably
  // under jsdom; Escape covers that the menu is a real dismissable layer.
  it('closes the menu on Escape', () => {
    render(<QueuedTurns queuedTurns={queuedTurns} canSteer onSteer={vi.fn()} onRemove={vi.fn()} />)

    openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
