import { useMemo } from 'react'
import { SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsUsageRow } from '@falcondeck/client-core'

import { AgentChip, BoundedTable, FilterEmpty, FilterSelect, NOTE, NUM, TD, TH } from './analytics-ui'
import {
  NO_THREAD_FILTERS,
  agentLabel,
  compact,
  costTitle,
  count,
  filterOptions,
  filterThreads,
  harnessLabel,
  modelLabel,
  threadBot,
  tokenTotal,
  usd,
  type ThreadFilters,
} from './analytics-utils'

const USAGE_ORIGINS: Record<string, string> = {
  user: 'You',
  agent_spawn: 'Agent task',
  scheduled: 'Scheduled',
  automation: 'Automation',
}

function threadContext(row: AnalyticsUsageRow) {
  const detail = row.thread
  if (!detail) return ''
  return [
    detail.project,
    detail.bot,
    [USAGE_ORIGINS[detail.origin] ?? detail.origin, detail.automation].filter(Boolean).join(': '),
  ]
    .filter(Boolean)
    .join(' · ')
}

export function ThreadsTab({
  rows,
  filters,
  onFilters,
  onOpenThread,
}: {
  rows: AnalyticsUsageRow[]
  filters: ThreadFilters
  onFilters: (filters: ThreadFilters) => void
  onOpenThread?: (workspaceId: string, threadId: string) => void
}) {
  const filtered = useMemo(() => filterThreads(rows, filters), [rows, filters])
  const set = (patch: Partial<ThreadFilters>) => onFilters({ ...filters, ...patch })

  return (
    <SettingsSection
      title="Top threads"
      description="The threads that used the most tokens. Context per call is the prompt the model saw: uncached input plus cache reads and writes."
    >
      {rows.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Filter by bot"
              allLabel="All bots"
              value={filters.bot}
              options={filterOptions(rows.map(threadBot), filters.bot)}
              onChange={(bot) => set({ bot })}
            />
            <FilterSelect
              label="Filter by harness"
              allLabel="All harnesses"
              value={filters.harness}
              options={filterOptions(rows.map((row) => row.thread?.provider ?? ''), filters.harness, harnessLabel)}
              onChange={(harness) => set({ harness })}
            />
            <FilterSelect
              label="Filter by model"
              allLabel="All models"
              value={filters.model}
              options={filterOptions(rows.map((row) => row.thread?.model ?? ''), filters.model, modelLabel)}
              onChange={(model) => set({ model })}
            />
          </div>
          {filtered.length ? (
            <BoundedTable
              label="Top threads"
              minWidth="min-w-[40rem]"
              rows={filtered}
              total={rows.length}
              head={
                <>
                  <th className={cn(TH, 'w-full')}>Thread</th>
                  <th className={TH}>Agent</th>
                  <th className={cn(TH, NUM)}>Turns</th>
                  <th className={cn(TH, NUM)}>Context / call</th>
                  <th className={cn(TH, NUM)}>Tokens</th>
                  <th className={cn(TH, NUM)}>API-equiv $</th>
                </>
              }
              row={(row) => {
                const detail = row.thread
                const name = row.label || row.key
                const context = threadContext(row)
                return (
                  <tr key={row.key}>
                    <td className={cn(TD, 'max-w-0')}>
                      {detail && onOpenThread ? (
                        <button
                          type="button"
                          className="fd-focus block max-w-full truncate text-left text-fg-primary underline decoration-border-subtle underline-offset-2 hover:decoration-fg-tertiary"
                          onClick={() => onOpenThread(detail.workspace, row.key)}
                          title={name}
                        >
                          {name}
                        </button>
                      ) : (
                        <span className="block truncate" title={name}>
                          {name}
                        </span>
                      )}
                      {context ? (
                        <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted" title={context}>
                          {context}
                        </p>
                      ) : null}
                    </td>
                    <td className={TD}>
                      {detail ? <AgentChip label={agentLabel(detail.provider, detail.model)} /> : '—'}
                    </td>
                    <td className={cn(TD, NUM)}>{count(row.totals.turns)}</td>
                    <td className={cn(TD, NUM)}>
                      {detail?.avg_context_per_call ? `≈${compact(detail.avg_context_per_call)}` : '—'}
                    </td>
                    <td className={cn(TD, NUM, 'text-fg-primary')}>{compact(tokenTotal(row.totals))}</td>
                    <td className={cn(TD, NUM, 'text-fg-tertiary')} title={costTitle(row.cost_sources)}>
                      {usd(row.totals.cost_usd)}
                    </td>
                  </tr>
                )
              }}
            />
          ) : (
            <FilterEmpty onClear={() => onFilters(NO_THREAD_FILTERS)} />
          )}
        </>
      ) : (
        <p className={NOTE}>No threads used tokens in this period.</p>
      )}
    </SettingsSection>
  )
}
