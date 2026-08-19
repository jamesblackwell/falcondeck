import { useCallback, useEffect, useState } from 'react'

import {
  ActivityDiamond,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@falcondeck/ui'
import { Bot, Plus, Trash2, X } from 'lucide-react'

type ProviderEntry = {
  label?: string
  command?: string[]
  env?: Record<string, string>
  transport?: 'auto' | 'native' | 'acp'
}

type ProvidersOverview = {
  providers: Record<string, ProviderEntry>
  resolved: Array<{
    id: string
    label: string
    command: string[]
    binary_found: boolean
    reserved: boolean
    /** Entry the daemon cannot parse (e.g. command is not an array). */
    malformed?: boolean
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

const RECOMMENDED_AGENTS = [
  {
    id: 'cursor',
    label: 'Cursor',
    detail: 'Cursor\'s agent CLI through its built-in ACP server',
    command: ['cursor-agent', 'acp'],
    transport: undefined,
    installCommand: 'curl -fsSL https://cursor.com/install | bash',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    detail: 'Native steering with automatic fallback to its built-in ACP server',
    command: ['opencode', 'acp'],
    transport: 'auto' as const,
    installCommand: 'curl -fsSL https://opencode.ai/install | bash',
  },
  {
    id: 'pi',
    label: 'Pi',
    detail: 'Minimal, extensible coding harness through the maintained pi-acp adapter',
    command: ['pi-acp'],
    transport: undefined,
    installCommand:
      'npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp',
  },
]

export function AgentsPanel({ baseUrl, onToast }: AgentsPanelProps) {
  const [overview, setOverview] = useState<ProvidersOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const configuredProviderIds = new Set(overview?.resolved.map((provider) => provider.id))

  const load = useCallback(async () => {
    if (!baseUrl) return
    setLoadError(null)
    setIsLoading(true)
    try {
      const response = await fetch(`${baseUrl}/api/providers`)
      if (!response.ok) throw new Error(`daemon returned ${response.status}`)
      setOverview((await response.json()) as ProvidersOverview)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoading(false)
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
        <CardHeader>
          <CardTitle>Recommended</CardTitle>
          <CardDescription>
            Maintained agent adapters that work with FalconDeck&apos;s shared conversation experience.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {RECOMMENDED_AGENTS.map((agent) => {
            const isConfigured = configuredProviderIds.has(agent.id)
            return (
              <div
                key={agent.id}
                className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
              >
                <Bot className="h-4 w-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                      {agent.label}
                    </span>
                    <Badge variant="default">
                      {agent.id === 'opencode' ? 'Native + ACP' : 'ACP'}
                    </Badge>
                  </div>
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{agent.detail}</p>
                  {!isConfigured ? (
                    <p className="mt-1 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                      {agent.installCommand}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant={isConfigured ? 'secondary' : 'default'}
                  disabled={!overview || isConfigured}
                  onClick={() => {
                    void write((providers) => ({
                      ...providers,
                      [agent.id]: {
                        label: agent.label,
                        command: agent.command,
                        ...(agent.transport ? { transport: agent.transport } : {}),
                      },
                    })).then((ok) => {
                      if (ok) {
                        onToast({
                          variant: 'success',
                          title: `${agent.label} configured`,
                          description:
                            agent.id === 'opencode'
                              ? 'FalconDeck will try OpenCode native and fall back to ACP on this host.'
                              : `FalconDeck will run ${agent.command.join(' ')} on this host.`,
                        })
                      }
                    })
                  }}
                >
                  {isConfigured ? 'Configured' : `Configure ${agent.label}`}
                </Button>
              </div>
            )
          })}
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
          ) : isLoading && !overview ? (
            // "No custom agents yet" is a claim about the daemon's answer, so
            // it must not be made before the answer arrives.
            <div className="flex items-center justify-center gap-2 px-2 py-10 text-[length:var(--fd-text-sm)] text-fg-muted">
              <ActivityDiamond size="md" />
              Loading agents…
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
                    <Badge
                      variant={
                        provider.malformed
                          ? 'danger'
                          : provider.binary_found
                            ? 'success'
                            : 'warning'
                      }
                    >
                      {provider.malformed
                        ? 'Invalid entry'
                        : provider.binary_found
                          ? 'Installed'
                          : 'Binary not found'}
                    </Badge>
                  </div>
                  <p className="truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                    {provider.malformed
                      ? 'Unreadable command — edit providers.json or remove this entry'
                      : provider.command.join(' ')}
                  </p>
                </div>
                {provider.id === 'opencode' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const current = overview.providers[provider.id]
                      const useAcp = current?.transport !== 'acp'
                      void write((providers) => ({
                        ...providers,
                        [provider.id]: {
                          ...providers[provider.id],
                          transport: useAcp ? 'acp' : 'auto',
                        },
                      })).then((ok) => {
                        if (ok) {
                          onToast({
                            variant: 'success',
                            title: useAcp
                              ? 'OpenCode switched to ACP'
                              : 'OpenCode native enabled',
                            description:
                              'The change applies to new threads; existing threads stay on their original transport.',
                          })
                        }
                      })
                    }}
                  >
                    {overview.providers[provider.id]?.transport === 'acp'
                      ? 'Try native'
                      : 'Use ACP'}
                  </Button>
                ) : null}
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
          aria-label="Agent id"
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="Id (e.g. opencode)"
        />
        <Input
          aria-label="Agent label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label (e.g. OpenCode)"
        />
      </div>
      <Input
        aria-label="ACP command"
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
          {isBusy ? <ActivityDiamond size="md" tone="current" /> : null}
          Add agent
        </Button>
      </div>
    </div>
  )
}
