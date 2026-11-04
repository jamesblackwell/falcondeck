import React, { forwardRef, useImperativeHandle } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSessionInfo } from '@falcondeck/client-core'

import { TerminalDock, TerminalPanel } from './TerminalPanel'
import {
  adjacentTabId,
  newPane,
  newTab,
  nextActiveTabId,
  tabIndexForKeyEvent,
  terminalPaneLabel,
  terminalTabLabel,
} from '../terminal-tabs'
import {
  forgetLayout,
  terminalScopeFor,
  useTerminalScopes,
  type TerminalRequest,
  type TerminalScope,
} from '../terminal-scopes'
import { getTerminalFontSize, setTerminalFontSize } from '../terminal-prefs'

vi.mock('../terminal-xterm', () => ({
  prefetchTerminalRuntime: () => Promise.resolve(),
}))

type ViewProps = {
  session: TerminalSessionInfo
  active: boolean
  onStatus?: (status: { process: string | null; cwd: string | null }) => void
  onOpenFile?: (link: { path: string; line: number | null; column: number | null }) => void
}

const views = vi.hoisted(() => ({
  focus: vi.fn<(id: string) => void>(),
  props: new Map<string, ViewProps>(),
  mounts: vi.fn<(id: string) => void>(),
}))

vi.mock('./TerminalView', async () => {
  const { useEffect } = await import('react')
  return {
    TerminalView: forwardRef(function FakeView(props: ViewProps, ref) {
      views.props.set(props.session.id, props)
      useImperativeHandle(ref, () => ({
        focus: () => views.focus(props.session.id),
        fit: vi.fn(),
        reactivate: vi.fn(),
        suspend: vi.fn(),
        findNext: vi.fn(() => false),
        findPrevious: vi.fn(() => false),
        clearSearch: vi.fn(),
      }))
      useEffect(() => {
        views.mounts(props.session.id)
      }, [props.session.id])
      return (
        <div
          data-testid="terminal-view"
          data-session={props.session.id}
          data-active={props.active || undefined}
          tabIndex={-1}
        />
      )
    }),
  }
})

const apiMocks = vi.hoisted(() => ({
  listTerminals: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  terminalSocketUrl: vi.fn(
    (id: string) => `ws://127.0.0.1:4123/api/terminals/${id}/ws?since_seq=0`,
  ),
}))

vi.mock('@falcondeck/client-core', () => ({
  createDaemonApiClient: () => apiMocks,
}))

function session(id: string, overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id,
    workspace_id: 'workspace-1',
    shell: '/bin/zsh',
    title: 'zsh',
    cwd: '/projects/falcondeck',
    cols: 100,
    rows: 30,
    created_at: '2026-08-27T12:00:00Z',
    thread_id: 'thread-1',
    ...overrides,
  }
}

const THREAD_SCOPE = terminalScopeFor('workspace-1', 'thread-1', null)!

let nextId = 0
function freshSession(overrides: Partial<TerminalSessionInfo> = {}) {
  nextId += 1
  return session(`term-new-${nextId}`, overrides)
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof TerminalPanel>> = {},
) {
  return render(
    <TerminalPanel baseUrl="http://127.0.0.1:4123" scope={THREAD_SCOPE} onHide={vi.fn()} {...props} />,
  )
}

function panes() {
  return [...document.querySelectorAll('[data-terminal-pane]')]
}

function focusedPane() {
  return document
    .querySelector('[data-terminal-tab-panes]:not([aria-hidden]) [data-terminal-pane][data-focused]')
    ?.getAttribute('data-terminal-pane')
}

function press(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  views.props.clear()
  nextId = 0
  forgetLayout(THREAD_SCOPE.key)
  apiMocks.listTerminals.mockResolvedValue({ sessions: [] })
  apiMocks.openTerminal.mockImplementation(async (_workspace: string, payload: { thread_id?: string; bot_id?: string }) => ({
    session: freshSession({ thread_id: payload.thread_id ?? null, bot_id: payload.bot_id ?? null }),
  }))
  apiMocks.closeTerminal.mockResolvedValue({ ok: true })
})

afterEach(() => cleanup())

