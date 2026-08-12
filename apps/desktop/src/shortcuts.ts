import { useSyncExternalStore } from 'react'

export type ShortcutContext = 'global' | 'composer'

export type ShortcutCommandId =
  | 'commandPalette'
  | 'openSettings'
  | 'openKeyboardShortcuts'
  | 'openProject'
  | 'newThread'
  | 'searchThreads'
  | 'findInThread'
  | 'navigateBack'
  | 'navigateForward'
  | 'previousThread'
  | 'nextThread'
  | 'toggleSidebar'
  | 'toggleChanges'
  | 'increaseTextSize'
  | 'decreaseTextSize'
  | 'resetTextSize'
  | 'focusComposer'
  | 'openHarnessMenu'
  | 'openPermissionMenu'
  | 'openSandboxMenu'
  | 'openModelMenu'
  | 'stopTurn'
  | 'sendMessage'
  | 'invertFollowUp'
  | 'insertNewline'

export type ShortcutDefinition = {
  id: ShortcutCommandId
  label: string
  description: string
  category: 'App' | 'Navigation' | 'View' | 'Conversation' | 'Composer'
  context: ShortcutContext
  defaults: string[]
}

export type FollowUpBehavior = 'queue' | 'steer'

export type ShortcutSettings = {
  version: 1
  bindings: Partial<Record<ShortcutCommandId, string[]>>
  followUpBehavior: FollowUpBehavior
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'commandPalette', label: 'Command menu', description: 'Search chats and available commands', category: 'App', context: 'global', defaults: ['Mod+K', 'Mod+Shift+P'] },
  { id: 'openSettings', label: 'Settings', description: 'Open FalconDeck settings', category: 'App', context: 'global', defaults: ['Mod+,'] },
  { id: 'openKeyboardShortcuts', label: 'Keyboard shortcuts', description: 'Review and customize every binding', category: 'App', context: 'global', defaults: ['Mod+Shift+/'] },
  { id: 'openProject', label: 'Open project', description: 'Add a local project folder', category: 'App', context: 'global', defaults: ['Mod+O'] },
  { id: 'newThread', label: 'New chat', description: 'Start a chat in the current project', category: 'Conversation', context: 'global', defaults: ['Mod+N', 'Mod+Shift+O'] },
  { id: 'searchThreads', label: 'Search chats', description: 'Open the command menu focused on chats', category: 'Conversation', context: 'global', defaults: ['Mod+G'] },
  { id: 'findInThread', label: 'Find in chat', description: 'Find text in the current conversation', category: 'Conversation', context: 'global', defaults: ['Mod+F'] },
  { id: 'navigateBack', label: 'Navigate back', description: 'Return to the previously selected chat', category: 'Navigation', context: 'global', defaults: ['Mod+['] },
  { id: 'navigateForward', label: 'Navigate forward', description: 'Move forward through chat selection history', category: 'Navigation', context: 'global', defaults: ['Mod+]'] },
  { id: 'previousThread', label: 'Previous chat', description: 'Select the previous visible chat', category: 'Navigation', context: 'global', defaults: ['Mod+Shift+['] },
  { id: 'nextThread', label: 'Next chat', description: 'Select the next visible chat', category: 'Navigation', context: 'global', defaults: ['Mod+Shift+]'] },
  { id: 'toggleSidebar', label: 'Toggle sidebar', description: 'Show or hide projects and chats', category: 'View', context: 'global', defaults: ['Mod+B'] },
  { id: 'toggleChanges', label: 'Toggle changes panel', description: 'Show or hide the changes panel', category: 'View', context: 'global', defaults: ['Mod+Alt+B'] },
  { id: 'increaseTextSize', label: 'Increase text size', description: 'Increase the interface text scale', category: 'View', context: 'global', defaults: ['Mod+=', 'Mod+Shift+Plus'] },
  { id: 'decreaseTextSize', label: 'Decrease text size', description: 'Decrease the interface text scale', category: 'View', context: 'global', defaults: ['Mod+-'] },
  { id: 'resetTextSize', label: 'Reset text size', description: 'Restore the default interface text scale', category: 'View', context: 'global', defaults: ['Mod+0'] },
  { id: 'focusComposer', label: 'Focus prompt', description: 'Move focus to the prompt composer', category: 'Composer', context: 'global', defaults: ['Shift+Escape'] },
  { id: 'openHarnessMenu', label: 'Choose agent', description: 'Open the agent picker on the composer', category: 'Composer', context: 'global', defaults: ['Ctrl+Shift+A'] },
  { id: 'openPermissionMenu', label: 'Choose permission mode', description: 'Open the permission mode picker on the composer', category: 'Composer', context: 'global', defaults: ['Ctrl+Shift+P'] },
  { id: 'openSandboxMenu', label: 'Choose sandbox mode', description: 'Open the sandbox picker on the composer', category: 'Composer', context: 'global', defaults: ['Ctrl+Shift+S'] },
  { id: 'openModelMenu', label: 'Choose model', description: 'Open the model and reasoning picker on the composer', category: 'Composer', context: 'global', defaults: ['Ctrl+Shift+M'] },
  { id: 'stopTurn', label: 'Stop response', description: 'Interrupt the running agent turn', category: 'Conversation', context: 'global', defaults: ['Mod+.'] },
  { id: 'sendMessage', label: 'Send message', description: 'Send now, or use the default follow-up behavior while running', category: 'Composer', context: 'composer', defaults: ['Enter'] },
  { id: 'invertFollowUp', label: 'Invert Queue / Steer', description: 'Use the opposite follow-up behavior for this message', category: 'Composer', context: 'composer', defaults: ['Mod+Enter'] },
  { id: 'insertNewline', label: 'Insert newline', description: 'Add a line without sending', category: 'Composer', context: 'composer', defaults: ['Shift+Enter'] },
] as const

