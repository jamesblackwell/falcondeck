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