describe('TerminalPanel', () => {
  it('restores only the sessions that belong to its scope', async () => {
    apiMocks.listTerminals.mockResolvedValue({
      sessions: [
        session('term-1'),
        session('term-other-thread', { thread_id: 'thread-2' }),
        session('term-bot', { thread_id: null, bot_id: 'bot-1' }),
        session('term-workspace', { thread_id: null }),
        session('term-2'),
      ],
    })
    renderPanel()
    const restored = await screen.findAllByTestId('terminal-view')
    expect(restored.map((view) => view.getAttribute('data-session'))).toEqual(['term-1', 'term-2'])
    expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(2)
    expect(apiMocks.openTerminal).not.toHaveBeenCalled()
  })

  it('auto-creates a scoped shell without taking focus', async () => {
    renderPanel()
    await waitFor(() =>
      expect(apiMocks.openTerminal).toHaveBeenCalledWith('workspace-1', {
        cols: 80,
        rows: 24,
        thread_id: 'thread-1',
      }),
    )
    expect(await screen.findByTestId('terminal-view')).toHaveAttribute('data-session', 'term-new-1')
    expect(views.focus).not.toHaveBeenCalled()
  })

  it('opens bot shells with the bot id so they start in its space', async () => {
    const botScope = terminalScopeFor('workspace-1', 'thread-home', 'bot-1')!
    renderPanel({ scope: botScope })
    await waitFor(() =>
      expect(apiMocks.openTerminal).toHaveBeenCalledWith('workspace-1', {
        cols: 80,
        rows: 24,
        thread_id: 'thread-home',
        bot_id: 'bot-1',
      }),
    )
  })

  it('does not auto-create terminals while hidden', async () => {
    const { rerender } = renderPanel({ visible: false })
    await waitFor(() => expect(apiMocks.listTerminals).toHaveBeenCalledOnce())
    expect(apiMocks.openTerminal).not.toHaveBeenCalled()
    rerender(<TerminalPanel baseUrl="http://127.0.0.1:4123" scope={THREAD_SCOPE} onHide={vi.fn()} visible />)
    await waitFor(() => expect(apiMocks.openTerminal).toHaveBeenCalledOnce())
  })

  it('honours a create request queued while the list loads', async () => {
    let resolveList!: (value: { sessions: TerminalSessionInfo[] }) => void
    apiMocks.listTerminals.mockReturnValue(new Promise((resolve) => (resolveList = resolve)))
    const onRequestDone = vi.fn()
    const requests: TerminalRequest[] = [{ seq: 1, scopeKey: THREAD_SCOPE.key, kind: 'create' }]
    renderPanel({ requests, onRequestDone })
    await waitFor(() => expect(apiMocks.listTerminals).toHaveBeenCalledOnce())
    expect(apiMocks.openTerminal).not.toHaveBeenCalled()
    await act(async () => resolveList({ sessions: [session('term-existing')] }))
    await waitFor(() => expect(apiMocks.openTerminal).toHaveBeenCalledOnce())
    expect(onRequestDone).toHaveBeenCalledWith(1)
    const all = await screen.findAllByTestId('terminal-view')
    expect(all.map((view) => view.getAttribute('data-session'))).toEqual(['term-existing', 'term-new-1'])
    // A requested tab is a user action: it takes focus.
    await waitFor(() => expect(views.focus).toHaveBeenCalledWith('term-new-1'))
  })

  it('focuses the active pane on a focus request', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    const onRequestDone = vi.fn()
    const { rerender } = renderPanel()
    await screen.findByTestId('terminal-view')
    expect(views.focus).not.toHaveBeenCalled()
    rerender(
      <TerminalPanel
        baseUrl="http://127.0.0.1:4123"
        scope={THREAD_SCOPE}
        onHide={vi.fn()}
        requests={[{ seq: 7, scopeKey: THREAD_SCOPE.key, kind: 'focus' }]}
        onRequestDone={onRequestDone}
      />,
    )
    await waitFor(() => expect(views.focus).toHaveBeenCalledWith('term-1'))
    expect(onRequestDone).toHaveBeenCalledWith(7)
  })

  it('gives focus back when hidden while focused', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    const onFocusLeave = vi.fn()
    const { rerender } = renderPanel({ onFocusLeave })
    const view = await screen.findByTestId('terminal-view')
    act(() => view.focus())
    expect(document.activeElement).toBe(view)
    rerender(
      <TerminalPanel
        baseUrl="http://127.0.0.1:4123"
        scope={THREAD_SCOPE}
        onHide={vi.fn()}
        onFocusLeave={onFocusLeave}
        visible={false}
      />,
    )
    expect(onFocusLeave).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(view)
  })

  it('closes every pane of a tab through its close button and empties the panel', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    const onEmpty = vi.fn()
    renderPanel({ onEmpty })
    await screen.findByTestId('terminal-view')
    fireEvent.click(document.querySelector('[data-terminal-tab-close]')!)
    await waitFor(() => expect(apiMocks.closeTerminal).toHaveBeenCalledWith('term-1'))
    expect(onEmpty).toHaveBeenCalledOnce()
  })

  it('hides without closing its sessions', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    const onHide = vi.fn()
    renderPanel({ onHide })
    await screen.findByTestId('terminal-view')
    fireEvent.click(screen.getByLabelText('Hide terminal'))
    expect(onHide).toHaveBeenCalledOnce()
    expect(apiMocks.closeTerminal).not.toHaveBeenCalled()
  })

  it('prompts for a project without a scope', () => {
    renderPanel({ scope: null })
    expect(screen.getByText(/Select a project/)).toBeInTheDocument()
    expect(apiMocks.listTerminals).not.toHaveBeenCalled()
  })

  it('surfaces a load failure', async () => {
    apiMocks.listTerminals.mockRejectedValue(new Error('daemon offline'))
    renderPanel()
    expect(await screen.findByText('Could not load terminals.')).toBeInTheDocument()
  })

  it('titles tabs from the foreground process, else the directory, and renames on double-click', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    renderPanel()
    await screen.findByTestId('terminal-view')
    const tabButton = () => document.querySelector('[data-terminal-tab] button')!
    expect(tabButton()).toHaveTextContent('falcondeck')
    act(() => views.props.get('term-1')!.onStatus!({ process: 'vim', cwd: '/projects/falcondeck/src' }))
    expect(tabButton()).toHaveTextContent('vim')
    act(() => views.props.get('term-1')!.onStatus!({ process: 'zsh', cwd: '/projects/falcondeck/src' }))
    expect(tabButton()).toHaveTextContent('src')

    fireEvent.doubleClick(tabButton())
    const input = screen.getByLabelText('Tab name')
    fireEvent.change(input, { target: { value: 'server' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(tabButton()).toHaveTextContent('server')
  })

  it('resolves ⌘-clicked file references against the pane directory', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    const onOpenFile = vi.fn()
    renderPanel({ onOpenFile })
    await screen.findByTestId('terminal-view')
    act(() => views.props.get('term-1')!.onStatus!({ process: 'zsh', cwd: '/projects/falcondeck/apps' }))
    views.props.get('term-1')!.onOpenFile!({ path: 'desktop/src/App.tsx', line: 12, column: 3 })
    expect(onOpenFile).toHaveBeenCalledWith({
      path: '/projects/falcondeck/apps/desktop/src/App.tsx',
      line: 12,
      column: 3,
    })
  })

  describe('keyboard shortcuts', () => {
    function activeLabels() {
      return [...document.querySelectorAll('[data-terminal-tab] button[data-active="true"]')].map(
        (button) => button.textContent,
      )
    }

    it('opens a new tab with ⌘T while the terminal has focus', async () => {
      apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
      apiMocks.openTerminal.mockResolvedValue({ session: session('term-2', { cwd: '/x/fish' }) })
      renderPanel()
      const view = await screen.findByTestId('terminal-view')
      press(view, { key: 't', metaKey: true })
      await waitFor(() => expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(2))
      expect(activeLabels()).toEqual(['fish'])
      await waitFor(() => expect(views.focus).toHaveBeenCalledWith('term-2'))
    })

    it('ignores ⌘T when focus is outside the panel', async () => {
      apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
      renderPanel()
      await screen.findByTestId('terminal-view')
      press(document.body, { key: 't', metaKey: true })
      await act(async () => undefined)
      expect(apiMocks.openTerminal).not.toHaveBeenCalled()
    })

    it('switches tabs with ⌘⇧] / ⌘⇧[ and jumps with ⌘digit', async () => {
      apiMocks.listTerminals.mockResolvedValue({
        sessions: [
          session('term-1', { cwd: '/a/one' }),
          session('term-2', { cwd: '/a/two' }),
          session('term-3', { cwd: '/a/three' }),
        ],
      })
      renderPanel()
      const all = await screen.findAllByTestId('terminal-view')
      expect(activeLabels()).toEqual(['three'])
      press(all[2]!, { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true })
      expect(activeLabels()).toEqual(['one'])
      press(all[0]!, { key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true })
      expect(activeLabels()).toEqual(['three'])
      const jump = press(all[2]!, { key: '2', metaKey: true })
      expect(jump.defaultPrevented).toBe(true)
      expect(activeLabels()).toEqual(['two'])
    })

    it('adjusts the terminal font size with ⌘+ / ⌘- / ⌘0', async () => {
      apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
      setTerminalFontSize(12)
      renderPanel()
      const view = await screen.findByTestId('terminal-view')
      press(view, { key: '=', code: 'Equal', metaKey: true })
      expect(getTerminalFontSize()).toBe(13)
      press(view, { key: '-', code: 'Minus', metaKey: true })
      press(view, { key: '-', code: 'Minus', metaKey: true })
      expect(getTerminalFontSize()).toBe(11)
      press(view, { key: '0', code: 'Digit0', metaKey: true })
      expect(getTerminalFontSize()).toBe(12)
    })
  })

  describe('splits', () => {
    async function renderSplitReady() {
      apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
      const onEmpty = vi.fn()
      renderPanel({ onEmpty })
      const view = await screen.findByTestId('terminal-view')
      return { view, onEmpty }
    }

    it('⌘D splits the focused pane side by side in the same tab and scope', async () => {
      const { view } = await renderSplitReady()
      press(view, { key: 'd', code: 'KeyD', metaKey: true })
      await waitFor(() => expect(panes()).toHaveLength(2))
      expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(1)
      expect(apiMocks.openTerminal).toHaveBeenLastCalledWith('workspace-1', {
        cols: 80,
        rows: 24,
        thread_id: 'thread-1',
      })
      expect(document.querySelector('[data-terminal-divider]')).toHaveAttribute('aria-orientation', 'vertical')
      expect(focusedPane()).toBe('term-new-1')
      await waitFor(() => expect(views.focus).toHaveBeenCalledWith('term-new-1'))
    })

    it('⌘⇧D stacks a pane below', async () => {
      const { view } = await renderSplitReady()
      press(view, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true })
      await waitFor(() => expect(panes()).toHaveLength(2))
      expect(document.querySelector('[data-terminal-divider]')).toHaveAttribute('aria-orientation', 'horizontal')
    })

    it('routes focus between panes with ⌘] / ⌘[ and ⌥⌘ arrows', async () => {
      const { view } = await renderSplitReady()
      press(view, { key: 'd', code: 'KeyD', metaKey: true })
      await waitFor(() => expect(panes()).toHaveLength(2))
      expect(focusedPane()).toBe('term-new-1')

      const next = press(view, { key: ']', code: 'BracketRight', metaKey: true })
      expect(next.defaultPrevented).toBe(true)
      expect(focusedPane()).toBe('term-1')
      press(view, { key: '[', code: 'BracketLeft', metaKey: true })
      expect(focusedPane()).toBe('term-new-1')
      press(view, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true })
      expect(focusedPane()).toBe('term-1')
      press(view, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true })
      expect(focusedPane()).toBe('term-new-1')
      // Nothing above: focus stays.
      press(view, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, altKey: true })
      expect(focusedPane()).toBe('term-new-1')
      await waitFor(() => expect(views.focus).toHaveBeenLastCalledWith('term-new-1'))
    })

    it('leaves ⌘[ to chat navigation when the tab has one pane', async () => {
      const { view } = await renderSplitReady()
      const event = press(view, { key: '[', code: 'BracketLeft', metaKey: true })
      expect(event.defaultPrevented).toBe(false)
    })

    it('⌘W closes the focused pane, then the tab with its last pane', async () => {
      const { view, onEmpty } = await renderSplitReady()
      press(view, { key: 'd', code: 'KeyD', metaKey: true })
      await waitFor(() => expect(panes()).toHaveLength(2))
      press(view, { key: 'w', code: 'KeyW', metaKey: true })
      await waitFor(() => expect(apiMocks.closeTerminal).toHaveBeenCalledWith('term-new-1'))
      expect(panes()).toHaveLength(1)
      expect(focusedPane()).toBe('term-1')
      expect(onEmpty).not.toHaveBeenCalled()
      press(view, { key: 'w', code: 'KeyW', metaKey: true })
      await waitFor(() => expect(apiMocks.closeTerminal).toHaveBeenCalledWith('term-1'))
      expect(onEmpty).toHaveBeenCalledOnce()
    })

    it('splitting never remounts the running pane', async () => {
      const { view } = await renderSplitReady()
      expect(views.mounts).toHaveBeenCalledTimes(1)
      press(view, { key: 'd', code: 'KeyD', metaKey: true })
      await waitFor(() => expect(panes()).toHaveLength(2))
      press(view, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true })
      await waitFor(() => expect(panes()).toHaveLength(3))
      expect(views.mounts.mock.calls.map(([id]) => id)).toEqual(['term-1', 'term-new-1', 'term-new-2'])
    })

    it('restores a split layout when the scope remounts', async () => {
      const { view, ...rest } = await renderSplitReady()
      void rest
      press(view, { key: 'd', code: 'KeyD', metaKey: true })
      await waitFor(() => expect(panes()).toHaveLength(2))
      cleanup()
      apiMocks.listTerminals.mockResolvedValue({
        sessions: [session('term-1'), session('term-new-1')],
      })
      renderPanel()
      await waitFor(() => expect(panes()).toHaveLength(2))
      expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(1)
    })
  })
})

