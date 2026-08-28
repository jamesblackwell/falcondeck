import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const initialize = vi.fn()
const mermaidRender = vi.fn(async () => ({
  svg: '<svg data-testid="mermaid-svg"><text>diagram</text></svg>',
}))

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: mermaidRender,
  },
}))

import { MermaidBlock } from './mermaid-block'

const SOURCE = 'flowchart TD\n  home --> studio'

describe('MermaidBlock', () => {
  beforeEach(() => {
    initialize.mockClear()
    mermaidRender.mockClear()
    mermaidRender.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><text>diagram</text></svg>',
    })
  })

  it('renders a mermaid diagram instead of a code listing', async () => {
    render(<MermaidBlock code={SOURCE} />)

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
    expect(screen.getByText('mermaid')).toBeInTheDocument()
  })

  it('lets the user toggle back to the source', async () => {
    render(<MermaidBlock code={SOURCE} />)
    await screen.findByRole('img', { name: 'Mermaid diagram' })

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByText(/home --> studio/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Diagram' }))
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
  })

  it('falls back to the source when mermaid rejects the diagram', async () => {
    mermaidRender.mockRejectedValueOnce(new Error('Parse error'))
    render(<MermaidBlock code={'not a diagram'} />)

    expect(await screen.findByRole('status')).toHaveTextContent('Could not render')
    expect(screen.getByText('not a diagram')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull()
  })

  it('uses a generic error when mermaid rejects with a non-error', async () => {
    mermaidRender.mockRejectedValueOnce('offline')
    render(<MermaidBlock code={'flowchart TD\n  A-->B'} />)

    expect(await screen.findByRole('status')).toHaveTextContent('Could not render')
  })

  it('keeps an empty fence as source without calling mermaid', async () => {
    render(<MermaidBlock code={'  \n'} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    })
    expect(mermaidRender).not.toHaveBeenCalled()
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull()
  })

  it('hides the render error while the enclosing message is still pending', async () => {
    mermaidRender.mockRejectedValueOnce(new Error('Parse error'))
    render(<MermaidBlock code={'flowchart TD\n  A-->'} pending />)

    expect(await screen.findByText(/A-->/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
