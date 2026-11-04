import { useSyncExternalStore } from 'react'

import { TERMINAL_FONT_SIZE } from './terminal-utils'

/** Device-local terminal preferences: font size and panel heights. */

const FONT_SIZE_KEY = 'falcondeck.desktop.terminal.fontSize'
const HEIGHT_KEY = 'falcondeck.desktop.terminal.height'
const SCOPE_HEIGHTS_KEY = 'falcondeck.desktop.terminal.scopeHeights'
const MAX_SCOPE_HEIGHTS = 50

export const TERMINAL_FONT_SIZE_MIN = 9
export const TERMINAL_FONT_SIZE_MAX = 24
export const TERMINAL_PANEL_DEFAULT_HEIGHT = 320

function read<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    return valid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Best effort; the in-memory value stays live.
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isHeightMap = (value: unknown): value is Record<string, number> =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every(isNumber)

type Prefs = {
  fontSize: number
  height: number
  scopeHeights: Record<string, number>
}

function load(): Prefs {
  return {
    fontSize: clampFontSize(read(FONT_SIZE_KEY, TERMINAL_FONT_SIZE, isNumber)),
    height: read(HEIGHT_KEY, TERMINAL_PANEL_DEFAULT_HEIGHT, isNumber),
    scopeHeights: read(SCOPE_HEIGHTS_KEY, {}, isHeightMap),
  }
}

let prefs = load()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function clampFontSize(size: number) {
  return Math.round(Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size)))
}

export function getTerminalFontSize() {
  return prefs.fontSize
}

export function setTerminalFontSize(size: number) {
  const next = clampFontSize(size)
  if (next === prefs.fontSize) return
  prefs = { ...prefs, fontSize: next }
  write(FONT_SIZE_KEY, next)
  emit()
}

export function subscribeTerminalFontSize(listener: () => void) {
  return subscribe(listener)
}

export function useTerminalFontSize() {
  return useSyncExternalStore(subscribe, getTerminalFontSize, getTerminalFontSize)
}

/** A scope's own height when it has one, else the last height used anywhere. */
export function terminalPanelHeight(scopeKey: string | null): number {
  return (scopeKey ? prefs.scopeHeights[scopeKey] : undefined) ?? prefs.height
}

export function setTerminalPanelHeight(scopeKey: string | null, height: number) {
  const rounded = Math.round(height)
  const scopeHeights = { ...prefs.scopeHeights }
  if (scopeKey) {
    delete scopeHeights[scopeKey]
    scopeHeights[scopeKey] = rounded
    const keys = Object.keys(scopeHeights)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SCOPE_HEIGHTS))) {
      delete scopeHeights[stale]
    }
  }
  prefs = { ...prefs, height: rounded, scopeHeights }
  write(HEIGHT_KEY, rounded)
  write(SCOPE_HEIGHTS_KEY, scopeHeights)
  emit()
}

const getPrefs = () => prefs

export function useTerminalPanelHeight(scopeKey: string | null) {
  const current = useSyncExternalStore(subscribe, getPrefs, getPrefs)
  return (scopeKey ? current.scopeHeights[scopeKey] : undefined) ?? current.height
}

/** Test hook: re-read storage. */
export function reloadTerminalPrefsForTests() {
  prefs = load()
  emit()
}
