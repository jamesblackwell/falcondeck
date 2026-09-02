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
  it('lets the main shell shrink when a bottom panel is present', () => {
    const { container } = render(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        bottom={<div>bottom content</div>}
      />,
    )

    const shell = container.querySelector('[data-fd-shell]')?.parentElement
    expect(shell).toHaveClass('h-full')
    expect(shell).not.toHaveClass('h-screen')
    expect(screen.getByText('bottom content')).toBeInTheDocument()
    expect(container.querySelector('[data-bottom-panel-resize]')).toHaveClass('bg-surface-0')
  })

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

  it('keeps the rail panel in the group when a takeover view supplies no rail', () => {
    const { container, rerender } = renderShell({ sidebarVisible: false, railVisible: true })
    expect(container.querySelector('[data-panel]#rail')).not.toBeNull()

    // A takeover view (settings, activity) drops the rail. If the panel left
    // the group, the group would re-normalise and pop the sidebar back open.
    rerender(
      <DesktopShell
        sidebar={<div>sidebar content</div>}
        main={<div>main content</div>}
        sidebarVisible={false}
        railVisible
      />,
    )
    expect(container.querySelector('[data-panel]#rail')).not.toBeNull()
    expect(screen.queryByText('rail content')).not.toBeInTheDocument()
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
