import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { CommandPalette } from '@falcondeck/chat-ui'

describe('CommandPalette controlled requests', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('toggles for the command shortcut and remains open for explicit search requests', () => {
    const props = { groups: [], onSelectThread: vi.fn() }
    const { rerender } = render(
      <CommandPalette {...props} openRequestKey={1} requestMode="toggle" />,
    )
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()

    rerender(<CommandPalette {...props} openRequestKey={2} requestMode="toggle" />)
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()

    rerender(<CommandPalette {...props} openRequestKey={3} requestMode="open" />)
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    rerender(<CommandPalette {...props} openRequestKey={4} requestMode="open" />)
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()

    rerender(<CommandPalette {...props} openRequestKey={5} requestMode="close" />)
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })
})
