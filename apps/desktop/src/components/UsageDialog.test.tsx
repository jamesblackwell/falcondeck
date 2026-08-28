import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UsageDialog } from './UsageDialog'

describe('UsageDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <UsageDialog
        open={false}
        onClose={vi.fn()}
        baseUrl="http://127.0.0.1:4317"
        onToast={vi.fn()}
      />,
    )

    expect(screen.queryByRole('dialog', { name: /usage/i })).not.toBeInTheDocument()
  })

  it('renders accessible modal dialog with usage information when open', () => {
    render(
      <UsageDialog
        open={true}
        onClose={vi.fn()}
        baseUrl="http://127.0.0.1:4317"
        onToast={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: /usage/i })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: /usage/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close usage dialog/i })).toBeInTheDocument()
  })

  it('calls onClose when clicking close button', () => {
    const onClose = vi.fn()
    render(
      <UsageDialog
        open={true}
        onClose={onClose}
        baseUrl="http://127.0.0.1:4317"
        onToast={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /close usage dialog/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when pressing Escape key', () => {
    const onClose = vi.fn()
    render(
      <UsageDialog
        open={true}
        onClose={onClose}
        baseUrl="http://127.0.0.1:4317"
        onToast={vi.fn()}
      />,
    )

    fireEvent.keyDown(screen.getByRole('dialog', { name: /usage/i }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when clicking the backdrop outside the dialog', () => {
    const onClose = vi.fn()
    const { container } = render(
      <UsageDialog
        open={true}
        onClose={onClose}
        baseUrl="http://127.0.0.1:4317"
        onToast={vi.fn()}
      />,
    )

    const backdrop = container.querySelector('[role="presentation"]')
    expect(backdrop).toBeInTheDocument()
    if (backdrop) {
      fireEvent.click(backdrop)
      expect(onClose).toHaveBeenCalledOnce()
    }
  })
})
