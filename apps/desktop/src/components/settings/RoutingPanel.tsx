import type {
  FalconDeckPreferences,
  RouteDecision,
  RoutingPreferences,
  RoutingRule,
  RoutingTarget,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingList,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
  Textarea,
} from '@falcondeck/ui'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

const ANY = 'any'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  cursor: 'Cursor',
  agy: 'Antigravity',
}

type RoutingPanelProps = {
  baseUrl: string | null
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

function move<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction
  if (target < 0 || target >= list.length) return list
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function describeTarget(target: RoutingTarget) {
  return [
    PROVIDER_LABELS[target.provider] ?? target.provider,
    target.model_id,
    target.reasoning_effort ? `(${target.reasoning_effort})` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

/** Auto routing: Jev classifies a brief once, then these rules pick the
 * harness, model and effort. Agents opt in with `model: "auto"`. */
export function RoutingPanel({
  baseUrl,
  workspace,
  preferences,
  onUpdatePreferences,
}: RoutingPanelProps) {
  const saved = preferences?.routing ?? null
  const [draft, setDraft] = useState<RoutingPreferences | null>(saved)
  const savedKey = JSON.stringify(saved)
  const dirty = draft !== null && JSON.stringify(draft) !== savedKey
  // The daemon normalizes what it stores, so after Save or Reset the next
  // saved value replaces the draft even if it differs from what was sent.
  const adoptNextSave = useRef(false)
  const save = (routing: RoutingPreferences) => {
    adoptNextSave.current = true
    onUpdatePreferences({ routing })
  }
  // Adopt saved changes (another client, Save, Reset) unless mid-edit.
  useEffect(() => {
    if (!dirty || adoptNextSave.current) {
      adoptNextSave.current = false
      setDraft(saved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])

  if (!saved || !draft) {
    return (
      <SettingsPage>
        <SettingsPageHeader title="Routing" description="This daemon is too old for auto routing. Update FalconDeck." />
      </SettingsPage>
    )
  }

  const update = (patch: Partial<RoutingPreferences>) => setDraft({ ...draft, ...patch })
  const setRule = (index: number, rule: RoutingRule) =>
    update({ rules: draft.rules.map((r, i) => (i === index ? rule : r)) })

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Routing"
        description='Agents that create a thread with model "auto" get a harness, model and effort picked for them. A classifier reads the brief once; the rules below decide, top to bottom.'
      />

      {dirty ? (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-[var(--fd-radius-lg)] border border-border-emphasis bg-surface-2 px-4 py-2.5 shadow-[var(--fd-shadow-sm)]">
          <span className="text-[length:var(--fd-text-sm)] text-fg-primary">Unsaved routing changes</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
            <Button size="sm" onClick={() => save(draft)}>
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <SettingsSection title="Auto routing">
        <SettingList>
          <SwitchRow
            title="Allow auto routing"
            description='When off, "auto" is refused and agents must name a model.'
            checked={draft.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </SettingList>
      </SettingsSection>

      <TryPrompt baseUrl={baseUrl} workspace={workspace} dirty={dirty} />

      <SettingsSection
        title="Rules"
        description="The first rule whose conditions match and that has a usable model wins. Models that are not installed, need sign-in, or whose subscription is over the usage limit are skipped."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              update({
                rules: [
                  ...draft.rules,
                  { label: 'New rule', task_types: [], targets: [{ provider: 'codex', model_id: 'gpt-6.1-sol', reasoning_effort: 'medium' }] },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" />
            Add rule
          </Button>
        }
        contentClassName="space-y-3"
      >
        {draft.rules.map((rule, index) => (
          <RuleCard
            key={index}
            rule={rule}
            index={index}
            count={draft.rules.length}
            taskTypes={draft.task_types.map((t) => t.id)}
            workspace={workspace}
            onChange={(next) => setRule(index, next)}
            onMove={(direction) => update({ rules: move(draft.rules, index, direction) })}
            onDelete={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Fallback"
        description="Used when no rule matches, the classifier is unsure, or it cannot be reached."
      >
        <TargetList
          targets={draft.fallback}
          workspace={workspace}
          onChange={(fallback) => update({ fallback })}
        />
      </SettingsSection>

      <SettingsSection title="Classifier" description="Uses the OpenRouter key from Models & keys. A classification costs a fraction of a cent and takes about a third of a second.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Decision model" htmlFor="routing-classifier">
            <Input
              id="routing-classifier"
              value={draft.classifier_model}
              onChange={(e) => update({ classifier_model: e.target.value })}
            />
          </Field>
          <Field label="Minimum confidence" htmlFor="routing-confidence" hint="Below this, use the fallback.">
            <PercentInput
              id="routing-confidence"
              value={draft.min_confidence_percent}
              onChange={(min_confidence_percent) => update({ min_confidence_percent })}
            />
          </Field>
          <Field label="Usage limit" htmlFor="routing-usage" hint="Skip a subscription at or above this use. 100 turns it off.">
            <PercentInput
              id="routing-usage"
              value={draft.usage_ceiling_percent}
              onChange={(usage_ceiling_percent) => update({ usage_ceiling_percent })}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Task types"
        description="The classifier picks one of these for each brief. Write descriptions the way you would explain the category to a person."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update({ task_types: [...draft.task_types, { id: '', description: '' }] })}
          >
            <Plus className="h-4 w-4" />
            Add type
          </Button>
        }
        contentClassName="space-y-2"
      >
        {draft.task_types.map((task, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              aria-label="Task type id"
              className="w-36 font-mono"
              value={task.id}
              onChange={(e) =>
                update({
                  task_types: draft.task_types.map((t, i) => (i === index ? { ...t, id: e.target.value } : t)),
                })
              }
            />
            <Input
              aria-label={`${task.id || 'Task type'} description`}
              className="flex-1"
              value={task.description}
              onChange={(e) =>
                update({
                  task_types: draft.task_types.map((t, i) =>
                    i === index ? { ...t, description: e.target.value } : t,
                  ),
                })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${task.id || 'task type'}`}
              onClick={() => update({ task_types: draft.task_types.filter((_, i) => i !== index) })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </SettingsSection>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          // The daemon fills every missing field with its default.
          onClick={() => save({} as RoutingPreferences)}
        >
          <RotateCcw className="h-4 w-4" />
          Reset routing to defaults
        </Button>
      </div>
    </SettingsPage>
  )
}

function PercentInput({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  return (
    <Input
      id={id}
      type="number"
      min={0}
      max={100}
      value={value}
      onChange={(e) => onChange(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
    />
  )
}

function TryPrompt({
  baseUrl,
  workspace,
  dirty,
}: {
  baseUrl: string | null
  workspace?: WorkspaceSummary | null
  dirty: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [decision, setDecision] = useState<RouteDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const route = async () => {
    if (!baseUrl || !workspace || !prompt.trim()) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${baseUrl}/api/routing/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id, prompt }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error ?? `Routing failed (${response.status})`)
      setDecision(body as RouteDecision)
    } catch (e) {
      setDecision(null)
      setError(e instanceof Error ? e.message : 'Routing failed')
    } finally {
      setBusy(false)
    }
  }

  const c = decision?.classification
  return (
    <SettingsSection
      title="Try a prompt"
      description={`Paste a brief to see how it would be routed in ${workspace?.path?.split('/').pop() || 'the selected project'}. Nothing is started.${dirty ? ' Uses saved settings; save first to try your edits.' : ''}`}
    >
      <Textarea
        aria-label="Prompt to route"
        rows={4}
        value={prompt}
        placeholder="Fix the flaky login test in auth.spec.ts; it times out waiting for the redirect."
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void route()
        }}
      />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy || !prompt.trim() || !workspace} onClick={() => void route()}>
          {busy ? 'Routing…' : 'Route it'}
        </Button>
        {error ? <span className="text-[length:var(--fd-text-xs)] text-danger">{error}</span> : null}
      </div>
      {decision ? (
        <div className="space-y-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[length:var(--fd-text-base)] font-medium text-fg-primary">
              {decision.target ? describeTarget(decision.target) : 'No usable model'}
            </span>
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
              {decision.rule ? `rule "${decision.rule}"` : 'fallback'}
            </span>
          </div>
          {c ? (
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="info">{c.task_type}</Badge>
              <Badge>{c.confidence_percent}% sure</Badge>
              <Badge>difficulty {c.difficulty.toFixed(1)} / 5</Badge>
              <Badge variant={c.production_risk_percent >= 50 ? 'warning' : 'default'}>
                production risk {c.production_risk_percent}%
              </Badge>
              <Badge variant={c.needs_social_percent >= 50 ? 'warning' : 'default'}>
                X/social {c.needs_social_percent}%
              </Badge>
              <Badge>{c.latency_ms} ms</Badge>
            </div>
          ) : null}
          <p className="text-[length:var(--fd-text-xs)] leading-relaxed text-fg-muted">{decision.reason}</p>
          {decision.skipped.length ? (
            <ul className="space-y-0.5 text-[length:var(--fd-text-xs)] text-fg-muted">
              {decision.skipped.map((skip, index) => (
                <li key={index}>
                  Skipped {describeTarget(skip.target)}: {skip.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  )
}

function TriStateSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean | null | undefined
  onChange: (value: boolean | null) => void
}) {
  return (
    <Select
      value={value == null ? ANY : value ? 'yes' : 'no'}
      onValueChange={(next) => onChange(next === ANY ? null : next === 'yes')}
    >
      <SelectTrigger aria-label={label} className="h-8 w-[7rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any</SelectItem>
        <SelectItem value="yes">Yes</SelectItem>
        <SelectItem value="no">No</SelectItem>
      </SelectContent>
    </Select>
  )
}

function DifficultySelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null | undefined
  onChange: (value: number | null) => void
}) {
  return (
    <Select value={value == null ? ANY : String(value)} onValueChange={(next) => onChange(next === ANY ? null : Number(next))}>
      <SelectTrigger aria-label={label} className="h-8 w-[5.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any</SelectItem>
        {[1, 2, 3, 4, 5].map((level) => (
          <SelectItem key={level} value={String(level)}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const conditionLabel = 'text-[length:var(--fd-text-xs)] uppercase tracking-[0.14em] text-fg-muted'

function RuleCard({
  rule,
  index,
  count,
  taskTypes,
  workspace,
  onChange,
  onMove,
  onDelete,
}: {
  rule: RoutingRule
  index: number
  count: number
  taskTypes: string[]
  workspace?: WorkspaceSummary | null
  onChange: (rule: RoutingRule) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}) {
  const toggleType = (id: string) =>
    onChange({
      ...rule,
      task_types: rule.task_types.includes(id)
        ? rule.task_types.filter((t) => t !== id)
        : [...rule.task_types, id],
    })
  return (
    <div className="space-y-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="w-5 text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">{index + 1}</span>
        <Input
          aria-label="Rule name"
          className="h-8 flex-1 font-medium"
          value={rule.label}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
        />
        <Button variant="ghost" size="icon" aria-label={`Move ${rule.label} earlier`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Move ${rule.label} later`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Delete ${rule.label}`} onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-7">
        <span className={`${conditionLabel} mr-1`}>Types</span>
        {taskTypes.map((id) => {
          const on = rule.task_types.includes(id)
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => toggleType(id)}
              className={`fd-focus rounded-[var(--fd-radius-full)] px-2.5 py-0.5 text-[length:var(--fd-text-xs)] font-medium transition-colors ${
                on ? 'bg-accent text-surface-0' : 'bg-surface-3 text-fg-secondary hover:bg-surface-4'
              }`}
            >
              {id}
            </button>
          )
        })}
        {rule.task_types.length === 0 ? (
          <span className="text-[length:var(--fd-text-xs)] text-fg-muted">any type</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-7">
        <label className="flex items-center gap-2">
          <span className={conditionLabel}>Difficulty</span>
          <DifficultySelect label="Minimum difficulty" value={rule.min_difficulty} onChange={(min_difficulty) => onChange({ ...rule, min_difficulty })} />
          <span className="text-fg-muted">to</span>
          <DifficultySelect label="Maximum difficulty" value={rule.max_difficulty} onChange={(max_difficulty) => onChange({ ...rule, max_difficulty })} />
        </label>
        <label className="flex items-center gap-2">
          <span className={conditionLabel}>Production risk</span>
          <TriStateSelect label="Production risk" value={rule.production_risk} onChange={(production_risk) => onChange({ ...rule, production_risk })} />
        </label>
        <label className="flex items-center gap-2">
          <span className={conditionLabel}>Needs X</span>
          <TriStateSelect label="Needs X or social data" value={rule.needs_social} onChange={(needs_social) => onChange({ ...rule, needs_social })} />
        </label>
      </div>
      <div className="pl-7">
        <TargetList targets={rule.targets} workspace={workspace} onChange={(targets) => onChange({ ...rule, targets })} />
      </div>
    </div>
  )
}

function TargetList({
  targets,
  workspace,
  onChange,
}: {
  targets: RoutingTarget[]
  workspace?: WorkspaceSummary | null
  onChange: (targets: RoutingTarget[]) => void
}) {
  const providers = useMemo(() => {
    const ids = new Set((workspace?.agents ?? []).map((agent) => agent.provider))
    for (const target of targets) ids.add(target.provider)
    return [...ids]
  }, [workspace, targets])
  const set = (index: number, patch: Partial<RoutingTarget>) =>
    onChange(targets.map((t, i) => (i === index ? { ...t, ...patch } : t)))

  return (
    <div className="space-y-1.5">
      {targets.map((target, index) => {
        const agent = workspace?.agents.find((a) => a.provider === target.provider)
        const listId = `routing-models-${target.provider}`
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <span className="w-4 text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">{index + 1}</span>
            <Select value={target.provider} onValueChange={(provider) => set(index, { provider, model_id: null, reasoning_effort: null })}>
              <SelectTrigger aria-label="Harness" className="h-8 w-[9.5rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {PROVIDER_LABELS[provider] ?? provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Model"
              list={listId}
              className="h-8 w-60 font-mono text-[length:var(--fd-text-xs)]"
              placeholder="Harness default"
              value={target.model_id ?? ''}
              onChange={(e) => set(index, { model_id: e.target.value || null })}
            />
            <datalist id={listId}>
              {(agent?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </datalist>
            <Select
              value={target.reasoning_effort ?? ANY}
              onValueChange={(effort) => set(index, { reasoning_effort: effort === ANY ? null : effort })}
            >
              <SelectTrigger aria-label="Effort" className="h-8 w-[7.5rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Default effort</SelectItem>
                {EFFORTS.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agent && agent.account.status === 'needs_auth' ? <Badge variant="warning">Needs sign-in</Badge> : null}
            {!agent && workspace ? <Badge>Not installed here</Badge> : null}
            <div className="ml-auto flex">
              <Button variant="ghost" size="icon" aria-label="Move model earlier" disabled={index === 0} onClick={() => onChange(move(targets, index, -1))}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Remove model" onClick={() => onChange(targets.filter((_, i) => i !== index))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...targets, { provider: providers[0] ?? 'codex', model_id: null, reasoning_effort: null }])}
      >
        <Plus className="h-4 w-4" />
        Add model
      </Button>
    </div>
  )
}
