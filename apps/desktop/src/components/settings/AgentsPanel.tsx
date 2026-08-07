import { useCallback, useEffect, useState } from 'react'

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@falcondeck/ui'
import { Bot, LoaderCircle, Plus, Trash2, X } from 'lucide-react'

type ProviderEntry = {
  label?: string
  command?: string[]
}

type ProvidersOverview = {
  providers: Record<string, ProviderEntry>
  resolved: Array<{
    id: string
    label: string
    command: string[]
    binary_found: boolean
    reserved: boolean
  }>
}

export type AgentsPanelProps = {
  baseUrl: string | null
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

const BUILT_IN_AGENTS = [
  { id: 'codex', label: 'Codex', detail: 'OpenAI Codex CLI, full integration' },
  { id: 'claude', label: 'Claude', detail: 'Claude Code CLI, full integration' },
]

export function AgentsPanel({ baseUrl, onToast }: AgentsPanelProps) {
  const [overview, setOverview] = useState<ProvidersOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)

  const load = useCallback(async () => {
    if (!baseUrl) return
    setLoadError(null)
    try {
      const response = await fetch(`${baseUrl}/api/providers`)
      if (!response.ok) throw new Error(`daemon returned ${response.status}`)
      setOverview((await response.json()) as ProvidersOverview)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  const write = useCallback(
    async (
      mutate: (providers: Record<string, ProviderEntry>) => Record<string, ProviderEntry>,
    ) => {
      if (!baseUrl) return false
      if (!overview) {
        onToast({
          variant: 'warning',
          title: 'Agents not loaded yet',
          description: 'Wait for the list to load (or retry), then make the change again.',
        })
        return false
      }
      try {
        const response = await fetch(`${baseUrl}/api/providers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: mutate({ ...overview.providers }) }),
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
          title: 'Could not save agents',
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    },
    [baseUrl, load, onToast, overview],
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">Agents</h1>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
          FalconDeck orchestrates agents; it doesn&apos;t replace them. Codex and Claude are built
          in — any CLI speaking the Agent Client Protocol (OpenCode, Grok, Gemini CLI, …) can be
          added here. Changes apply immediately, no restart needed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Built in</CardTitle>
          <CardDescription>Native integrations with the deepest feature support.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {BUILT_IN_AGENTS.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
            >
              <Bot className="h-4 w-4 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {agent.label}
                </span>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{agent.detail}</p>
              </div>
              <Badge variant="success">Built in</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Custom agents (ACP)</CardTitle>
            <CardDescription>
              Declared in <code>~/.falcondeck/providers.json</code>; agents whose binary isn&apos;t
              installed stay hidden from pickers until it appears.
            </CardDescription>
          </div>
          <Button size="sm" disabled={!overview} onClick={() => setIsAdding((value) => !value)}>
            {isAdding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {isAdding ? 'Close' : 'Add agent'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdding ? (
            <AddAgentForm
              onCancel={() => setIsAdding(false)}
              onAdd={async (id, entry) => {
                const ok = await write((providers) => ({ ...providers, [id]: entry }))
                if (ok) {
                  setIsAdding(false)
                  onToast({ variant: 'success', title: `Added ${entry.label ?? id}` })
                }
              }}
            />
          ) : null}
          {loadError ? (
            <div className="flex items-center gap-3 px-2 py-4">
              <p className="text-[length:var(--fd-text-sm)] text-danger">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : !overview || overview.resolved.length === 0 ? (
            !isAdding ? (
              <div className="flex flex-col items-center gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-subtle px-6 py-10 text-center">
                <Bot className="h-6 w-6 text-fg-muted" />
                <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                  No custom agents yet. Add any ACP-speaking CLI to use it like a built-in.
                </p>
              </div>
            ) : null
          ) : (
            overview.resolved.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
              >
                <Bot className="h-4 w-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                      {provider.label}
                    </span>
                    <Badge variant={provider.binary_found ? 'success' : 'warning'}>
                      {provider.binary_found ? 'Installed' : 'Binary not found'}
                    </Badge>
                  </div>
                  <p className="truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                    {provider.command.join(' ')}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${provider.label}`}
                  onClick={() => {
                    if (!window.confirm(`Remove the "${provider.label}" agent?`)) return
                    void write((providers) => {
                      const next = { ...providers }
                      delete next[provider.id]
                      return next
                    })
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AddAgentForm({
  onAdd,
  onCancel,
}: {
  onAdd: (id: string, entry: { label: string; command: string[] }) => Promise<void>
  onCancel: () => void
}) {
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [command, setCommand] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  const normalizedId = id.trim().toLowerCase()
  const canSubmit =
    normalizedId.length > 0 &&
    !['codex', 'claude'].includes(normalizedId) &&
    command.trim().length > 0

  return (
    <div className="space-y-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Input
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="Id (e.g. opencode)"
        />
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label (e.g. OpenCode)"
        />
      </div>
      <Input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        placeholder="ACP command (e.g. opencode acp)"
        className="font-mono"
      />
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
              await onAdd(normalizedId, {
                label: label.trim() || normalizedId,
                command: command.trim().split(/\s+/),
              })
            } finally {
              setIsBusy(false)
            }
          }}
        >
          {isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Add agent
        </Button>
      </div>
    </div>
  )
}
