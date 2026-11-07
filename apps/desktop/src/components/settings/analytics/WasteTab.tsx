import { useMemo, useState } from 'react'
import { Badge, SegmentedControl, SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsCacheReport, AnalyticsWasteItem } from '@falcondeck/client-core'

import { BOX, NOTE, NUM, Stat, TD, TH, TILES } from './analytics-ui'
import {
  WASTE_GROUPS,
  count,
  estimate,
  filterWaste,
  percent,
  ruleTotals,
  type WasteGroup,
} from './analytics-utils'

export type WasteLinks = {
  onOpenThread?: (workspaceId: string, threadId: string) => void
  onOpenAutomation?: (id: string) => void
}

const FLAG_NAMES: Record<string, string> = {
  cache_cold_reuse: 'Cold cache reuse',
  bot_home_frequent: 'Frequent bot-home runs',
  rarely_useful: 'Rarely finds anything',
  very_frequent: 'Very frequent',
}

function RuleBadge({ item, label }: { item: AnalyticsWasteItem; label?: string }) {
  if (item.rule === 'prefix_change') return <Badge variant="danger" dot>{label ?? 'Prefix change'}</Badge>
  if (item.rule === 'possible_prefix_change') return <Badge variant="warning" dot>{label ?? 'Possible prefix change'}</Badge>
  return label ? <Badge className="whitespace-nowrap font-normal">{label}</Badge> : null
}

/** One offender: what it is, why it was flagged, and roughly what it cost. */
export function WasteRow({
  item,
  ruleLabel,
  onOpenThread,
  onOpenAutomation,
}: { item: AnalyticsWasteItem; ruleLabel?: string } & WasteLinks) {
  const openAutomation = item.automation && onOpenAutomation ? () => onOpenAutomation(item.automation!) : null
  const openThread =
    item.thread && item.workspace && onOpenThread ? () => onOpenThread(item.workspace!, item.thread!) : null
  const open = openAutomation ?? openThread
  const context = [
    item.automation ? 'Automation' : null,
    item.bot && item.bot !== item.label ? item.bot : null,
    ...(item.flags ?? []).map((flag) => FLAG_NAMES[flag] ?? flag),
  ].filter(Boolean)
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {open ? (
            <button
              type="button"
              className="fd-focus block max-w-full truncate text-left text-[length:var(--fd-text-sm)] text-fg-primary underline decoration-border-subtle underline-offset-2 hover:decoration-fg-tertiary"
              onClick={open}
              title={item.label}
            >
              {item.label}
            </button>
          ) : (
            <span className="block max-w-full truncate text-[length:var(--fd-text-sm)] text-fg-primary" title={item.label}>
              {item.label}
            </span>
          )}
          <RuleBadge item={item} label={ruleLabel} />
        </div>
        <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">{item.reason}</p>
        {context.length ? <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">{context.join(' · ')}</p> : null}
      </div>
      <span className={cn(NUM, 'pt-0.5 text-[length:var(--fd-text-sm)] text-fg-primary')}>{estimate(item.estimated_usd)}</span>
    </li>
  )
}

