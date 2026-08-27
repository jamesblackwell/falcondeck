import type {
  FalconDeckPreferences,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import { Badge, Button, SettingsSection } from '@falcondeck/ui'
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react'

const DEFAULT_PROVIDER_ORDER = ['claude', 'codex', 'opencode', 'grok']
const DEFAULT_MODELS = [{ provider: 'claude', model_id: 'haiku' }]

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
}

type BackgroundModelsCardProps = {
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

/**
 * Thread titles run on a cheap model out of band. Most users have only one
 * agent CLI installed, so the chain matters more than any single choice —
 * the first provider that is installed and signed in wins.
 */
export function BackgroundModelsCard({
  workspace,
  preferences,
  onUpdatePreferences,
}: BackgroundModelsCardProps) {
  // Callers pass normalized preferences, so this only guards the type.
  const utility = preferences.utility_models ?? {
    provider_order: DEFAULT_PROVIDER_ORDER,
    models: DEFAULT_MODELS,
  }
  const order = utility.provider_order
  const modelFor = (provider: string) =>
    utility.models.find((choice) => choice.provider === provider)?.model_id ?? ''
  const agentFor = (provider: string) =>
    workspace?.agents.find((agent) => agent.provider === provider) ?? null

  const move = (provider: string, direction: -1 | 1) => {
    const index = order.indexOf(provider)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    const next = [...order]
    next[index] = next[target]
    next[target] = provider
    onUpdatePreferences({ utility_models: { provider_order: next } })
  }

  const setModel = (provider: string, modelId: string) => {
    const others = utility.models.filter(
      (choice) => choice.provider !== provider,
    )
    onUpdatePreferences({
      utility_models: {
        models: [...others, { provider, model_id: modelId.trim() }],
      },
    })
  }

  return (
    <SettingsSection
      title="Background models"
      description="FalconDeck runs its own short, tool-free jobs — currently thread titles — on the first provider below that is installed and signed in. Pick each provider's cheapest model; leave a model blank to use that CLI's own default."
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onUpdatePreferences({
              utility_models: {
                provider_order: DEFAULT_PROVIDER_ORDER,
                models: DEFAULT_MODELS,
              },
            })
          }
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </Button>
      }
      contentClassName="space-y-2"
    >
        {order.map((provider, index) => {
          const agent = agentFor(provider)
          const ready = agent?.account.status === 'ready'
          const listId = `utility-models-${provider}`
          return (
            <div
              key={provider}
              className="flex flex-wrap items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-4 py-3"
            >
              <div className="flex min-w-[10rem] flex-1 items-center gap-3">
                <span className="text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">
                  {index + 1}
                </span>
                <div>
                  <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    {agent?.label ?? PROVIDER_LABELS[provider] ?? provider}
                  </p>
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{provider}</p>
                </div>
                <Badge variant={ready ? 'success' : 'default'} dot>
                  {ready ? 'Signed in' : 'Unavailable here'}
                </Badge>
              </div>
              <label className="flex items-center gap-2">
                <span className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                  Model
                </span>
                <input
                  type="text"
                  list={listId}
                  defaultValue={modelFor(provider)}
                  placeholder="Provider default"
                  aria-label={`${PROVIDER_LABELS[provider] ?? provider} background model`}
                  onBlur={(event) => {
                    if (event.target.value.trim() !== modelFor(provider))
                      setModel(provider, event.target.value)
                  }}
                  className="w-56 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-primary"
                />
                <datalist id={listId}>
                  {(agent?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </datalist>
              </label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Move ${provider} earlier`}
                  disabled={index === 0}
                  onClick={() => move(provider, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Move ${provider} later`}
                  disabled={index === order.length - 1}
                  onClick={() => move(provider, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )
        })}
    </SettingsSection>
  )
}
