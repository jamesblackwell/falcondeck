import { useMemo, useState } from 'react'
import { SegmentedControl, SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsCacheReport, AnalyticsCostMix, AnalyticsRebuildGroup } from '@falcondeck/client-core'

import { AgentChip, BoundedTable, NOTE, NUM, TD, TH } from './analytics-ui'
import {
  CAUSES,
  causeLabel,
  compact,
  count,
  estimate,
  gapLabel,
  harnessLabel,
  modelLabel,
  percent,
  rankCauses,
} from './analytics-utils'

type Dimension = 'provider' | 'model' | 'bot'

const DIMENSIONS: Array<{ value: Dimension; label: string }> = [
  { value: 'provider', label: 'Harness' },
  { value: 'model', label: 'Model' },
  { value: 'bot', label: 'Bot' },
]

type RebuildView = 'bot' | 'thread'

const REBUILD_VIEWS: Array<{ value: RebuildView; label: string }> = [
  { value: 'bot', label: 'By bot' },
  { value: 'thread', label: 'By thread' },
]

function HitRates({ report }: { report: AnalyticsCacheReport }) {
  const [dimension, setDimension] = useState<Dimension>('provider')
  const rows = useMemo(
    () => (report.hit_rates ?? []).filter((row) => row.dimension === dimension),
    [report.hit_rates, dimension],
  )
  const label = (key: string) => (dimension === 'provider' ? harnessLabel(key) : dimension === 'model' ? modelLabel(key) : key)
  return (
    <SettingsSection
      title="Cache hit rate"
      description="Share of prompt tokens read from cache. Not the whole story: a 97% rate can still hide most of the bill, because one rebuild costs what many reads do. Read it beside the cost split and rebuilds below."
    >
      {rows.length || dimension !== 'provider' ? (
        <>
          <SegmentedControl ariaLabel="Group hit rate by" value={dimension} onChange={setDimension} options={DIMENSIONS} />
          <BoundedTable
            label="Cache hit rate"
            minWidth="min-w-[32rem]"
            rows={rows}
            head={
              <>
                <th className={cn(TH, 'w-full')}>{DIMENSIONS.find((option) => option.value === dimension)?.label}</th>
                <th className={cn(TH, NUM)}>Hit rate</th>
                <th className={cn(TH, NUM)}>Read</th>
                <th className={cn(TH, NUM)}>Written</th>
                <th className={cn(TH, NUM)}>Fresh</th>
              </>
            }
            row={(row) => (
              <tr key={row.key}>
                <td className={cn(TD, 'text-fg-primary')}>{label(row.key)}</td>
                <td className={cn(TD, NUM, 'text-fg-primary')}>{(row.hit_rate * 100).toFixed(1)}%</td>
                <td className={cn(TD, NUM)}>{compact(row.read_tokens)}</td>
                <td className={cn(TD, NUM)}>{row.write_tokens ? compact(row.write_tokens) : '—'}</td>
                <td className={cn(TD, NUM)}>{compact(row.fresh_tokens)}</td>
              </tr>
            )}
          />
        </>
      ) : (
        <p className={NOTE}>No token usage recorded in this period.</p>
      )}
    </SettingsSection>
  )
}

function mixTotal(row: AnalyticsCostMix) {
  return row.fresh_usd + row.write_usd + row.read_usd
}

function CostBar({ row }: { row: AnalyticsCostMix }) {
  const total = mixTotal(row)
  if (!total) return null
  const part = (value: number) => ({ width: `${(value / total) * 100}%` })
  return (
    <div className="flex h-1.5 w-full min-w-24 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
      <div className="bg-accent" style={part(row.write_usd)} />
      <div className="bg-accent opacity-50" style={part(row.fresh_usd)} />
      <div className="bg-fg-tertiary opacity-50" style={part(row.read_usd)} />
    </div>
  )
}