const STORAGE_KEY = 'falcondeck.desktop.shortcuts.v1'
const DEFAULT_SETTINGS: ShortcutSettings = { version: 1, bindings: {}, followUpBehavior: 'queue' }
const definitionById = new Map(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]))
const listeners = new Set<() => void>()

function readSettings(): ShortcutSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    const candidate = parsed as Partial<ShortcutSettings>
    const bindings: ShortcutSettings['bindings'] = {}
    if (candidate.bindings && typeof candidate.bindings === 'object') {
      for (const definition of SHORTCUT_DEFINITIONS) {
        const value = candidate.bindings[definition.id]
        if (Array.isArray(value)) {
          bindings[definition.id] = value.filter((item): item is string => typeof item === 'string')
        }
      }
    }
    return {
      version: 1,
      bindings,
      followUpBehavior: candidate.followUpBehavior === 'steer' ? 'steer' : 'queue',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

let current = readSettings()

function save() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Device-local persistence is best effort; current remains live in memory.
  }
  for (const listener of listeners) listener()
}

export function getShortcutSettings() {
  return current
}

export function subscribeShortcutSettings(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useShortcutSettings() {
  return useSyncExternalStore(subscribeShortcutSettings, getShortcutSettings, getShortcutSettings)
}

export function bindingsFor(commandId: ShortcutCommandId, settings = current): string[] {
  const custom = settings.bindings[commandId]
  return custom ?? definitionById.get(commandId)?.defaults ?? []
}

export function setShortcutBindings(commandId: ShortcutCommandId, bindings: string[]) {
  current = {
    ...current,
    bindings: { ...current.bindings, [commandId]: [...new Set(bindings.map(normalizeShortcut))] },
  }
  save()
}

export function resetShortcutBindings(commandId: ShortcutCommandId) {
  const bindings = { ...current.bindings }
  delete bindings[commandId]
  current = { ...current, bindings }
  save()
}

export function resetAllShortcuts() {
  current = DEFAULT_SETTINGS
  save()
}

export function setFollowUpBehavior(followUpBehavior: FollowUpBehavior) {
  current = { ...current, followUpBehavior }
  save()
}

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const

export function normalizeShortcut(value: string): string {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  const key = parts.at(-1) ?? ''
  const modifiers = new Set(parts.slice(0, -1).map((part) => {
    const lowered = part.toLowerCase()
    if (lowered === 'cmd' || lowered === 'command' || lowered === 'meta' || lowered === 'mod') return 'Mod'
    if (lowered === 'control' || lowered === 'ctrl') return 'Ctrl'
    if (lowered === 'option' || lowered === 'opt' || lowered === 'alt') return 'Alt'
    if (lowered === 'shift') return 'Shift'
    return part
  }))
  const normalizedKey = key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), normalizedKey].filter(Boolean).join('+')
}

