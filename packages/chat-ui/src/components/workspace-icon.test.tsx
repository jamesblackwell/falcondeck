import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WorkspaceIcon } from './workspace-icon'

describe('WorkspaceIcon', () => {
  it('renders a favicon image when src is set', () => {
    const { container } = render(
      <WorkspaceIcon src="http://127.0.0.1:4123/api/workspace-icons/w1" />,
    )
    const image = container.querySelector('img')
    expect(image).toHaveAttribute(
      'src',
      'http://127.0.0.1:4123/api/workspace-icons/w1',
    )
  })

  it('falls back to the folder glyph when the image fails', () => {
    const { container } = render(
      <WorkspaceIcon src="http://127.0.0.1:4123/api/workspace-icons/w1" />,
    )
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the folder glyph when there is no src', () => {
    const { container } = render(<WorkspaceIcon />)
    expect(container.querySelector('img')).toBeNull()
  })
})
