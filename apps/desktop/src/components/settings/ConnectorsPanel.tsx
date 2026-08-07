import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  cn,
} from '@falcondeck/ui'
import { ClipboardPaste, Globe, LoaderCircle, Plug, Plus, Trash2, X } from 'lucide-react'

export type ConnectorEntry = {
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  enabled?: boolean
  providers?: string[]
}

type ConnectorsOverview = {
  global: Record<string, ConnectorEntry>
  workspace: Record<string, ConnectorEntry> | null
  merged: Array<ConnectorEntry & { name: string; scope: 'global' | 'workspace' }>
}

export type ConnectorsPanelProps = {
  baseUrl: string | null
  workspaces: Array<{ id: string; path: string }>
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

function workspaceLabel(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path
}

function entrySummary(entry: ConnectorEntry) {
  if (entry.command) {
    return [entry.command, ...(entry.args ?? [])].join(' ')
  }
  return entry.url ?? ''
}

/** Accepts either `{"mcpServers": {...}}` or a bare name→entry map. */
function parseImportedServers(text: string): Record<string, ConnectorEntry> {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const map =
    parsed && typeof parsed === 'object' && 'mcpServers' in parsed
      ? (parsed.mcpServers as Record<string, ConnectorEntry>)
      : (parsed as Record<string, ConnectorEntry>)
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('expected an object of server entries')
  }
  for (const [name, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object') throw new Error(`entry "${name}" is not an object`)
    if (!entry.command && !entry.url) throw new Error(`entry "${name}" needs a command or url`)
  }
  return map
}

function parseKeyValueLines(text: string, separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf(separator)
    if (index <= 0) continue
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return result
}

export function ConnectorsPanel({ baseUrl, workspaces, onToast }: ConnectorsPanelProps) {
  const [scope, setScope] = useState<string>('global')
  const [overview, setOverview] = useState<ConnectorsOverview | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [isImporting, setIsImporting] = useState(false)

  const isWorkspaceScope = scope !== 'global'

  const load = useCallback(async () => {
    if (!baseUrl) return
    setIsLoading(true)
    setLoadError(null)
    try {
      const query = scope === 'global' ? '' : `?workspace_id=${encodeURIComponent(scope)}`
      const response = await fetch(`${baseUrl}/api/connectors${query}`)
      if (!response.ok) throw new Error(`daemon returned ${response.status}`)
      setOverview((await response.json()) as ConnectorsOverview)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoading(false)
    }
  }, [baseUrl, scope])

  useEffect(() => {
    void load()
  }, [load])

  const writeScope = useCallback(
    async (
      targetScope: 'global' | 'workspace',
      mutate: (servers: Record<string, ConnectorEntry>) => Record<string, ConnectorEntry>,
    ) => {
      if (!baseUrl || !overview) return false
      const current =
        targetScope === 'global' ? overview.global : (overview.workspace ?? {})
      try {
        const response = await fetch(`${baseUrl}/api/connectors`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: targetScope,
            workspace_id: targetScope === 'workspace' ? scope : undefined,
            mcpServers: mutate({ ...current }),
          }),
        })
        if (!response.ok) {
          const body = await response.text()
          throw new Error(body || `daemon returned ${response.status}`)
        }
        await load()
        return true
      } catch (error) {
        onToast({
          variant: 'danger',
          title: 'Could not save connectors',
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    },
    [baseUrl, load, onToast, overview, scope],
  )

  const rows = useMemo(() => {
    if (!overview) return []
    if (!isWorkspaceScope) {
      return Object.entries(overview.global).map(([name, entry]) => ({
        ...entry,
        name,
        scope: 'global' as const,
      }))
    }
    return overview.merged
  }, [overview, isWorkspaceScope])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          Connectors
        </h1>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
          MCP servers give your agents tools. Configure a server once and every agent — Claude,
          Codex, and any custom provider — can use it.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>MCP servers</CardTitle>
            <CardDescription>
              {isWorkspaceScope
                ? 'Workspace entries override global entries with the same name.'
                : 'Global servers apply to every workspace on this machine.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setIsImporting((value) => !value)}>
              <ClipboardPaste className="h-4 w-4" />
              Paste JSON
            </Button>
            <Button size="sm" onClick={() => setIsAdding((value) => !value)}>
              {isAdding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {isAdding ? 'Close' : 'Add server'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ScopeChip active={!isWorkspaceScope} label="Global" onClick={() => setScope('global')} />
            {workspaces.map((workspace) => (
              <ScopeChip
                key={workspace.id}
                active={scope === workspace.id}
                label={workspaceLabel(workspace.path)}
                onClick={() => setScope(workspace.id)}
              />
            ))}
          </div>

          {isImporting ? (
            <ImportJsonForm
              onCancel={() => setIsImporting(false)}
              onImport={async (servers) => {
                const ok = await writeScope(
                  isWorkspaceScope ? 'workspace' : 'global',
                  (current) => ({ ...current, ...servers }),
                )
                if (ok) {
                  setIsImporting(false)
                  onToast({
                    variant: 'success',
                    title: `Imported ${Object.keys(servers).length} server${Object.keys(servers).length === 1 ? '' : 's'}`,
                  })
                }
              }}
            />
          ) : null}

          {isAdding ? (
            <AddConnectorForm
              onCancel={() => setIsAdding(false)}
              onAdd={async (name, entry) => {
                const ok = await writeScope(
                  isWorkspaceScope ? 'workspace' : 'global',
                  (current) => ({ ...current, [name]: entry }),
                )
                if (ok) {
                  setIsAdding(false)
                  onToast({ variant: 'success', title: `Added ${name}` })
                }
              }}
            />
          ) : null}

          {isLoading && !overview ? (
            <div className="flex items-center gap-2 px-2 py-6 text-[length:var(--fd-text-sm)] text-fg-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading connectors…
            </div>
          ) : loadError ? (
            <p className="px-2 py-4 text-[length:var(--fd-text-sm)] text-danger">{loadError}</p>
          ) : rows.length === 0 && !isAdding && !isImporting ? (
            <div className="flex flex-col items-center gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-subtle px-6 py-10 text-center">
              <Plug className="h-6 w-6 text-fg-muted" />
              <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                No MCP servers yet. Add one, or paste a config from any server&apos;s README.
              </p>
            </div>
          ) : (
            rows.map((row) => (
              <ConnectorRow
                key={`${row.scope}:${row.name}`}
                row={row}
                onToggle={() =>
                  writeScope(row.scope, (current) => ({
                    ...current,
                    [row.name]: { ...current[row.name], enabled: row.enabled === false },
                  }))
                }
                onRemove={() => {
                  if (!window.confirm(`Remove the "${row.name}" MCP server?`)) return
                  void writeScope(row.scope, (current) => {
                    const next = { ...current }
                    delete next[row.name]
                    return next
                  })
                }}
              />
            ))
          )}
        </CardContent>
      </Card>

      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
        Stored in <code>~/.falcondeck/connectors.json</code> and{' '}
        <code>&lt;workspace&gt;/.falcondeck/connectors.json</code>. Changes apply on the next turn —
        no restart needed. See docs/CONNECTORS.md for the format.
      </p>
    </div>
  )
}

function ScopeChip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-[length:var(--fd-text-xs)] transition-colors',
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border-subtle text-fg-secondary hover:border-border-emphasis',
      )}
    >
      {label}
    </button>
  )
}

