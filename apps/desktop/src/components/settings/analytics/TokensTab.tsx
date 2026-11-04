import { useMemo, useState } from 'react'
import { SegmentedControl, SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsSummary } from '@falcondeck/client-core'

import { AgentChip, BoundedTable, NOTE, NUM, TD, TH } from './analytics-ui'
import { agentLabel, compact, costTitle, count, duration, groupTokens, harnessLabel, tokenTotal, usd, type TokenGroup } from './analytics-utils'

const GROUPS: Array<{ value: TokenGroup; label: string }> = [
  { value: 'all', label: 'Bot + model' },
  { value: 'bot', label: 'Bot' },
  { value: 'harness', label: 'Harness' },
  { value: 'model', label: 'Model' },
]

export function TokensTab({ summary }: { summary: AnalyticsSummary }) {
  const [group, setGroup] = useState<TokenGroup>('all')
  const rows = useMemo(() => groupTokens(summary.usage ?? [], group), [summary.usage, group])
  const showBot = group === 'all' || group === 'bot'
  const showAgent = group !== 'bot'

  return (
    <>
      <SettingsSection
        title="Token usage"
        description="What finished turns actually consumed. Tokens are the measure; the cost column is the provider's own list-price API equivalent where it reports one (Grok's cost unit is still unverified)."
      >
        {rows.length ? (
          <>
            <SegmentedControl ariaLabel="Group token usage by" value={group} onChange={setGroup} options={GROUPS} />
            <BoundedTable
              label="Token usage"
              minWidth="min-w-[44rem]"
              rows={rows}
              head={
                <>
                  {showBot ? <th className={TH}>Bot</th> : null}
                  {showAgent ? <th className={TH}>{group === 'harness' ? 'Harness' : 'Agent'}</th> : null}
                  <th className={cn(TH, NUM)}>Tokens</th>
                  <th className={cn(TH, NUM)}>In (uncached)</th>
                  <th className={cn(TH, NUM)}>Cache read</th>
                  <th className={cn(TH, NUM)}>Cache write</th>
                  <th className={cn(TH, NUM)}>Out</th>
                  <th className={cn(TH, NUM)}>Turns</th>
                  <th className={cn(TH, NUM)}>API-equiv $</th>
                </>
              }
              row={(row) => (
                <tr key={row.key}>
                  {showBot ? <td className={TD}>{row.bot ?? '—'}</td> : null}
                  {showAgent ? (
                    <td className={TD}>
                      <AgentChip label={agentLabel(row.provider, row.model)} />
                    </td>
                  ) : null}
                  <td className={cn(TD, NUM, 'text-fg-primary')}>{compact(tokenTotal(row.totals))}</td>
                  <td className={cn(TD, NUM)}>{compact(row.totals.input_tokens)}</td>
                  <td className={cn(TD, NUM)}>{compact(row.totals.cache_read_tokens)}</td>
                  <td className={cn(TD, NUM)}>{compact(row.totals.cache_write_tokens)}</td>
                  <td className={cn(TD, NUM)}>{compact(row.totals.output_tokens)}</td>
                  <td className={cn(TD, NUM)}>{count(row.totals.turns)}</td>
                  <td className={cn(TD, NUM, 'text-fg-tertiary')} title={costTitle(row.cost_sources)}>
                    {usd(row.totals.cost_usd)}
                  </td>
                </tr>
              )}
            />
          </>
        ) : (
          <p className={NOTE}>No token usage recorded in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Turns by bot"
        description="Context is what FalconDeck adds to each bot turn: built-in guidance, instructions, context files and lists."
      >
        {summary.bots.length ? (
          <BoundedTable
            label="Turns by bot"
            minWidth="min-w-[36rem]"
            rows={summary.bots}
            head={
              <>
                <th className={TH}>Bot</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Avg turn</th>
                <th className={cn(TH, NUM)}>Context per turn</th>
                <th className={cn(TH, NUM)}>Tasks</th>
                <th className={cn(TH, NUM)}>Messages</th>
                <th className={cn(TH, NUM)}>Commits</th>
              </>
            }
            row={(bot) => (
              <tr key={bot.name}>
                <td className={TD}>{bot.name}</td>
                <td className={cn(TD, NUM)}>{count(bot.turns)}</td>
                <td className={cn(TD, NUM)}>{duration(bot.avg_turn_ms)}</td>
                <td className={cn(TD, NUM)}>≈{compact(bot.avg_context_tokens)}</td>
                <td className={cn(TD, NUM)}>{count(bot.delegations)}</td>
                <td className={cn(TD, NUM)}>{count(bot.messages_sent)}</td>
                <td className={cn(TD, NUM)}>{count(bot.commits ?? 0)}</td>
              </tr>
            )}
          />
        ) : (
          <p className={NOTE}>No bot activity in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection title="Turns by harness" description="Turn counts and context across each coding CLI.">
        {summary.providers.length ? (
          <BoundedTable
            label="Turns by harness"
            minWidth="min-w-[36rem]"
            rows={summary.providers}
            head={
              <>
                <th className={TH}>Harness</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Failed</th>
                <th className={cn(TH, NUM)}>Avg turn</th>
                <th className={cn(TH, NUM)}>Avg peak context</th>
                <th className={cn(TH, NUM)}>Input tokens</th>
                <th className={cn(TH, NUM)}>Output tokens</th>
              </>
            }
            row={(provider) => (
              <tr key={provider.provider}>
                <td className={TD}>{harnessLabel(provider.provider)}</td>
                <td className={cn(TD, NUM)}>{count(provider.turns)}</td>
                <td className={cn(TD, NUM, provider.failed ? 'text-danger' : null)}>{count(provider.failed)}</td>
                <td className={cn(TD, NUM)}>{duration(provider.avg_turn_ms)}</td>
                <td className={cn(TD, NUM)}>
                  {provider.avg_peak_context_tokens ? `≈${compact(provider.avg_peak_context_tokens)}` : '—'}
                </td>
                <td className={cn(TD, NUM)}>{provider.input_tokens ? compact(provider.input_tokens) : '—'}</td>
                <td className={cn(TD, NUM)}>{provider.output_tokens ? compact(provider.output_tokens) : '—'}</td>
              </tr>
            )}
          />
        ) : (
          <p className={NOTE}>No turns recorded in this period.</p>
        )}
      </SettingsSection>
    </>
  )
}
