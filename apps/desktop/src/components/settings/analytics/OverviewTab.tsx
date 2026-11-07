import { useState } from 'react'
import { Button, SegmentedControl, SettingsSection } from '@falcondeck/ui'
import type { AnalyticsDay, AnalyticsSummary, AnalyticsUsageTotals, AnalyticsWasteItem } from '@falcondeck/client-core'

import { Stat, TILES } from './analytics-ui'
import { WasteRow, type WasteLinks } from './WasteTab'
import { compact, count, percent, scheduledOutcome, shortDate, tokenTotal, topBot, topModel, type Leader } from './analytics-utils'

type DailyMetric = 'user_messages' | 'agent_messages' | 'scheduled' | 'turns' | 'commits'

const DAILY_METRICS: Array<{ value: DailyMetric; label: string }> = [
  { value: 'user_messages', label: 'Your messages' },
  { value: 'agent_messages', label: 'Agent messages' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'turns', label: 'Turns' },
  { value: 'commits', label: 'Commits' },
]

/** Single-series daily bars; each bar names its day and value on hover. */
function DailyBars({ days, metric, label }: { days: AnalyticsDay[]; metric: DailyMetric; label: string }) {
  const peak = Math.max(1, ...days.map((day) => day[metric] ?? 0))
  return (
    <figure className="space-y-2">
      <div className="flex items-baseline justify-between text-[length:var(--fd-text-xs)] text-fg-muted">
        <figcaption>{label} per day</figcaption>
        <span className="tabular-nums">Peak {count(peak)}</span>
      </div>
      <div className="flex h-28 items-end gap-[2px] border-b border-border-subtle" aria-hidden="true">
        {days.map((day) => {
          const value = day[metric] ?? 0
          return (
            <div
              key={day.date}
              title={`${shortDate(day.date)}: ${count(value)}`}
              className="group flex h-full min-w-0 flex-1 items-end"
            >
              <div
                className="w-full rounded-t-[4px] bg-accent opacity-80 transition-opacity group-hover:opacity-100"
                style={{ height: value ? `${Math.max(3, (value / peak) * 100)}%` : 0 }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-[length:var(--fd-text-2xs)] text-fg-muted">
        <span>{days[0] ? shortDate(days[0].date) : ''}</span>
        <span>{days.at(-1) ? shortDate(days.at(-1)!.date) : ''}</span>
      </div>
      <table className="sr-only">
        <caption>{label} per day</caption>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>{day[metric] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

function leaderDetail(top: Leader | null, total: number) {
  return top ? `${compact(top.tokens)} tokens · ${percent(top.tokens, total)}` : undefined
}

export function OverviewTab({
  summary,
  usageTotals,
  waste,
  onOpenWaste,
  ...links
}: {
  summary: AnalyticsSummary
  usageTotals: AnalyticsUsageTotals | null
  waste: AnalyticsWasteItem[]
  onOpenWaste: () => void
} & WasteLinks) {
  const [metric, setMetric] = useState<DailyMetric>('user_messages')
  const { totals } = summary
  const usage = summary.usage ?? []
  const total = usageTotals
    ? tokenTotal(usageTotals)
    : usage.reduce((sum, row) => sum + tokenTotal(row.totals), 0)
  const bot = topBot(usage)
  const model = topModel(usage)
  const automations = summary.automations ?? []
  const outcome = scheduledOutcome(automations)
  const runs = automations.reduce((sum, automation) => sum + automation.runs, 0)
  const metricLabel = DAILY_METRICS.find((option) => option.value === metric)?.label ?? ''

  return (
    <>
      <div className={TILES}>
        <Stat
          label="Total tokens"
          value={total ? compact(total) : '—'}
          detail={usageTotals?.cache_read_tokens ? `${percent(usageTotals.cache_read_tokens, total)} read from cache` : undefined}
        />
        <Stat wordy label="Top bot" value={bot?.label ?? '—'} detail={leaderDetail(bot, total)} />
        <Stat wordy label="Top model" value={model?.label ?? '—'} detail={leaderDetail(model, total)} />
        <Stat
          label="Runs with nothing to do"
          value={outcome.started ? count(outcome.noAction) : '—'}
          detail={outcome.started ? `${percent(outcome.noAction, outcome.started)} of ${count(outcome.started)} scheduled runs` : undefined}
        />
      </div>

      {waste.length ? (
        <SettingsSection
          title="Biggest waste"
          description="The top items from Waste, as estimates."
          actions={
            <Button variant="ghost" size="sm" onClick={onOpenWaste}>
              See all {count(waste.length)}
            </Button>
          }
        >
          <ul className="divide-y divide-border-subtle">
            {waste.slice(0, 3).map((item) => (
              <WasteRow key={`${item.rule}:${item.automation ?? item.thread ?? item.label}`} item={item} {...links} />
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Daily activity" description="Totals for the selected period.">
        <SegmentedControl
          ariaLabel="Daily chart"
          value={metric}
          onChange={setMetric}
          options={DAILY_METRICS}
          className="max-w-full overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap"
        />
        <DailyBars days={summary.daily} metric={metric} label={metricLabel} />
        <div className={TILES}>
          <Stat
            label="Your messages"
            value={count(totals.user_messages)}
            detail={totals.scheduled_messages ? `+ ${count(totals.scheduled_messages)} scheduled` : undefined}
          />
          <Stat
            label="Agent messages"
            value={count(totals.agent_messages)}
            detail={
              totals.agent_messages
                ? `${percent(totals.ack_like_messages, totals.agent_messages)} look like acknowledgements`
                : undefined
            }
          />
          <Stat label="Scheduled runs" value={count(runs)} />
          <Stat label="Tasks agents created" value={count(totals.delegations)} />
          <Stat
            label="Turns"
            value={count(totals.turns)}
            detail={totals.failed_turns ? `${count(totals.failed_turns)} failed` : undefined}
          />
          <Stat label="Commits" value={count(totals.commits ?? 0)} />
          <Stat label="File writes" value={count(totals.file_writes)} />
        </div>
      </SettingsSection>
    </>
  )
}