function ConnectorRow({
  row,
  onToggle,
  onRemove,
}: {
  row: ConnectorEntry & { name: string; scope: 'global' | 'workspace' }
  onToggle: () => void
  onRemove: () => void
}) {
  const enabled = row.enabled !== false
  return (
    <div className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
      {row.url ? (
        <Globe className="h-4 w-4 shrink-0 text-fg-muted" />
      ) : (
        <Plug className="h-4 w-4 shrink-0 text-fg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
            {row.name}
          </span>
          <Badge variant={row.scope === 'workspace' ? 'info' : 'default'}>
            {row.scope === 'workspace' ? 'Workspace' : 'Global'}
          </Badge>
          {row.providers && row.providers.length > 0 ? (
            <span className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
              {row.providers.join(', ')} only
            </span>
          ) : null}
        </div>
        <p className="truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
          {entrySummary(row)}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${row.name}`}
        onClick={onToggle}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          enabled ? 'bg-accent' : 'bg-surface-4',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
            enabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <Button size="icon" variant="ghost" aria-label={`Remove ${row.name}`} onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

function ImportJsonForm({
  onImport,
  onCancel,
}: {
  onImport: (servers: Record<string, ConnectorEntry>) => Promise<void>
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  return (
    <div className="space-y-2 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-4">
      <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
        Paste an MCP config
      </p>
      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
        Accepts the standard <code>{'{"mcpServers": {...}}'}</code> shape or a bare name-to-entry
        map. Imported entries merge into the selected scope.
      </p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        spellCheck={false}
        className="w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-3 font-mono text-[length:var(--fd-text-xs)] text-fg-primary outline-none focus:border-accent"
        placeholder='{"mcpServers": {"linear": {"command": "npx", "args": ["-y", "@linear/mcp-server"]}}}'
      />
      {error ? <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={isBusy || text.trim().length === 0}
          onClick={async () => {
            setError(null)
            setIsBusy(true)
            try {
              await onImport(parseImportedServers(text))
            } catch (importError) {
              setError(importError instanceof Error ? importError.message : String(importError))
            } finally {
              setIsBusy(false)
            }
          }}
        >
          {isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Import
        </Button>
      </div>
    </div>
  )
}

function AddConnectorForm({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, entry: ConnectorEntry) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'command' | 'url'>('command')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  const canSubmit =
    name.trim().length > 0 &&
    (mode === 'command' ? command.trim().length > 0 : url.trim().length > 0)

  return (
    <div className="space-y-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-4">
      <div className="flex items-center gap-2">
        <ScopeChip active={mode === 'command'} label="Command" onClick={() => setMode('command')} />
        <ScopeChip active={mode === 'url'} label="URL" onClick={() => setMode('url')} />
      </div>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name (e.g. linear)"
      />
      {mode === 'command' ? (
        <>
          <Input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Command (e.g. npx -y @linear/mcp-server)"
            className="font-mono"
          />
          <textarea
            value={envText}
            onChange={(event) => setEnvText(event.target.value)}
            rows={2}
            spellCheck={false}
            className="w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-3 font-mono text-[length:var(--fd-text-xs)] text-fg-primary outline-none focus:border-accent"
            placeholder={'Environment (optional)\nLINEAR_API_KEY=lin_api_…'}
          />
        </>
      ) : (
        <>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mcp.example.com/mcp"
            className="font-mono"
          />
          <textarea
            value={headersText}
            onChange={(event) => setHeadersText(event.target.value)}
            rows={2}
            spellCheck={false}
            className="w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-3 font-mono text-[length:var(--fd-text-xs)] text-fg-primary outline-none focus:border-accent"
            placeholder={'Headers (optional)\nAuthorization: Bearer …'}
          />
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSubmit || isBusy}
          onClick={async () => {
            setIsBusy(true)
            try {
              const entry: ConnectorEntry =
                mode === 'command'
                  ? (() => {
                      const [bin, ...args] = command.trim().split(/\s+/)
                      return { command: bin, args, env: parseKeyValueLines(envText, '=') }
                    })()
                  : { url: url.trim(), headers: parseKeyValueLines(headersText, ':') }
              await onAdd(name.trim(), entry)
            } finally {
              setIsBusy(false)
            }
          }}
        >
          {isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Add server
        </Button>
      </div>
    </div>
  )
}