export type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
  code?: string
}

// macOS composes Option with the layout, so Option+B reports key "∫" instead of "b".
// The physical code is the only stable identity for those bindings.
const KEY_BY_CODE: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: 'Space',
}

function keyFromCode(code: string | undefined): string | null {
  if (!code) return null
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  return KEY_BY_CODE[code] ?? null
}

function eventKey(event: Pick<ShortcutKeyEvent, 'key' | 'shiftKey' | 'altKey' | 'code'>): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null
  if (event.altKey) {
    const physical = keyFromCode(event.code)
    if (physical) return physical
  }
  // KeyboardEvent.key reports the produced character, so shifted punctuation
  // must be folded back to its physical key before retaining the Shift modifier.
  const shiftedPunctuation: Record<string, string> = {
    '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': '-', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
  }
  const aliases: Record<string, string> = {
    ' ': 'Space', '+': 'Plus', Esc: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  }
  const producedKey = event.shiftKey ? shiftedPunctuation[event.key] ?? event.key : event.key
  const key = aliases[producedKey] ?? producedKey
  return key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key
}

export function shortcutFromEvent(event: ShortcutKeyEvent): string | null {
  const key = eventKey(event)
  if (!key) return null
  // This registry is the Mac desktop profile: Mod intentionally means Command.
  // A future cross-platform profile should resolve Mod before changing this mapping.
  return normalizeShortcut([
    event.metaKey ? 'Mod' : '',
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    key,
  ].filter(Boolean).join('+'))
}

export function commandForEvent(
  context: ShortcutContext,
  event: ShortcutKeyEvent,
  settings = current,
): ShortcutCommandId | null {
  const shortcut = shortcutFromEvent(event)
  if (!shortcut) return null
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.context !== context) continue
    if (bindingsFor(definition.id, settings).includes(shortcut)) return definition.id
  }
  return null
}

export function shortcutConflict(
  shortcut: string,
  commandId: ShortcutCommandId,
  settings = current,
): ShortcutDefinition | null {
  const definition = definitionById.get(commandId)
  if (!definition) return null
  const normalized = normalizeShortcut(shortcut)
  return SHORTCUT_DEFINITIONS.find((candidate) => {
    if (candidate.id === commandId) return false
    const contextsOverlap = candidate.context === definition.context || candidate.context === 'global' || definition.context === 'global'
    return contextsOverlap && bindingsFor(candidate.id, settings).includes(normalized)
  }) ?? null
}

export function shortcutValidation(shortcut: string, context: ShortcutContext): string | null {
  const normalized = normalizeShortcut(shortcut)
  const parts = normalized.split('+')
  const key = parts.at(-1) ?? ''
  if (!key || MODIFIER_ORDER.includes(key as (typeof MODIFIER_ORDER)[number])) return 'Press a non-modifier key.'
  if (context === 'global' && key.length === 1 && /[a-z0-9]/i.test(key) && !parts.some((part) => ['Mod', 'Ctrl', 'Alt'].includes(part))) {
    return 'Global letter and number shortcuts need Command, Control, or Option.'
  }
  return null
}

export function shortcutTokens(shortcut: string): string[] {
  const symbols: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↵', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space', Plus: '+' }
  return normalizeShortcut(shortcut).split('+').map((part) => symbols[part] ?? part)
}

export function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}
