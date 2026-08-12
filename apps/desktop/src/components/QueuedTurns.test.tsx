import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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

  it('shows an attachment thumbnail when a preview URL is available', () => {
    render(
      <QueuedTurns
        queuedTurns={[{ ...queuedTurns[0]!, attachment_count: 1 }]}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        getAttachmentPreviewUrl={(id) => `http://daemon.test/${id}.png`}
      />,
    )

    expect(document.querySelector('img')).toHaveAttribute(
      'src',
      'http://daemon.test/queued-1.png',
    )
  })

  it('reorders queued rows with drag and drop', () => {
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
    const first = document.querySelector('[data-queued-turn-id="queued-1"]')!
    const second = document.querySelector('[data-queued-turn-id="queued-2"]')!
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    fireEvent.dragStart(first, { dataTransfer })
    fireEvent.dragOver(second, { dataTransfer, clientY: 1 })
    fireEvent.drop(second, { dataTransfer, clientY: 1 })
    fireEvent.dragEnd(first, { dataTransfer })

    expect(onReorder).toHaveBeenCalledWith(['queued-2', 'queued-1'])
  })

  it('cancels a queued reorder when the drag ends outside the list', () => {
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
    const first = document.querySelector('[data-queued-turn-id="queued-1"]')!
    const second = document.querySelector('[data-queued-turn-id="queued-2"]')!
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    fireEvent.dragStart(first, { dataTransfer })
    fireEvent.dragOver(second, { dataTransfer })
    fireEvent.dragEnd(first, { dataTransfer })

    expect(onReorder).not.toHaveBeenCalled()
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
