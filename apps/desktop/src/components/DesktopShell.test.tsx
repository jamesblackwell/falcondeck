import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DesktopShell } from './DesktopShell'

function renderShell(props: { sidebarVisible: boolean; railVisible: boolean }) {
  return render(
    <DesktopShell
      sidebar={<div>sidebar content</div>}
      main={<div>main content</div>}
      rail={<div>rail content</div>}
      {...props}
    />,
  )
}

describe('DesktopShell panel collapse', () => {
  it('keeps the sidebar mounted while collapsed so the width can animate', () => {
    const { rerender } = renderShell({ sidebarVisible: true, railVisible: false })
    const sidebar = screen.getByText('sidebar content')
    expect(sidebar.closest('[inert]')).toBeNull()

    rerender(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        rail={<div>rail content</div>}
        sidebarVisible={false}
        railVisible={false}
      />,
    )

    // Still in the tree (the panel animates to zero width) but inert.
    expect(screen.getByText('sidebar content')).toBeInTheDocument()
    expect(screen.getByText('sidebar content').closest('[inert]')).not.toBeNull()

    rerender(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        rail={<div>rail content</div>}
        sidebarVisible
        railVisible={false}
      />,
    )
    expect(screen.getByText('sidebar content').closest('[inert]')).toBeNull()
  })

  it('collapses through flex-grow, the property the shell transitions', () => {
    const { container, rerender } = renderShell({ sidebarVisible: true, railVisible: false })
    const panel = container.querySelector<HTMLElement>('[data-panel]#sidebar')
    expect(panel).not.toBeNull()
    expect(Number(panel!.style.flexGrow)).toBeGreaterThan(0)

    rerender(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        rail={<div>rail content</div>}
        sidebarVisible={false}
        railVisible={false}
      />,
    )
    expect(Number(panel!.style.flexGrow)).toBe(0)
  })

  it('arms the shell transition only around a toggle', async () => {
    const { container, rerender } = renderShell({ sidebarVisible: true, railVisible: false })
    const shell = container.querySelector('[data-fd-shell]')
    expect(shell?.hasAttribute('data-animating')).toBe(false)

    rerender(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        rail={<div>rail content</div>}
        sidebarVisible={false}
        railVisible={false}
      />,
    )
    expect(shell?.hasAttribute('data-animating')).toBe(true)
    await waitFor(() => expect(shell?.hasAttribute('data-animating')).toBe(false))
  })

  it('tears the rail contents down once its close animation finishes', async () => {
    const { rerender } = renderShell({ sidebarVisible: true, railVisible: true })
    expect(screen.getByText('rail content')).toBeInTheDocument()

    rerender(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        rail={<div>rail content</div>}
        sidebarVisible
        railVisible={false}
      />,
    )
    await waitFor(() => expect(screen.queryByText('rail content')).not.toBeInTheDocument())
  })
})