export function WasteTab({ report, ...links }: { report: AnalyticsCacheReport | null } & WasteLinks) {
  const [group, setGroup] = useState<WasteGroup>('all')
  const waste = useMemo(() => report?.waste ?? [], [report])
  const rows = useMemo(() => filterWaste(waste, group), [waste, group])
  if (!report) return <p className={NOTE}>This version of the daemon does not report waste yet.</p>

  const rules = report.rules ?? []
  const ruleLabel = (id: string) => rules.find((rule) => rule.id === id)?.label
  const all = ruleTotals(rules)
  const cache = ruleTotals(rules, 'cache')
  const selected = ruleTotals(rules, group).flagged
  const flaggedBy = (id: string) => rules.find((rule) => rule.id === id)?.flagged ?? 0
  const possible = flaggedBy('possible_prefix_change')
  const proven = waste.filter((item) => item.rule === 'prefix_change')

  return (
    <>
      <div className={TILES}>
        <Stat
          label="Flagged, estimated"
          value={estimate(all.usd)}
          detail={report.period_cost_usd ? `${percent(all.usd, report.period_cost_usd)} of ${estimate(report.period_cost_usd)} at list price` : undefined}
        />
        <Stat label="Items flagged" value={count(all.flagged)} detail={all.flagged ? 'Ranked below' : undefined} />
        <Stat label="Cache breaks" value={estimate(cache.usd)} detail={`${count(cache.flagged)} flagged`} />
        <Stat
          label="Prefix changes"
          value={count(flaggedBy('prefix_change'))}
          detail={possible ? `+ ${count(possible)} possible` : 'Warm cache missed, cause unknown'}
        />
      </div>

      {proven.length ? (
        <div role="alert" className="space-y-2 rounded-[var(--fd-radius-lg)] border border-danger/25 bg-danger-muted px-3.5 py-3">
          <p className="text-[length:var(--fd-text-sm)] font-medium text-danger">
            A warm cache was missed and the records don't show why
          </p>
          <ul className="divide-y divide-border-subtle">
            {proven.map((item) => (
              <WasteRow key={item.automation ?? item.thread ?? item.label} item={item} {...links} />
            ))}
          </ul>
        </div>
      ) : null}

      <SettingsSection
        title="Ranked offenders"
        description="Plain rules, biggest estimated cost first. Dollars are list-price estimates over the selected period, not bills, and one turn can sit under two rules."
      >
        {waste.length ? (
          <>
            <SegmentedControl ariaLabel="Filter offenders" value={group} onChange={setGroup} options={[...WASTE_GROUPS]} />
            {rows.length ? (
              <div className={BOX} role="region" aria-label="Ranked offenders" tabIndex={0}>
                <ul className="divide-y divide-border-subtle pr-1">
                  {rows.map((item) => (
                    <WasteRow
                      key={`${item.rule}:${item.automation ?? item.thread ?? item.label}`}
                      item={item}
                      ruleLabel={ruleLabel(item.rule)}
                      {...links}
                    />
                  ))}
                </ul>
              </div>
            ) : (
              <p className={NOTE}>
                {selected ? `${count(selected)} flagged here, but this report left them out.` : 'Nothing flagged here in this period.'}
              </p>
            )}
            {rows.length && selected > rows.length ? (
              <p className={NOTE}>
                {group === 'all'
                  ? `Showing ${count(rows.length)} of ${count(selected)}, the biggest in each category.`
                  : `Showing the top ${count(rows.length)} of ${count(selected)}.`}{' '}
                The totals above cover all of them.
              </p>
            ) : null}
          </>
        ) : (
          <p className={NOTE}>Nothing crossed a threshold in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection title="How flags are decided" description="Every rule and its thresholds. A false alarm is worse than a missed small item, so these lean strict.">
        <div className="overflow-x-auto" role="region" aria-label="How flags are decided" tabIndex={0}>
          <table className="w-full min-w-[36rem] text-[length:var(--fd-text-sm)]">
            <thead>
              <tr>
                <th className={TH}>Rule</th>
                <th className={TH}>Flags when</th>
                <th className={cn(TH, NUM)}>Flagged</th>
                <th className={cn(TH, NUM)}>Estimated</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className={cn(TD, 'whitespace-nowrap text-fg-primary')}>{rule.label}</td>
                  <td className={TD}>{rule.definition}</td>
                  <td className={cn(TD, NUM)}>{count(rule.flagged ?? 0)}</td>
                  <td className={cn(TD, NUM)}>{estimate(rule.estimated_usd ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      {report.limits?.length ? (
        <SettingsSection title="What this cannot see" description="Signals the records do not hold, named rather than guessed.">
          <ul className="list-disc space-y-1 pl-5 text-[length:var(--fd-text-sm)] text-fg-secondary">
            {report.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}
    </>
  )
}
