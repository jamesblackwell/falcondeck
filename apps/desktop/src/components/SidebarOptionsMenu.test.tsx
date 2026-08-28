import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getAppearance, updateAppearance } from '@falcondeck/ui'
import { SidebarOptionsMenu } from './SidebarOptionsMenu'
import { readDictationSettings, writeDictationSettings, DEFAULT_DICTATION_SETTINGS } from '../dictation'

describe('SidebarOptionsMenu', () => {
  beforeEach(() => {
    updateAppearance({ theme: 'system' })
  })

  it('renders Options trigger button in collapsed state', () => {
    render(<SidebarOptionsMenu onOpenSettings={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Options' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu', { name: 'Options menu' })).not.toBeInTheDocument()
  })

  it('opens menu on trigger click and shows available actions', () => {
    const onOpenSettings = vi.fn()
    const onOpenUsage = vi.fn()
    const onOpenKeyboardShortcuts = vi.fn()
    const onCheckForUpdates = vi.fn()

    render(
      <SidebarOptionsMenu
        onOpenSettings={onOpenSettings}
        onOpenUsage={onOpenUsage}
        onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
        onCheckForUpdates={onCheckForUpdates}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(screen.getByRole('menu', { name: 'Options menu' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Usage/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /App theme/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Keyboard shortcuts/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Check for updates…/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Settings/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Usage/ })).toHaveTextContent('⌘⇧U')
  })

  it('triggers onOpenUsage when clicking Usage', () => {
    const onOpenUsage = vi.fn()
    render(<SidebarOptionsMenu onOpenUsage={onOpenUsage} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Usage/ }))

    expect(onOpenUsage).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Options menu' })).not.toBeInTheDocument()
  })

  it('triggers onOpenKeyboardShortcuts when clicking Keyboard shortcuts', () => {
    const onOpenKeyboardShortcuts = vi.fn()
    render(<SidebarOptionsMenu onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Keyboard shortcuts/i }))

    expect(onOpenKeyboardShortcuts).toHaveBeenCalledOnce()
  })

  it('triggers onCheckForUpdates when clicking Check for updates', () => {
    const onCheckForUpdates = vi.fn()
    render(<SidebarOptionsMenu onCheckForUpdates={onCheckForUpdates} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Check for updates…/i }))

    expect(onCheckForUpdates).toHaveBeenCalledOnce()
  })

  it('triggers onOpenSettings when clicking Settings', () => {
    const onOpenSettings = vi.fn()
    render(<SidebarOptionsMenu onOpenSettings={onOpenSettings} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Settings/i }))

    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('toggles dictation from the quick settings submenu without closing it', () => {
    writeDictationSettings(DEFAULT_DICTATION_SETTINGS)
    render(<SidebarOptionsMenu onOpenSettings={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Dictation/i }))

    const toggle = screen.getByRole('menuitemcheckbox', { name: /System-wide dictation/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(toggle)
    expect(readDictationSettings().enabled).toBe(true)
    // Still open, because flipping one of these usually means flipping another.
    expect(
      screen.getByRole('menuitemcheckbox', { name: /System-wide dictation/i }),
    ).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Press to toggle' }))
    expect(readDictationSettings().activation).toBe('toggle')

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Cloud model' }))
    expect(readDictationSettings().provider).toBe('open_router')

    window.localStorage.clear()
  })

  it('opens speech settings from the dictation submenu', () => {
    const onOpenSpeechSettings = vi.fn()
    render(
      <SidebarOptionsMenu
        onOpenSettings={vi.fn()}
        onOpenSpeechSettings={onOpenSpeechSettings}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Dictation/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Speech settings…/i }))

    expect(onOpenSpeechSettings).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Options menu' })).not.toBeInTheDocument()
  })

  it('shows only one submenu at a time', () => {
    render(<SidebarOptionsMenu onOpenSettings={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /App theme/i }))
    expect(screen.getByRole('menu', { name: 'App theme options' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /Dictation/i }))
    expect(screen.getByRole('menu', { name: 'Dictation options' })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'App theme options' })).not.toBeInTheDocument()
  })

  it('switches app theme from the theme submenu', () => {
    render(<SidebarOptionsMenu onOpenSettings={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /App theme/i }))

    expect(screen.getByRole('menu', { name: 'App theme options' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: 'Dark theme' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark theme' }))
    expect(getAppearance().theme).toBe('dark')
  })
})
