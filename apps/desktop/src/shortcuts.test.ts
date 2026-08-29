import { beforeEach, describe, expect, it } from 'vitest'

import {
  bindingsFor,
  commandForEvent,
  isEditableTarget,
  normalizeShortcut,
  resetAllShortcuts,
  setShortcutBindings,
  shortcutConflict,
  shortcutFromEvent,
  shortcutHint,
  shortcutHintTokens,
  shortcutTitle,
  shortcutTokens,
  shortcutValidation,
} from './shortcuts'

function key(key: string, modifiers: Partial<KeyboardEvent> = {}) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }
}

function optionKey(produced: string, code: string, modifiers: Partial<KeyboardEvent> = {}) {
  return { ...key(produced, { altKey: true, ...modifiers }), code }
}

describe('keyboard shortcuts', () => {
  beforeEach(() => resetAllShortcuts())

  it('normalizes aliases and renders Mac keycaps', () => {
    expect(normalizeShortcut('command+option+shift+k')).toBe('Mod+Alt+Shift+K')
    expect(shortcutTokens('Mod+Alt+Shift+Enter')).toEqual(['⌘', '⌥', '⇧', '↵'])
  })

  it('maps keyboard events to context-specific commands', () => {
    expect(shortcutFromEvent(key('Enter', { metaKey: true }))).toBe('Mod+Enter')
    expect(shortcutFromEvent(key('+', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+Plus')
    expect(shortcutFromEvent(key('?', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+/')
    expect(shortcutFromEvent(key('{', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+[')
    expect(shortcutFromEvent(key('}', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+]')
    expect(commandForEvent('composer', key('Enter', { metaKey: true }))).toBe('invertFollowUp')
    expect(commandForEvent('global', key('k', { metaKey: true }))).toBe('commandPalette')
    expect(commandForEvent('global', key('u', { metaKey: true }))).toBe('openActivity')
    expect(commandForEvent('global', key('u', { metaKey: true, shiftKey: true }))).toBe('openUsage')
    expect(commandForEvent('global', key('j', { metaKey: true }))).toBe('toggleTerminal')
    expect(commandForEvent('global', key('?', { metaKey: true, shiftKey: true }))).toBe('openKeyboardShortcuts')
    expect(commandForEvent('global', key('Enter', { metaKey: true }))).toBeNull()
  })

  it('resolves Option chords from the physical key, not the composed character', () => {
    // macOS reports ⌘⌥B as "∫"; the binding must still resolve.
    expect(shortcutFromEvent(optionKey('∫', 'KeyB', { metaKey: true }))).toBe('Mod+Alt+B')
    expect(commandForEvent('global', optionKey('∫', 'KeyB', { metaKey: true }))).toBe('toggleChanges')
    expect(shortcutFromEvent(optionKey('“', 'BracketLeft'))).toBe('Alt+[')
    // Events without a physical code still fall back to the produced key.
    expect(shortcutFromEvent(key('b', { metaKey: true, altKey: true }))).toBe('Mod+Alt+B')
  })

  it('maps Ctrl+Shift chords to the composer option menus', () => {
    expect(commandForEvent('global', key('L', { ctrlKey: true, shiftKey: true }))).toBe('openProjectMenu')
    expect(commandForEvent('global', key('A', { ctrlKey: true, shiftKey: true }))).toBe('openHarnessMenu')
    expect(commandForEvent('global', key('P', { ctrlKey: true, shiftKey: true }))).toBe('openPermissionMenu')
    expect(commandForEvent('global', key('S', { ctrlKey: true, shiftKey: true }))).toBe('openSandboxMenu')
    expect(commandForEvent('global', key('M', { ctrlKey: true, shiftKey: true }))).toBe('openModelMenu')
    // The Command-based palette chord must stay distinct from Ctrl+Shift+P.
    expect(commandForEvent('global', key('P', { metaKey: true, shiftKey: true }))).toBe('commandPalette')
  })

  it('opens the shortcut sheet from a bare "?" as well as the Mac Help chord', () => {
    expect(commandForEvent('global', key('?', { shiftKey: true }))).toBe('openKeyboardShortcuts')
    expect(commandForEvent('global', key('?', { metaKey: true, shiftKey: true }))).toBe('openKeyboardShortcuts')
    // An unmodified "?" is only safe because it is punctuation; validation
    // still refuses bare letters, which would swallow ordinary typing.
    expect(shortcutValidation('Shift+/', 'global')).toBeNull()
  })

  it('renders hints for the primary binding of a command', () => {
    expect(shortcutHint('openActivity')).toBe('⌘U')
    expect(shortcutHintTokens('openActivity')).toEqual(['⌘', 'U'])
    expect(shortcutTitle('Activity', 'openActivity')).toBe('Activity (⌘U)')
    expect(shortcutHint('openUsage')).toBe('⌘⇧U')
    expect(shortcutHintTokens('openUsage')).toEqual(['⌘', '⇧', 'U'])

    setShortcutBindings('openActivity', [])
    expect(shortcutHint('openActivity')).toBeNull()
    expect(shortcutHintTokens('openActivity')).toBeUndefined()
    // An unbound command falls back to a plain label rather than "(  )".
    expect(shortcutTitle('Activity', 'openActivity')).toBe('Activity')
  })

  it('persists explicit unbinding and supports reset', () => {
    setShortcutBindings('toggleSidebar', [])
    expect(bindingsFor('toggleSidebar')).toEqual([])
    resetAllShortcuts()
    expect(bindingsFor('toggleSidebar')).toEqual(['Mod+B'])
  })

  it('detects collisions across overlapping contexts', () => {
    expect(shortcutConflict('Mod+K', 'openSettings')?.id).toBe('commandPalette')
    expect(shortcutConflict('Enter', 'insertNewline')?.id).toBe('sendMessage')
  })

  it('rejects unsafe unmodified global letters', () => {
    expect(shortcutValidation('K', 'global')).toMatch(/need Command/)
    expect(shortcutValidation('Mod+K', 'global')).toBeNull()
    expect(shortcutValidation('Enter', 'composer')).toBeNull()
  })

  it('recognizes every enabled contenteditable spelling as an editable target', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', '')
    const child = document.createElement('span')
    editor.append(child)
    document.body.append(editor)

    expect(isEditableTarget(child)).toBe(true)
    editor.setAttribute('contenteditable', 'false')
    expect(isEditableTarget(child)).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)

    editor.remove()
  })
})
