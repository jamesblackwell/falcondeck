import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { TerminalSessionInfo } from '@falcondeck/client-core'

import {
  MAX_RETAINED_TERMINAL_SCOPES,
  botIdForThread,
  sessionScopeKey,
  terminalScopeFor,
  useTerminalScopes,
  type TerminalScope,
} from './terminal-scopes'
import {
  reloadTerminalPrefsForTests,
  setTerminalPanelHeight,
  terminalPanelHeight,
} from './terminal-prefs'

const bots = [{ id: 'atlas', thread_id: 'home-2', previous_thread_ids: ['home-1'] }]

describe('terminal scopes', () => {
  it('scopes to the bot, then the thread, then the project', () => {
    expect(botIdForThread(bots, 'home-1')).toBe('atlas')
    expect(botIdForThread(bots, 'home-2')).toBe('atlas')
    expect(botIdForThread(bots, 'task')).toBeNull()
    expect(terminalScopeFor('ws', 'home-2', 'atlas')?.key).toBe('bot:atlas')
    expect(terminalScopeFor('ws', 'task', null)?.key).toBe('thread:task')
    expect(terminalScopeFor('ws', null, null)?.key).toBe('workspace:ws')
    expect(terminalScopeFor(null, 'task', null)).toBeNull()
    const base = { workspace_id: 'ws' } as TerminalSessionInfo
    expect(sessionScopeKey({ ...base, thread_id: 't', bot_id: 'atlas' })).toBe('bot:atlas')
    expect(sessionScopeKey({ ...base, thread_id: 't' })).toBe('thread:t')
    expect(sessionScopeKey(base)).toBe('workspace:ws')
  })
})

describe('useTerminalScopes', () => {
  const scope = (id: string): TerminalScope => terminalScopeFor('ws', id, null)!

  it('keeps open state per scope', () => {
    const a = scope('a')
    const b = scope('b')
    const { result, rerender } = renderHook(({ current }) => useTerminalScopes(current), {
      initialProps: { current: a },
    })
    act(() => result.current.toggle())
    expect(result.current.isOpen).toBe(true)
    expect(result.current.requests.map((entry) => entry.kind)).toEqual(['focus'])
    rerender({ current: b })
    expect(result.current.isOpen).toBe(false)
    // Requests made for Atlas never follow the user to another scope.
    expect(result.current.requests).toEqual([])
    rerender({ current: a })
    expect(result.current.isOpen).toBe(true)
    expect(result.current.retained.map((entry) => entry.key)).toEqual([a.key])
    act(() => result.current.release(a.key))
    expect(result.current.isOpen).toBe(false)
    expect(result.current.retained).toEqual([])
  })

  it('retains a bounded number of hidden scopes, most recent first', () => {
    const scopes = Array.from({ length: MAX_RETAINED_TERMINAL_SCOPES + 2 }, (_, index) => scope(`t${index}`))
    const { result, rerender } = renderHook(({ current }) => useTerminalScopes(current), {
      initialProps: { current: scopes[0]! },
    })
    for (const entry of scopes) {
      rerender({ current: entry })
      act(() => result.current.openNew())
    }
    expect(result.current.retained).toHaveLength(MAX_RETAINED_TERMINAL_SCOPES)
    expect(result.current.retained[0]!.key).toBe(scopes.at(-1)!.key)
    expect(result.current.retained.some((entry) => entry.key === scopes[0]!.key)).toBe(false)
  })
})

describe('terminal panel height', () => {
  beforeEach(() => {
    window.localStorage.clear()
    reloadTerminalPrefsForTests()
  })

  it('remembers a global height and a per-scope override', () => {
    expect(terminalPanelHeight(null)).toBe(320)
    setTerminalPanelHeight('bot:atlas', 410)
    expect(terminalPanelHeight('bot:atlas')).toBe(410)
    expect(terminalPanelHeight('bot:vulcan')).toBe(410)
    setTerminalPanelHeight('bot:vulcan', 200)
    expect(terminalPanelHeight('bot:atlas')).toBe(410)
    expect(terminalPanelHeight('thread:new')).toBe(200)
    reloadTerminalPrefsForTests()
    expect(terminalPanelHeight('bot:atlas')).toBe(410)
  })
})
