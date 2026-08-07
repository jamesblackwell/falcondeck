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
  it('offers Steer instead and Remove behind the overflow menu', () => {
    const onSteer = vi.fn()
    const onRemove = vi.fn()
    render(
      <QueuedTurns queuedTurns={queuedTurns} canSteer onSteer={onSteer} onRemove={onRemove} />,
    )

    expect(screen.queryByRole('menu')).toBeNull()
    openMenu()

    const steer = screen.getByRole('menuitem', { name: 'Steer instead' })
    expect(steer).not.toBeDisabled()
    fireEvent.click(steer)
    expect(onSteer).toHaveBeenCalledWith('queued-1')
    expect(onRemove).not.toHaveBeenCalled()
    // Acting on an item closes the menu.
    expect(screen.queryByRole('menu')).toBeNull()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
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
    openMenu()

    // Disabled rather than hidden, so the capability gap is legible.
    const steer = screen.getByRole('menuitem', { name: 'Steer instead' })
    expect(steer).toBeDisabled()
    expect(steer).toHaveAttribute('title', 'This agent cannot take a message mid-turn.')
    fireEvent.click(steer)
    expect(onSteer).not.toHaveBeenCalled()

    // Remove still works without steering support.
    expect(screen.getByRole('menuitem', { name: 'Remove' })).not.toBeDisabled()
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