function CostMix({ report }: { report: AnalyticsCacheReport }) {
  const rows = report.cost_mix ?? []
  return (
    <SettingsSection
      title="Where input cost goes"
      description="Estimated input cost by kind of token. Bar order is writes, fresh input, reads. Output is left out."
    >
      {rows.length ? (
        <>
          <BoundedTable
            label="Where input cost goes"
            minWidth="min-w-[40rem]"
            rows={rows}
            head={
              <>
                <th className={TH}>Harness</th>
                <th className={cn(TH, 'w-full')}>Split</th>
                <th className={cn(TH, NUM)}>Fresh</th>
                <th className={cn(TH, NUM)}>Writes</th>
                <th className={cn(TH, NUM)}>Reads</th>
                <th className={cn(TH, NUM)}>Input total</th>
              </>
            }
            row={(row) => {
              const total = mixTotal(row)
              return (
                <tr key={row.provider}>
                  <td className={cn(TD, 'whitespace-nowrap text-fg-primary')}>{harnessLabel(row.provider)}</td>
                  <td className={cn(TD, 'align-middle')}>
                    <CostBar row={row} />
                    {row.unpriced_tokens ? (
                      <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                        No price known for {compact(row.unpriced_tokens)} tokens
                      </p>
                    ) : null}
                  </td>
                  <td className={cn(TD, NUM)}>{total ? percent(row.fresh_usd, total) : '—'}</td>
                  <td className={cn(TD, NUM)} title={row.write_reporting === 'reported_zero' ? 'The provider reports cache writes as 0' : undefined}>
                    {row.write_reporting === 'reported_zero' ? 'Reported as 0' : percent(row.write_usd, total)}
                  </td>
                  <td className={cn(TD, NUM)}>{total ? percent(row.read_usd, total) : '—'}</td>
                  <td className={cn(TD, NUM, 'text-fg-primary')}>{estimate(total)}</td>
                </tr>
              )
            }}
          />
          {rows.some((row) => row.write_reporting === 'reported_zero') ? (
            <p className={NOTE}>
              Codex, Grok and OpenCode carry a cache write field that is always 0. That means writes are not reported
              separately, not that nothing is cached: new input is charged at the input rate.
            </p>
          ) : null}
        </>
      ) : (
        <p className={NOTE}>No token usage recorded in this period.</p>
      )}
    </SettingsSection>
  )
}

function Rebuilds({ report, onOpenThread }: { report: AnalyticsCacheReport; onOpenThread?: (workspaceId: string, threadId: string) => void }) {
  const [view, setView] = useState<RebuildView>('bot')
  const causes = useMemo(() => rankCauses(report.rebuilds_by_cause ?? []), [report.rebuilds_by_cause])
  const rows: AnalyticsRebuildGroup[] = (view === 'bot' ? report.rebuilds_by_bot : report.rebuilds_by_thread) ?? []
  return (
    <SettingsSection
      title="Cache rebuilds"
      description="Turns that rewrote more than normal growth explains: the write is compared with the thread's previous context, not a fixed size. Where a cause cannot be told apart, it says so."
    >
      {causes.length ? (
        <>
          <BoundedTable
            label="Rebuilds by cause"
            minWidth="min-w-[36rem]"
            rows={causes}
            head={
              <>
                <th className={cn(TH, 'w-full')}>Cause</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Tokens</th>
                <th className={cn(TH, NUM)}>Estimated</th>
              </>
            }
            row={(row) => (
              <tr key={row.cause}>
                <td className={TD}>
                  <span className="text-fg-primary">{causeLabel(row.cause)}</span>
                  {CAUSES[row.cause] ? (
                    <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{CAUSES[row.cause].detail}</p>
                  ) : null}
                </td>
                <td className={cn(TD, NUM)}>{count(row.count)}</td>
                <td className={cn(TD, NUM)}>{compact(row.tokens)}</td>
                <td className={cn(TD, NUM, 'text-fg-primary')}>{estimate(row.estimated_usd)}</td>
              </tr>
            )}
          />
          <SegmentedControl ariaLabel="Group rebuilds by" value={view} onChange={setView} options={REBUILD_VIEWS} />
          <BoundedTable
            label={view === 'bot' ? 'Rebuilds by bot' : 'Rebuilds by thread'}
            minWidth="min-w-[36rem]"
            rows={rows}
            head={
              <>
                <th className={cn(TH, 'w-full')}>{view === 'bot' ? 'Bot' : 'Thread'}</th>
                <th className={TH}>Main cause</th>
                <th className={cn(TH, NUM)}>Rebuilds</th>
                <th className={cn(TH, NUM)}>Tokens</th>
                <th className={cn(TH, NUM)}>Estimated</th>
              </>
            }
            row={(row) => (
              <tr key={row.key}>
                <td className={cn(TD, 'max-w-0')}>
                  {view === 'thread' && row.workspace && onOpenThread ? (
                    <button
                      type="button"
                      className="fd-focus block max-w-full truncate text-left text-fg-primary underline decoration-border-subtle underline-offset-2 hover:decoration-fg-tertiary"
                      onClick={() => onOpenThread(row.workspace!, row.key)}
                      title={row.label}
                    >
                      {row.label}
                    </button>
                  ) : (
                    <span className="block truncate text-fg-primary" title={row.label}>
                      {row.label}
                    </span>
                  )}
                </td>
                <td className={TD}>
                  <AgentChip quiet label={causeLabel(row.top_cause ?? '')} />
                </td>
                <td className={cn(TD, NUM)}>{count(row.count)}</td>
                <td className={cn(TD, NUM)}>{compact(row.tokens)}</td>
                <td className={cn(TD, NUM, 'text-fg-primary')}>{estimate(row.estimated_usd)}</td>
              </tr>
            )}
          />
        </>
      ) : (
        <p className={NOTE}>No rebuilds in this period.</p>
      )}
    </SettingsSection>
  )
}

