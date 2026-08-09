import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { bindingsFor, resetAllShortcuts } from '../../shortcuts'
import { KeyboardShortcutsPanel } from './KeyboardShortcutsPanel'

describe('KeyboardShortcutsPanel', () => {
  beforeEach(() => resetAllShortcuts())

  it('searches commands and supports explicit unbinding and reset', () => {
    render(<KeyboardShortcutsPanel />)
    fireEvent.change(screen.getByLabelText('Search shortcut commands'), { target: { value: 'sidebar' } })
    expect(screen.getByText('Toggle sidebar')).toBeInTheDocument()
    expect(screen.queryByText('Open project')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remove Mod+B from Toggle sidebar'))
    expect(bindingsFor('toggleSidebar')).toEqual([])
    expect(screen.getByText('Unassigned')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Reset Toggle sidebar'))
    expect(bindingsFor('toggleSidebar')).toEqual(['Mod+B'])
  })

  it('records an additional binding and blocks conflicts', () => {
    render(<KeyboardShortcutsPanel />)
    fireEvent.change(screen.getByLabelText('Search shortcut commands'), { target: { value: 'Settings' } })
    fireEvent.click(screen.getByLabelText('Add shortcut for Settings'))
    const recorder = screen.getByLabelText('Record shortcut for Settings')
    fireEvent.keyDown(recorder, { key: 's', metaKey: true, shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bindingsFor('openSettings')).toContain('Mod+Shift+S')

    fireEvent.click(screen.getByLabelText('Add shortcut for Settings'))
    fireEvent.keyDown(screen.getByLabelText('Record shortcut for Settings'), { key: 'k', metaKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Already used by Command menu')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('lets keyboard users leave the recorder and reach Save', () => {
    render(<KeyboardShortcutsPanel />)
    fireEvent.change(screen.getByLabelText('Search shortcut commands'), { target: { value: 'Settings' } })
    fireEvent.click(screen.getByLabelText('Add shortcut for Settings'))
    const recorder = screen.getByLabelText('Record shortcut for Settings')
    fireEvent.keyDown(recorder, { key: 's', metaKey: true, shiftKey: true })
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.keyDown(recorder, { key: 'Tab' })
    expect(save).toHaveFocus()
  })

  it('finds commands by their current keystroke', () => {
    render(<KeyboardShortcutsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Find by keys' }))
    fireEvent.keyDown(screen.getByLabelText('Capture shortcut to search'), { key: 'Enter', metaKey: true })
    expect(screen.getByText('Invert Queue / Steer')).toBeInTheDocument()
    expect(screen.queryByText('Toggle sidebar')).not.toBeInTheDocument()
  })

  it('lets keyboard users leave or cancel keystroke search capture', () => {
    render(<KeyboardShortcutsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Find by keys' }))
    const capture = screen.getByLabelText('Capture shortcut to search')
    expect(fireEvent.keyDown(capture, { key: 'Tab' })).toBe(true)

    fireEvent.keyDown(capture, { key: 'Escape' })
    expect(screen.getByLabelText('Search shortcut commands')).toHaveFocus()
  })
})
