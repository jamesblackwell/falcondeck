import { useMemo } from 'react'
import { Badge, Button, SearchField, SegmentedControl, SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsAutomation } from '@falcondeck/client-core'

import { AgentChip, BoundedTable, FilterEmpty, FilterSelect, FilterToggle, NOTE, NUM, TD, TH } from './analytics-ui'
import {
  NO_SCHEDULED_FILTERS,
  agentLabel,
  automationAgents,
  automationHarnesses,
  compact,
  count,
  duration,
  filterAutomations,
  filterOptions,
  harnessLabel,
  modelLabel,
  percent,
  scheduledFiltersActive,
  tokenTotal,
  when,
  type ScheduledFilters,
} from './analytics-utils'

const AUTOMATION_FLAGS: Record<string, string> = {
  large_reused_context: 'Large context',
  reused_thread_model_pin: 'Model pin on shared thread',
  bot_home_frequent: 'Frequent bot-home runs',
  cache_cold_reuse: 'Cold cache reuse',
  rarely_useful: 'Rarely finds anything',
  very_frequent: 'Very frequent',
  failing: 'Failing',
  thread_per_run: 'New thread each run',
}

const AUTOMATION_HINTS: Record<string, string> = {
  large_reused_context: 'Use fresh runs or a smaller compaction window to reduce reused context.',
  reused_thread_model_pin: 'Clear model and effort pins or use fresh runs with a bot.',
  bot_home_frequent: 'Use fresh runs with a bot or schedule the home thread at least four hours apart.',
  cache_cold_reuse: 'Run within the cache TTL or use fresh threads.',
  rarely_useful: 'Run less often or add a shell pre-check.',
  very_frequent: 'Reduce the schedule frequency.',
  failing: 'Open the automation and inspect recent failures.',
  thread_per_run: 'Review the schedule and whether each run needs a fresh thread.',
}

const STATES: Array<{ value: ScheduledFilters['state']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'paused', label: 'Paused' },
]

function AgentCell({ automation }: { automation: AnalyticsAutomation }) {
  const agents = automationAgents(automation)
  const pin = automation.configured_model
  return (
    <div className="flex flex-col items-start gap-1">
      {agents.length ? (
        agents.map((agent) => (
          <AgentChip key={`${agent.provider}:${agent.model}`} label={agentLabel(agent.provider, agent.model)} />
        ))
      ) : (
        <AgentChip quiet label={agentLabel(automation.provider, pin || automation.fallback_model)} />
      )}
      {agents.length && pin && !agents.some((agent) => agent.model === pin) ? (
        <p className="whitespace-nowrap text-[length:var(--fd-text-xs)] text-fg-muted">Pin: {modelLabel(pin)}</p>
      ) : null}
    </div>
  )
}