export function CacheTab({
  report,
  onOpenThread,
}: {
  report: AnalyticsCacheReport | null
  onOpenThread?: (workspaceId: string, threadId: string) => void
}) {
  if (!report) return <p className={NOTE}>This version of the daemon does not report cache health yet.</p>
  const homes = report.home_threads ?? []
  const overhead = report.overhead ?? []
  const prices = report.prices ?? []
  return (
    <>
      <CostMix report={report} />
      <Rebuilds report={report} onOpenThread={onOpenThread} />
      <HitRates report={report} />

      <SettingsSection
        title="Home threads"
        description="Context per call and idle pattern for each bot's home, to measure bot context work before and after. Gaps past 60 minutes mean a rebuild on Claude."
      >
        {homes.length ? (
          <BoundedTable
            label="Home threads"
            minWidth="min-w-[44rem]"
            rows={homes}
            head={
              <>
                <th className={cn(TH, 'w-full')}>Bot</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Context / call</th>
                <th className={cn(TH, NUM)}>Peak</th>
                <th className={cn(TH, NUM)}>Median gap</th>
                <th className={cn(TH, NUM)} title="Gaps under 5 minutes, 5 to 60 minutes, and over 60 minutes">
                  Gaps &lt;5 / 5–60 / &gt;60
                </th>
                <th className={cn(TH, NUM)}>Rebuilds</th>
              </>
            }
            row={(row) => (
              <tr key={row.thread}>
                <td className={cn(TD, 'max-w-0')}>
                  {row.workspace && onOpenThread ? (
                    <button
                      type="button"
                      className="fd-focus block max-w-full truncate text-left text-fg-primary underline decoration-border-subtle underline-offset-2 hover:decoration-fg-tertiary"
                      onClick={() => onOpenThread(row.workspace!, row.thread)}
                      title={row.bot}
                    >
                      {row.bot}
                    </button>
                  ) : (
                    <span className="block truncate text-fg-primary">{row.bot}</span>
                  )}
                </td>
                <td className={cn(TD, NUM)}>{count(row.turns)}</td>
                <td className={cn(TD, NUM)}>≈{compact(row.context_per_call)}</td>
                <td className={cn(TD, NUM)}>≈{compact(row.peak_context)}</td>
                <td className={cn(TD, NUM)}>{gapLabel(row.median_gap_minutes)}</td>
                <td className={cn(TD, NUM)}>
                  {row.gaps_under_5} / {row.gaps_5_to_60} / {row.gaps_over_60}
                </td>
                <td className={cn(TD, NUM, 'text-fg-primary')}>{estimate(row.rebuild_usd)}</td>
              </tr>
            )}
          />
        ) : (
          <p className={NOTE}>No bot home turns in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Added to each bot turn"
        description="What FalconDeck injects per turn: guidance, instructions and context files, as an estimated token count, against the same bot's average context."
      >
        {overhead.length ? (
          <BoundedTable
            label="Added to each bot turn"
            minWidth="min-w-[32rem]"
            rows={overhead}
            head={
              <>
                <th className={cn(TH, 'w-full')}>Bot</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Added</th>
                <th className={cn(TH, NUM)}>Avg context</th>
                <th className={cn(TH, NUM)}>Share</th>
              </>
            }
            row={(row) => (
              <tr key={row.bot}>
                <td className={cn(TD, 'text-fg-primary')}>{row.bot}</td>
                <td className={cn(TD, NUM)}>{count(row.turns)}</td>
                <td className={cn(TD, NUM)}>≈{compact(row.avg_tokens)}</td>
                <td className={cn(TD, NUM)}>{row.avg_context ? `≈${compact(row.avg_context)}` : '—'}</td>
                <td className={cn(TD, NUM)}>{row.avg_context ? `${(row.share * 100).toFixed(1)}%` : '—'}</td>
              </tr>
            )}
          />
        ) : (
          <p className={NOTE}>No bot turns in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection title="Prices used" description="List prices per million tokens behind every estimate. Anything not listed shows tokens and no dollars.">
        <BoundedTable
          label="Prices used"
          minWidth="min-w-[36rem]"
          rows={prices}
          head={
            <>
              <th className={cn(TH, 'w-full')}>Model</th>
              <th className={cn(TH, NUM)}>Input</th>
              <th className={cn(TH, NUM)}>Cache read</th>
              <th className={cn(TH, NUM)}>Cache write</th>
              <th className={cn(TH, NUM)}>Output</th>
            </>
          }
          row={(row) => (
            <tr key={row.model} title={row.source}>
              <td className={TD}>
                <AgentChip label={modelLabel(row.model)} />
              </td>
              <td className={cn(TD, NUM)}>${row.input}</td>
              <td className={cn(TD, NUM)}>${row.cache_read}</td>
              <td className={cn(TD, NUM)}>{row.cache_write ? `$${row.cache_write}` : '—'}</td>
              <td className={cn(TD, NUM)}>${row.output}</td>
            </tr>
          )}
        />
      </SettingsSection>
    </>
  )
}