function DockHarness({ scope, baseUrl = 'http://127.0.0.1:4123' }: { scope: TerminalScope | null; baseUrl?: string }) {
  const controller = useTerminalScopes(scope)
  return (
    <>
      <button type="button" onClick={controller.toggle}>toggle</button>
      <span data-testid="open">{String(controller.isOpen)}</span>
      <TerminalDock baseUrl={baseUrl} controller={controller} />
    </>
  )
}

describe('TerminalDock (per-scope open state)', () => {
  const atlas = terminalScopeFor('workspace-1', 'thread-atlas', 'atlas')!
  const vulcan = terminalScopeFor('workspace-2', 'thread-vulcan', 'vulcan')!

  beforeEach(() => {
    forgetLayout(atlas.key)
    forgetLayout(vulcan.key)
    apiMocks.listTerminals.mockImplementation(async (workspaceId: string) => ({
      sessions:
        workspaceId === 'workspace-1'
          ? [session('term-atlas', { thread_id: 'thread-atlas', bot_id: 'atlas' })]
          : [],
    }))
  })

  function hostFor(scope: TerminalScope) {
    return document.querySelector(`[data-terminal-scope-host="${scope.key}"]`)
  }

  it('closes on a bot without terminals and restores the other bot intact on return', async () => {
    const { rerender } = render(<DockHarness scope={atlas} />)
    fireEvent.click(screen.getByText('toggle'))
    expect(screen.getByTestId('open')).toHaveTextContent('true')
    await waitFor(() => expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-session', 'term-atlas'))
    expect(apiMocks.openTerminal).not.toHaveBeenCalled()

    rerender(<DockHarness scope={vulcan} />)
    expect(screen.getByTestId('open')).toHaveTextContent('false')
    // Atlas's panel stays mounted (scrollback, processes) but hidden and inert.
    expect(hostFor(atlas)).toHaveClass('hidden')
    expect(hostFor(atlas)).toHaveAttribute('inert')
    expect(views.props.get('term-atlas')?.active).toBe(false)
    expect(apiMocks.openTerminal).not.toHaveBeenCalled()
    expect(apiMocks.closeTerminal).not.toHaveBeenCalled()

    rerender(<DockHarness scope={atlas} />)
    expect(screen.getByTestId('open')).toHaveTextContent('true')
    expect(hostFor(atlas)).not.toHaveClass('hidden')
    expect(views.props.get('term-atlas')?.active).toBe(true)
    // Restored from the live instance: no second list, no remount.
    expect(apiMocks.listTerminals).toHaveBeenCalledTimes(1)
    expect(views.mounts).toHaveBeenCalledTimes(1)
  })

  it('keeps each bot open independently', async () => {
    const { rerender } = render(<DockHarness scope={atlas} />)
    fireEvent.click(screen.getByText('toggle'))
    await screen.findByTestId('terminal-view')
    rerender(<DockHarness scope={vulcan} />)
    fireEvent.click(screen.getByText('toggle'))
    await waitFor(() =>
      expect(apiMocks.openTerminal).toHaveBeenCalledWith('workspace-2', {
        cols: 80,
        rows: 24,
        thread_id: 'thread-vulcan',
        bot_id: 'vulcan',
      }),
    )
    rerender(<DockHarness scope={atlas} />)
    expect(screen.getByTestId('open')).toHaveTextContent('true')
    // Hiding Atlas leaves Vulcan open.
    fireEvent.click(screen.getByText('toggle'))
    rerender(<DockHarness scope={vulcan} />)
    expect(screen.getByTestId('open')).toHaveTextContent('true')
  })

  it('does not move focus into a terminal when switching bots', async () => {
    const { rerender } = render(<DockHarness scope={atlas} />)
    fireEvent.click(screen.getByText('toggle'))
    await screen.findByTestId('terminal-view')
    await waitFor(() => expect(views.focus).toHaveBeenCalledTimes(1))
    rerender(<DockHarness scope={vulcan} />)
    rerender(<DockHarness scope={atlas} />)
    await act(async () => undefined)
    expect(views.focus).toHaveBeenCalledTimes(1)
  })
})

describe('terminal tab helpers', () => {
  it('labels panes with the program, else the directory', () => {
    const pane = newPane(session('term-1'))
    expect(terminalPaneLabel(pane)).toBe('falcondeck')
    expect(terminalPaneLabel({ ...pane, process: 'cargo' })).toBe('cargo')
    expect(terminalPaneLabel({ ...pane, process: 'claude', observedTitle: '✳ Fix build' })).toBe('✳ Fix build')
    expect(terminalPaneLabel({ ...pane, process: '-zsh', cwd: '/tmp/www' })).toBe('www')
    const tab = newTab(pane.session)
    expect(terminalTabLabel({ ...tab, customTitle: 'api' }, { 'term-1': pane })).toBe('api')
  })

  it('selects the neighbouring tab when the active one closes', () => {
    const tabs = [newTab(session('a')), newTab(session('b')), newTab(session('c'))]
    expect(nextActiveTabId(tabs, 'tab-b')).toBe('tab-c')
    expect(nextActiveTabId(tabs, 'tab-c')).toBe('tab-b')
    expect(nextActiveTabId([tabs[0]!], 'tab-a')).toBeNull()
  })

  it('maps ⌘1–⌘9 to tab indexes with ⌘9 pinned to the last tab', () => {
    const event = (key: string) => ({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })
    expect(tabIndexForKeyEvent(event('1'), 3)).toBe(0)
    expect(tabIndexForKeyEvent(event('4'), 3)).toBeNull()
    expect(tabIndexForKeyEvent(event('9'), 3)).toBe(2)
    expect(tabIndexForKeyEvent({ ...event('1'), shiftKey: true }, 3)).toBeNull()
  })

  it('cycles to the neighbouring tab', () => {
    const tabs = [newTab(session('a')), newTab(session('b'))]
    expect(adjacentTabId(tabs, 'tab-b', 1)).toBe('tab-a')
    expect(adjacentTabId(tabs, 'tab-a', -1)).toBe('tab-b')
    expect(adjacentTabId([], null, 1)).toBeNull()
  })
})
