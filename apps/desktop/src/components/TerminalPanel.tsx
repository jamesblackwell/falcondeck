import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PanelBottomClose } from 'lucide-react'
import { createDaemonApiClient } from '@falcondeck/client-core'
import { Button, Tooltip } from '@falcondeck/ui'
import { TerminalView } from './TerminalView'
import { nextActiveTabId, terminalTabLabel, type TerminalTab } from '../terminal-tabs'
import { shortcutHintTokens, useShortcutSettings } from '../shortcuts'

const DEFAULT_TERMINAL_COLS = 100
const DEFAULT_TERMINAL_ROWS = 30

interface TerminalPanelProps {
  baseUrl: string
  workspaceId: string | null
  onHide: () => void
}

export function TerminalPanel({ baseUrl, workspaceId, onHide }: TerminalPanelProps) {
  const api = useMemo(() => createDaemonApiClient(baseUrl), [baseUrl])
  const shortcutSettings = useShortcutSettings()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards the auto-create in StrictMode double-effects and against racing
  // the tab list restore.
  const autoCreateRef = useRef(false)
  const tabsRef = useRef<TerminalTab[]>([])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    if (!workspaceId) {
      setLoaded(true)
      return
    }
    let cancelled = false
    autoCreateRef.current = false
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
    if (!workspaceId || creating) return
    setCreating(true)
    setError(null)
    try {
      const { session } = await api.openTerminal(workspaceId, {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      })
      setTabs((current) => {
        if (current.some((tab) => tab.session.id === session.id)) return current
        return [...current, { session, status: 'running' as const, observedTitle: null }]
      })
      setActiveId(session.id)
    } catch {
      setError('Could not start a terminal.')
    } finally {
      setCreating(false)
    }
  }, [api, creating, workspaceId])

  // A fresh panel with no live sessions starts one, so Cmd+J always lands in
  // a usable shell. A failed tab-list load suppresses this: the daemon was
  // just unreachable, so spawning needs an explicit user action.
  useEffect(() => {
    if (!loaded || !workspaceId || error || autoCreateRef.current) return
    if (tabs.length > 0 || creating) return
    autoCreateRef.current = true
    void createTerminal()
  }, [createTerminal, creating, error, loaded, tabs.length, workspaceId])

  const closeTerminal = useCallback(
    (terminalId: string) => {
      setActiveId((current) =>
        current === terminalId ? nextActiveTabId(tabsRef.current, terminalId) : current,
      )
      setTabs((current) => current.filter((tab) => tab.session.id !== terminalId))
      void api.closeTerminal(terminalId).catch(() => undefined)
    },
    [api],
  )

  // Keep the active selection pointing at a tab that still exists.
  useEffect(() => {
    if (activeId && tabs.some((tab) => tab.session.id === activeId)) return
    setActiveId(tabs.at(-1)?.session.id ?? null)
  }, [activeId, tabs])

  const activeTab = tabs.find((tab) => tab.session.id === activeId) ?? null

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

  return (
    <section
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
                  ×
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          aria-label="New terminal"
          data-terminal-new=""
          onClick={() => void createTerminal()}
          disabled={!workspaceId || creating}
          className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg-primary disabled:opacity-40"
        >
          +
        </button>
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
      <div className="min-h-0 flex-1 overflow-hidden">
        {!workspaceId ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            Select a project to open a terminal.
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-danger">{error}</div>
        ) : activeTab ? (
          <TerminalView
            key={activeTab.session.id}
            session={activeTab.session}
            socketUrl={api.terminalSocketUrl(activeTab.session.id)}
            onExited={() => handleExited(activeTab.session.id)}
            onTitleChange={(title) => handleTitleChange(activeTab.session.id, title)}
          />
        ) : loaded ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            No terminals
          </div>
        ) : null}
      </div>
    </section>
  )
}