export function ScheduledTab({
  automations,
  filters,
  onFilters,
  onOpenAutomation,
}: {
  automations: AnalyticsAutomation[]
  filters: ScheduledFilters
  onFilters: (filters: ScheduledFilters) => void
  onOpenAutomation?: (id: string) => void
}) {
  const filtered = useMemo(() => filterAutomations(automations, filters), [automations, filters])
  const set = (patch: Partial<ScheduledFilters>) => onFilters({ ...filters, ...patch })
  const clear = () => onFilters({ ...NO_SCHEDULED_FILTERS, sort: filters.sort })
  const { sort } = filters

  return (
    <SettingsSection
      title="Scheduled tasks"
      description="Every scheduled task, flagged when it may cost more than it gives. A run that finds nothing to do still takes a turn; frequent runs grow a thread's context or the sidebar."
    >
      {automations.length ? (
        <>
          <SearchField
            label="Search scheduled tasks"
            placeholder="Search scheduled tasks"
            value={filters.query}
            onChange={(event) => set({ query: event.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl ariaLabel="State" value={filters.state} onChange={(state) => set({ state })} options={STATES} />
            <FilterToggle label="Failing" active={filters.failing} onChange={(failing) => set({ failing })} />
            <FilterToggle label="Flagged" active={filters.flagged} onChange={(flagged) => set({ flagged })} />
            <FilterSelect
              label="Filter by harness"
              allLabel="All harnesses"
              value={filters.harness}
              options={filterOptions(automations.flatMap(automationHarnesses), filters.harness, harnessLabel)}
              onChange={(harness) => set({ harness })}
            />
            <FilterSelect
              label="Filter by bot"
              allLabel="All bots"
              value={filters.bot}
              options={filterOptions(automations.flatMap((automation) => automation.bots ?? []), filters.bot)}
              onChange={(bot) => set({ bot })}
            />
            {scheduledFiltersActive(filters) && filtered.length ? (
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear
              </Button>
            ) : null}
          </div>
          {filtered.length ? (
            <BoundedTable
              label="Scheduled tasks"
              minWidth="min-w-[52rem]"
              rows={filtered}
              total={automations.length}
              head={
                <>
                  <th className={cn(TH, 'w-full min-w-56')}>Task</th>
                  <th className={TH}>Agent</th>
                  <th
                    className={cn(TH, NUM)}
                    aria-sort={sort === null ? 'none' : sort === 'desc' ? 'descending' : 'ascending'}
                  >
                    <button type="button" className="fd-focus" onClick={() => set({ sort: sort === 'desc' ? 'asc' : 'desc' })}>
                      Tokens {sort === 'desc' ? '↓' : sort === 'asc' ? '↑' : '↕'}
                    </button>
                  </th>
                  <th className={cn(TH, NUM)}>Runs</th>
                  <th className={cn(TH, NUM)}>Nothing to do</th>
                  <th className={cn(TH, NUM)}>Failed</th>
                  <th className={cn(TH, NUM)}>Agent time</th>
                  <th className={cn(TH, NUM)}>Threads</th>
                </>
              }
              row={(automation) => (
                <tr key={automation.id ?? automation.name}>
                  <td className={TD}>
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={automation.state === 'paused' ? 'text-fg-muted' : undefined}>
                          {automation.id && automation.state && onOpenAutomation ? (
                            <button
                              type="button"
                              className="fd-focus text-left hover:underline"
                              onClick={() => onOpenAutomation(automation.id!)}
                            >
                              {automation.name}
                            </button>
                          ) : (
                            automation.name
                          )}
                        </span>
                        {(automation.flags ?? []).map((flag) => (
                          <span key={flag} title={AUTOMATION_HINTS[flag]}>
                            <Badge variant={flag === 'failing' ? 'danger' : 'warning'} className="whitespace-nowrap">
                              {AUTOMATION_FLAGS[flag] ?? flag}
                            </Badge>
                          </span>
                        ))}
                      </div>
                      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                        {[
                          automation.schedule,
                          automation.state && automation.state !== 'enabled' ? automation.state : null,
                          automation.last_run_at ? `last ran ${when(automation.last_run_at)}` : null,
                          ...(automation.bots ?? []),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                  </td>
                  <td className={TD}>
                    <AgentCell automation={automation} />
                  </td>
                  <td
                    className={cn(TD, NUM, 'text-fg-primary')}
                    title={
                      automation.usage
                        ? `Input: ${count(automation.usage.input_tokens)} · Cache read: ${count(automation.usage.cache_read_tokens)} · Cache write: ${count(automation.usage.cache_write_tokens)} · Output: ${count(automation.usage.output_tokens)}`
                        : 'No recorded usage'
                    }
                  >
                    {automation.usage?.turns ? compact(tokenTotal(automation.usage)) : '—'}
                  </td>
                  <td className={cn(TD, NUM)}>{count(automation.runs)}</td>
                  <td className={cn(TD, NUM)}>
                    {automation.runs > automation.skipped
                      ? percent(automation.no_action, automation.runs - automation.skipped)
                      : '—'}
                  </td>
                  <td className={cn(TD, NUM, automation.failed ? 'text-danger' : null)}>{count(automation.failed)}</td>
                  <td className={cn(TD, NUM)}>{automation.agent_ms ? duration(automation.agent_ms) : '—'}</td>
                  <td className={cn(TD, NUM)}>{count(automation.threads)}</td>
                </tr>
              )}
            />
          ) : (
            <FilterEmpty onClear={clear} />
          )}
        </>
      ) : (
        <p className={NOTE}>No scheduled tasks ran in this period.</p>
      )}
    </SettingsSection>
  )
}
