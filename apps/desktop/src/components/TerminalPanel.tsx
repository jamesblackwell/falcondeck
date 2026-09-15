import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, PanelBottomClose, Plus, Search, X } from 'lucide-react'
import { createDaemonApiClient } from '@falcondeck/client-core'
import { Button, Kbd, Tooltip, cn } from '@falcondeck/ui'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import {
  adjacentTabId,
  nextActiveTabId,
  tabIndexForKeyEvent,
  terminalTabLabel,
  type TerminalTab,
} from '../terminal-tabs'
import {
  FALLBACK_TERMINAL_COLS,
  FALLBACK_TERMINAL_ROWS,
  measureTerminalGrid,
} from '../terminal-utils'
import { prefetchTerminalRuntime } from '../terminal-xterm'
import { commandForEvent, shortcutHintTokens, useShortcutSettings } from '../shortcuts'

interface TerminalPanelProps {
  baseUrl: string
  workspaceId: string | null
  onHide: () => void
  visible?: boolean
  createRequestKey?: number
  findRequestKey?: number
}

export function TerminalPanel({
  baseUrl,
  workspaceId,
  onHide,
  visible = true,
  createRequestKey = 0,
  findRequestKey = 0,
}: TerminalPanelProps) {
  const api = useMemo(() => createDaemonApiClient(baseUrl), [baseUrl])
  const shortcutSettings = useShortcutSettings()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findFound, setFindFound] = useState<boolean | null>(null)
  // Whether this workspace has had its first shell spawned (or requested);
  // state rather than a ref because the placeholder renders from it.
  const [autoCreated, setAutoCreated] = useState(false)
  const tabsRef = useRef<TerminalTab[]>([])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const viewRefs = useRef(new Map<string, TerminalViewHandle>())
  const workspaceRef = useRef(workspaceId)
  const createInFlightRef = useRef(false)
  const lastCreateRequestKey = useRef(0)
  const lastFindRequestKey = useRef(0)

  useLayoutEffect(() => {
    workspaceRef.current = workspaceId
  }, [workspaceId])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    void prefetchTerminalRuntime()
  }, [])

  useEffect(() => {
    if (!workspaceId) {
      setLoaded(true)
      return
    }
    let cancelled = false
    setAutoCreated(false)
    setTabs([])
    setActiveId(null)
    setLoaded(false)
    setError(null)
    void (async () => {
      try {
        const { sessions } = await api.listTerminals(workspaceId)
        if (cancelled) return
        const restored = sessions.map((session) => ({
          session,
          status: 'running' as const,
          observedTitle: null,
        }))
        setTabs(restored)
        setActiveId(restored.at(-1)?.session.id ?? null)
        setLoaded(true)
      } catch {
        if (!cancelled) {
          setError('Could not load terminals.')
          setLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, workspaceId])

  const createTerminal = useCallback(async () => {
    if (!workspaceId || createInFlightRef.current) return
    const requestedWorkspaceId = workspaceId
    createInFlightRef.current = true
    setCreating(true)
    setError(null)
    const measured = hostRef.current
      ? measureTerminalGrid(hostRef.current)
      : { cols: FALLBACK_TERMINAL_COLS, rows: FALLBACK_TERMINAL_ROWS }
    try {
      const { session } = await api.openTerminal(requestedWorkspaceId, measured)
      if (workspaceRef.current !== requestedWorkspaceId) return
      setTabs((current) => {
        if (current.some((tab) => tab.session.id === session.id)) return current
        return [...current, { session, status: 'running' as const, observedTitle: null }]
      })
      setActiveId(session.id)
    } catch {
      if (workspaceRef.current === requestedWorkspaceId) {
        setError('Could not start a terminal.')
      }
    } finally {
      createInFlightRef.current = false
      setCreating(false)
    }
  }, [api, workspaceId])

  useEffect(() => {
    if (!visible || !loaded || !workspaceId || error || autoCreated) return
    if (tabs.length > 0 || creating) return
    setAutoCreated(true)
    void createTerminal()
  }, [autoCreated, createTerminal, creating, error, loaded, tabs.length, visible, workspaceId])

  useEffect(() => {
    if (createRequestKey <= lastCreateRequestKey.current) return
    // Session restore owns the initial tab snapshot. Queue shortcut requests
    // until it lands so an older list response cannot erase a newly opened tab.
    if (!loaded) return
    lastCreateRequestKey.current = createRequestKey
    setAutoCreated(true)
    void createTerminal()
  }, [createRequestKey, createTerminal, loaded])

  useEffect(() => {
    if (findRequestKey <= lastFindRequestKey.current) return
    lastFindRequestKey.current = findRequestKey
    setFindOpen(true)
    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }, [findRequestKey])

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const remaining = tabsRef.current.filter((tab) => tab.session.id !== terminalId)
      setActiveId((current) =>
        current === terminalId ? nextActiveTabId(tabsRef.current, terminalId) : current,
      )
      setTabs(remaining)
      tabsRef.current = remaining
      viewRefs.current.delete(terminalId)
      void api.closeTerminal(terminalId).catch(() => undefined)
      if (remaining.length === 0) {
        // Closing the last tab folds the panel away, and the next ⌘J starts
        // a fresh shell instead of landing on an empty strip.
        setAutoCreated(false)
        onHide()
      }
    },
    [api, onHide],
  )

  useEffect(() => {
    if (activeId && tabs.some((tab) => tab.session.id === activeId)) return
    setActiveId(tabs.at(-1)?.session.id ?? null)
  }, [activeId, tabs])

  useEffect(() => {
    if (!visible || !activeId) return
    const view = viewRefs.current.get(activeId)
    view?.reactivate()
    view?.focus()
  }, [visible, activeId])

  const handleExited = useCallback((terminalId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.session.id === terminalId ? { ...tab, status: 'exited' as const } : tab,
      ),
    )
  }, [])

  const handleTitleChange = useCallback((terminalId: string, title: string) => {
    const normalized = title.trim()
    if (!normalized) return
    setTabs((current) =>
      current.map((tab) =>
        tab.session.id === terminalId ? { ...tab, observedTitle: normalized } : tab,
      ),
    )
  }, [])

  const cycleTab = useCallback((offset: -1 | 1) => {
    const next = adjacentTabId(tabsRef.current, activeId, offset)
    if (next) setActiveId(next)
  }, [activeId])

  const runFind = useCallback(
    (backwards = false) => {
      const view = activeId ? viewRefs.current.get(activeId) : undefined
      if (!findQuery || !view) {
        setFindFound(findQuery ? false : null)
        return
      }
      const found = backwards ? view.findPrevious(findQuery) : view.findNext(findQuery)
      setFindFound(found)
    },
    [activeId, findQuery],
  )

  const closeFind = useCallback(() => {
    const view = activeId ? viewRefs.current.get(activeId) : undefined
    setFindOpen(false)
    setFindFound(null)
    view?.clearSearch()
    view?.focus()
  }, [activeId])

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (!visible || event.repeat) return
      const target = event.target
      const inPanel = target instanceof Node && panelRef.current?.contains(target)
      if (!inPanel) return
      const jumpIndex = tabIndexForKeyEvent(event, tabsRef.current.length)
      if (jumpIndex !== null) {
        event.preventDefault()
        const tab = tabsRef.current[jumpIndex]
        if (tab) setActiveId(tab.session.id)
        return
      }
      const command = commandForEvent('terminal', event, shortcutSettings)
      if (!command) return
      // ⌘W is also the native Close Window accelerator; preventDefault here
      // keeps WKWebView from forwarding it to the menu.
      event.preventDefault()
      switch (command) {
        case 'terminalNewTab':
          void createTerminal()
          break
        case 'terminalCloseTab':
          if (activeId) closeTerminal(activeId)
          break
        case 'terminalNextTab':
          cycleTab(1)
          break
        case 'terminalPreviousTab':
          cycleTab(-1)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [activeId, closeTerminal, createTerminal, cycleTab, shortcutSettings, visible])

  return (
    <section
      ref={panelRef}
      aria-label="Terminal"
      data-terminal-panel=""
      className="flex h-full min-h-0 flex-col bg-surface-0"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <span className="ml-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          Terminal
        </span>
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          data-terminal-tabs=""
        >
          {tabs.map((tab) => {
            const isActive = tab.session.id === activeId
            return (
              <div key={tab.session.id} data-terminal-tab="" className="flex items-center">
                <button
                  type="button"
                  data-active={isActive || undefined}
                  data-status={tab.status}
                  onClick={() => setActiveId(tab.session.id)}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-2 data-[active=true]:bg-surface-2 data-[active=true]:text-fg-primary"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      tab.status === 'exited' ? 'bg-fg-muted' : 'bg-accent',
                    )}
                  />
                  <span className="max-w-40 truncate">{terminalTabLabel(tab)}</span>
                  {tab.status === 'exited' ? (
                    <span className="text-[10px] text-fg-muted">exited</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${terminalTabLabel(tab)}`}
                  data-terminal-tab-close=""
                  onClick={() => closeTerminal(tab.session.id)}
                  className="rounded p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg-primary"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
        <Tooltip label="Find in terminal">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Find in terminal"
            onClick={() => {
              setFindOpen(true)
              requestAnimationFrame(() => findInputRef.current?.focus())
            }}
          >
            <Search aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip
          label="New terminal"
          shortcut={shortcutHintTokens('terminalNewTab', shortcutSettings)}
        >
          <button
            type="button"
            aria-label="New terminal"
            data-terminal-new=""
            onClick={() => void createTerminal()}
            disabled={!workspaceId || creating}
            className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg-primary disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip
          label="Hide terminal"
          shortcut={shortcutHintTokens('toggleTerminal', shortcutSettings)}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Hide terminal"
            onClick={onHide}
          >
            <PanelBottomClose aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
      {findOpen ? (
        <div
          role="search"
          aria-label="Find in terminal"
          className="flex items-center gap-1 border-b border-border-subtle bg-surface-2 px-2 py-1"
          onKeyDown={(event) => {
            // Only the keys the find bar consumes stop here; ⌘T, ⌘W and the
            // other panel shortcuts still reach the window handler.
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeFind()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              runFind(event.shiftKey)
            }
          }}
        >
          <label className="fd-focus-within flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-2">
            <Search className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.target.value)
                setFindFound(null)
              }}
              placeholder="Find in terminal"
              aria-label="Find text"
              className="h-7 min-w-0 flex-1 bg-transparent text-[length:var(--fd-text-sm)] text-fg-primary outline-none placeholder:text-fg-muted"
            />
            {findFound === false ? (
              <span className="text-[length:var(--fd-text-2xs)] text-danger">No match</span>
            ) : null}
          </label>
          <button
            type="button"
            className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
            aria-label="Previous match"
            onClick={() => runFind(true)}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
            aria-label="Next match"
            onClick={() => runFind(false)}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
            aria-label="Close find"
            onClick={closeFind}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        {!workspaceId ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            Select a project to open a terminal.
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-danger">{error}</div>
        ) : tabs.length > 0 ? (
          tabs.map((tab) => {
            const isActive = tab.session.id === activeId
            return (
              <div
                key={tab.session.id}
                className={cn(
                  'h-full w-full',
                  isActive ? 'relative z-[1]' : 'invisible absolute inset-0 pointer-events-none',
                )}
                inert={!isActive}
                aria-hidden={isActive ? undefined : true}
              >
                <TerminalView
                  ref={(handle) => {
                    if (handle) viewRefs.current.set(tab.session.id, handle)
                    else viewRefs.current.delete(tab.session.id)
                  }}
                  session={tab.session}
                  active={isActive && visible}
                  socketUrl={api.terminalSocketUrl(tab.session.id)}
                  onExited={() => handleExited(tab.session.id)}
                  onTitleChange={(title) => handleTitleChange(tab.session.id, title)}
                />
              </div>
            )
          })
        ) : !loaded || creating || !autoCreated ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted"
            />
            Starting terminal…
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-fg-muted">
            <span>No open terminals</span>
            <span className="flex items-center gap-1.5 text-[length:var(--fd-text-xs)]">
              Press
              {(shortcutHintTokens('terminalNewTab', shortcutSettings) ?? ['⌘', 'T']).map(
                (token, index) => (
                  <Kbd key={`${token}-${index}`}>{token}</Kbd>
                ),
              )}
              to start one
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
