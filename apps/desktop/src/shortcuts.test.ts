import { beforeEach, describe, expect, it } from 'vitest'

import {
  bindingsFor,
  commandForEvent,
  normalizeShortcut,
  resetAllShortcuts,
  setShortcutBindings,
  shortcutConflict,
  shortcutFromEvent,
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
    expect(commandForEvent('global', key('A', { ctrlKey: true, shiftKey: true }))).toBe('openHarnessMenu')
    expect(commandForEvent('global', key('P', { ctrlKey: true, shiftKey: true }))).toBe('openPermissionMenu')
    expect(commandForEvent('global', key('S', { ctrlKey: true, shiftKey: true }))).toBe('openSandboxMenu')
    expect(commandForEvent('global', key('M', { ctrlKey: true, shiftKey: true }))).toBe('openModelMenu')
    // The Command-based palette chord must stay distinct from Ctrl+Shift+P.
    expect(commandForEvent('global', key('P', { metaKey: true, shiftKey: true }))).toBe('commandPalette')
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
})
