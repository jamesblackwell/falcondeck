import { useMemo } from 'react'
import { Badge, SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsSummary } from '@falcondeck/client-core'

import { BOX, BoundedTable, NOTE, NUM, Stat, TD, TH, TILES } from './analytics-ui'
import { count, duration, percent, when } from './analytics-utils'

/** One labelled share bar per row; a single hue, so no legend is needed. */
function ShareBars({ rows, total }: { rows: Array<{ label: string; value: number }>; total: number }) {
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-x-3 gap-y-2">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="truncate text-[length:var(--fd-text-sm)] text-fg-secondary">{row.label}</dt>
          <div className="h-2 rounded-full bg-surface-3" aria-hidden="true">
            <div
              className="h-2 rounded-full bg-accent opacity-80"
              style={{ width: total ? `${(row.value / total) * 100}%` : 0 }}
            />
          </div>
          <dd className="whitespace-nowrap text-right text-[length:var(--fd-text-xs)] tabular-nums text-fg-tertiary">
            {count(row.value)} · {percent(row.value, total)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function ActivityTab({ summary }: { summary: AnalyticsSummary }) {
  const { waiting } = summary
  const triggers = useMemo(() => {
    const source = summary.triggers
    const rows = [
      { label: 'You', value: source?.user ?? 0 },
      { label: 'Scheduled tasks', value: source?.scheduled ?? 0 },
      { label: 'Other agents', value: source?.agent ?? 0 },
      { label: 'Delegated briefs', value: source?.delegation ?? 0 },
      { label: 'Continuing work', value: source?.other ?? 0 },
    ]
    return { rows, user: rows[0].value, total: rows.reduce((sum, row) => sum + row.value, 0) }
  }, [summary.triggers])

  return (
    <>
      <SettingsSection
        title="Who drives the work"
        description="What started each agent turn. The more turns start without you, the more the system runs itself."
      >
        {triggers.total ? (
          <>
            <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
              <span className="fd-type-heading tabular-nums text-fg-primary">
                {percent(triggers.total - triggers.user, triggers.total)}
              </span>{' '}
              of turns started without you
            </p>
            <ShareBars rows={triggers.rows} total={triggers.total} />
          </>
        ) : (
          <p className={NOTE}>No finished turns in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Waiting on you"
        description="How long finished work and approvals waited for you. Replies more than three days later are left out."
      >
        <div className={TILES}>
          <Stat
            label="Median time to your reply"
            value={waiting?.replies ? duration(waiting.median_reply_ms) : '—'}
            detail={waiting?.replies ? `${count(waiting.replies)} replies` : undefined}
          />
          <Stat label="Slowest 10% of replies" value={waiting?.replies ? `over ${duration(waiting.p90_reply_ms)}` : '—'} />
          <Stat
            label="Approvals and questions"
            value={waiting?.requests ? duration(waiting.median_request_wait_ms) : '—'}
            detail={waiting?.requests ? `median wait across ${count(waiting.requests)}` : undefined}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Agent communication"
        description="Messages agents send each other through FalconDeck. Short acknowledgements usually mean an agent is replying when nothing needs to be said."
      >
        {summary.agent_pairs.length ? (
          <BoundedTable
            label="Agent communication"
            rows={summary.agent_pairs}
            head={
              <>
                <th className={TH}>From → to</th>
                <th className={cn(TH, NUM)}>Messages</th>
                <th className={cn(TH, NUM)}>Avg length</th>
                <th className={cn(TH, NUM)}>Acknowledgements</th>
              </>
            }
            row={(pair) => (
              <tr key={`${pair.from}:${pair.to}`}>
                <td className={TD}>
                  {pair.from_title} → {pair.to_title}
                </td>
                <td className={cn(TD, NUM)}>{count(pair.messages)}</td>
                <td className={cn(TD, NUM)}>{count(pair.avg_chars)} chars</td>
                <td className={cn(TD, NUM)}>{percent(pair.ack_like, pair.messages)}</td>
              </tr>
            )}
          />
        ) : (
          <p className={NOTE}>No messages between agents in this period.</p>
        )}
        {summary.recent_agent_messages.length ? (
          <div className="space-y-2">
            <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted">Latest</p>
            <ul className={BOX} role="region" aria-label="Latest agent messages" tabIndex={0}>
              {summary.recent_agent_messages.map((message, index) => (
                <li key={index} className="space-y-1 border-t border-border-subtle py-2 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-x-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                    <span className="whitespace-nowrap tabular-nums">{when(message.at)}</span>
                    <span>
                      {message.from_title} → {message.to_title}
                    </span>
                    {message.ack_like ? <Badge variant="warning">Acknowledgement</Badge> : null}
                  </div>
                  <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">{message.excerpt}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Files agents write"
        description="Most-edited files. Files written by more than one thread on the same day are where agents are most likely to collide."
      >
        {summary.files.length ? (
          <BoundedTable
            label="Files agents write"
            rows={summary.files}
            head={
              <>
                <th className={cn(TH, 'w-full')}>File</th>
                <th className={cn(TH, NUM)}>Writes</th>
                <th className={cn(TH, NUM)}>Threads</th>
                <th className={cn(TH, NUM)}>Shared days</th>
              </>
            }
            row={(file) => (
              <tr key={file.path}>
                <td className={cn(TD, 'fd-type-mono max-w-0 truncate text-[length:var(--fd-text-xs)]')} title={file.path}>
                  {file.path}
                </td>
                <td className={cn(TD, NUM)}>{count(file.writes)}</td>
                <td className={cn(TD, NUM)}>{count(file.threads)}</td>
                <td className={cn(TD, NUM, file.contested_days ? 'text-warning' : null)}>{count(file.contested_days)}</td>
              </tr>
            )}
          />
        ) : (
          <p className={NOTE}>No file writes recorded in this period.</p>
        )}
      </SettingsSection>
    </>
  )
}
