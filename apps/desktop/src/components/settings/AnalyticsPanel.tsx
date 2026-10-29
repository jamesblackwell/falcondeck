import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  CopyButton,
  SearchField,
  SegmentedControl,
  SettingList,
  SettingRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
  cn,
} from '@falcondeck/ui'
import {
  createDaemonApiClient,
  type AnalyticsClearTarget,
  type AnalyticsDay,
  type AnalyticsPrompt,
  type AnalyticsSettings,
  type AnalyticsStatus,
  type AnalyticsSummary,
} from '@falcondeck/client-core'
import { RefreshCw } from 'lucide-react'

export type AnalyticsPanelProps = {
  baseUrl: string | null
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

type Period = '7' | '30' | '90'
type DailyMetric = 'user_messages' | 'agent_messages' | 'turns'

const DAILY_METRICS: Array<{ value: DailyMetric; label: string }> = [
  { value: 'user_messages', label: 'Your messages' },
  { value: 'agent_messages', label: 'Agent messages' },
  { value: 'turns', label: 'Turns' },
]

const RETENTION: Array<{ value: string; label: string }> = [
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '1 year' },
  { value: '24', label: '2 years' },
]

const count = (value: number) => value.toLocaleString()

function compact(value: number) {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function duration(ms: number) {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function when(at: string) {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '0%'
}

const TABLE = 'w-full text-left text-[length:var(--fd-text-sm)]'
const TH = 'pb-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted'
const TD = 'border-t border-border-subtle py-2 pr-3 align-top text-fg-secondary'
const NUM = 'text-right tabular-nums'
const EMPTY = 'text-[length:var(--fd-text-sm)] text-fg-muted'

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="space-y-1 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3.5 py-3">
      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{label}</p>
      <p className="fd-type-heading text-fg-primary tabular-nums">{value}</p>
      {detail ? <p className="text-[length:var(--fd-text-xs)] text-fg-tertiary">{detail}</p> : null}
    </div>
  )
}

/** Single-series daily bars; each bar names its day and value on hover. */
function DailyBars({ days, metric, label }: { days: AnalyticsDay[]; metric: DailyMetric; label: string }) {
  const peak = Math.max(1, ...days.map((day) => day[metric]))
  return (
    <figure className="space-y-2">
      <div className="flex items-baseline justify-between text-[length:var(--fd-text-xs)] text-fg-muted">
        <figcaption>{label} per day</figcaption>
        <span className="tabular-nums">Peak {count(peak)}</span>
      </div>
      <div className="flex h-28 items-end gap-[2px] border-b border-border-subtle" aria-hidden="true">
        {days.map((day) => {
          const value = day[metric]
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
              <td>{day[metric]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

function PromptRow({ prompt }: { prompt: AnalyticsPrompt }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="space-y-1 border-t border-border-subtle py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span className="tabular-nums">{when(prompt.at)}</span>
        <span className="text-fg-tertiary">{prompt.project || 'No project'}</span>
        <span className="min-w-0 truncate">· {prompt.title}</span>
      </div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'fd-focus block w-full whitespace-pre-wrap rounded-[var(--fd-radius-sm)] text-left text-[length:var(--fd-text-sm)] text-fg-secondary',
          open ? null : 'line-clamp-3',
        )}
        aria-expanded={open}
      >
        {prompt.text}
      </button>
    </li>
  )
}

export function AnalyticsPanel({ baseUrl, onToast }: AnalyticsPanelProps) {
  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])
  const [period, setPeriod] = useState<Period>('30')
  const [metric, setMetric] = useState<DailyMetric>('user_messages')
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [status, setStatus] = useState<AnalyticsStatus | null>(null)
  const [prompts, setPrompts] = useState<AnalyticsPrompt[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<AnalyticsClearTarget | null>(null)
  // Only the latest load may update the page; an older, slower one is discarded.
  const loadId = useRef(0)
  // Saves run one at a time from the latest wanted settings, so a quick second
  // change cannot be overwritten by the first request's stale values.
  const wanted = useRef<AnalyticsSettings | null>(null)
  const saving = useRef<Promise<void>>(Promise.resolve())

  const load = useCallback(async () => {
    if (!api) return
    const id = ++loadId.current
    setLoading(true)
    setError(null)
    try {
      const [nextSummary, nextStatus] = await Promise.all([
        api.analyticsSummary(Number(period)),
        api.analyticsStatus(),
      ])
      if (id !== loadId.current) return
      setSummary(nextSummary)
      setStatus(nextStatus)
      wanted.current ??= nextStatus.settings
    } catch (err) {
      if (id === loadId.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === loadId.current) setLoading(false)
    }
  }, [api, period])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!api) return
    let active = true
    const timer = window.setTimeout(() => {
      api.analyticsPrompts(query, 100).then(
        (next) => active && setPrompts(next),
        () => active && setPrompts([]),
      )
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, query, status?.prompts_bytes])

  const saveSettings = (patch: Partial<AnalyticsSettings>) => {
    if (!api || !status) return
    const next = { ...(wanted.current ?? status.settings), ...patch }
    wanted.current = next
    setStatus((current) => (current ? { ...current, settings: next } : current))
    saving.current = saving.current.then(async () => {
      try {
        const saved = await api.updateAnalyticsSettings(next)
        // A later change is queued behind this one; keep showing it.
        if (wanted.current === next) setStatus(saved)
      } catch (err) {
        onToast({
          variant: 'danger',
          title: 'Could not save analytics settings',
          description: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  const clear = async (target: AnalyticsClearTarget) => {
    if (!api) return
    try {
      setStatus(await api.clearAnalytics(target))
      setConfirming(null)
      await load()
      onToast({
        variant: 'success',
        title: target === 'prompts' ? 'Your messages were deleted' : 'Activity history was deleted',
      })
    } catch (err) {
      onToast({
        variant: 'danger',
        title: 'Could not delete analytics',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const totals = summary?.totals
  const metricLabel = DAILY_METRICS.find((option) => option.value === metric)?.label ?? ''

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Analytics"
        description="A private record of how you and your agents work. It stays on this Mac and is never sent to your phone or the relay."
        actions={
          <>
            <SegmentedControl
              ariaLabel="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: '7', label: '7 days' },
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
              ]}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh analytics"
              disabled={!api || loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn('h-4 w-4', loading ? 'animate-spin' : null)} />
            </Button>
          </>
        }
      />
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">
          {error}
        </p>
      ) : null}

      <SettingsSection title="Overview" description="Totals for the selected period.">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label="Your messages"
            value={totals ? count(totals.user_messages) : '—'}
            detail={totals?.scheduled_messages ? `+ ${count(totals.scheduled_messages)} scheduled` : undefined}
          />
          <Stat
            label="Agent messages"
            value={totals ? count(totals.agent_messages) : '—'}
            detail={
              totals?.agent_messages
                ? `${percent(totals.ack_like_messages, totals.agent_messages)} look like acknowledgements`
                : undefined
            }
          />
          <Stat label="Tasks agents created" value={totals ? count(totals.delegations) : '—'} />
          <Stat
            label="Turns"
            value={totals ? count(totals.turns) : '—'}
            detail={totals?.failed_turns ? `${count(totals.failed_turns)} failed` : undefined}
          />
          <Stat label="File writes" value={totals ? count(totals.file_writes) : '—'} />
        </div>
        {summary ? (
          <div className="space-y-3">
            <SegmentedControl ariaLabel="Daily chart" value={metric} onChange={setMetric} options={DAILY_METRICS} />
            <DailyBars days={summary.daily} metric={metric} label={metricLabel} />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Agent communication"
        description="Messages agents send each other through FalconDeck. Short acknowledgements usually mean an agent is replying when nothing needs to be said."
      >
        {summary?.agent_pairs.length ? (
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>From → to</th>
                <th className={cn(TH, NUM)}>Messages</th>
                <th className={cn(TH, NUM)}>Avg length</th>
                <th className={cn(TH, NUM)}>Acknowledgements</th>
              </tr>
            </thead>
            <tbody>
              {summary.agent_pairs.map((pair) => (
                <tr key={`${pair.from}:${pair.to}`}>
                  <td className={TD}>
                    {pair.from_title} → {pair.to_title}
                  </td>
                  <td className={cn(TD, NUM)}>{count(pair.messages)}</td>
                  <td className={cn(TD, NUM)}>{count(pair.avg_chars)} chars</td>
                  <td className={cn(TD, NUM)}>{percent(pair.ack_like, pair.messages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={EMPTY}>No messages between agents in this period.</p>
        )}
        {summary?.recent_agent_messages.length ? (
          <div className="space-y-2">
            <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted">Latest</p>
            <ul>
              {summary.recent_agent_messages.map((message, index) => (
                <li key={index} className="space-y-1 border-t border-border-subtle py-2 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-x-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                    <span className="tabular-nums">{when(message.at)}</span>
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
        title="Your messages"
        description="What you send to agents, newest first. Messages written by agents and scheduled tasks are counted but not kept."
      >
        {summary?.projects.length ? (
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Project or bot</th>
                <th className={cn(TH, NUM)}>Messages</th>
                <th className={cn(TH, NUM)}>Avg length</th>
              </tr>
            </thead>
            <tbody>
              {summary.projects.map((project) => (
                <tr key={project.project}>
                  <td className={TD}>{project.project}</td>
                  <td className={cn(TD, NUM)}>{count(project.messages)}</td>
                  <td className={cn(TD, NUM)}>{count(project.avg_chars)} chars</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <SearchField
          label="Search your messages"
          placeholder="Search your messages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {prompts.length ? (
          <ul className="max-h-[28rem] overflow-y-auto pr-1">
            {prompts.map((prompt, index) => (
              <PromptRow key={`${prompt.at}:${index}`} prompt={prompt} />
            ))}
          </ul>
        ) : (
          <p className={EMPTY}>{query ? 'No messages match.' : 'No messages recorded yet.'}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Files agents write"
        description="Most-edited files. Files written by more than one thread on the same day are where agents are most likely to collide."
      >
        {summary?.files.length ? (
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>File</th>
                <th className={cn(TH, NUM)}>Writes</th>
                <th className={cn(TH, NUM)}>Threads</th>
                <th className={cn(TH, NUM)}>Shared days</th>
              </tr>
            </thead>
            <tbody>
              {summary.files.map((file) => (
                <tr key={file.path}>
                  <td className={cn(TD, 'fd-type-mono max-w-0 truncate text-[length:var(--fd-text-xs)]')} title={file.path}>
                    {file.path}
                  </td>
                  <td className={cn(TD, NUM)}>{count(file.writes)}</td>
                  <td className={cn(TD, NUM)}>{count(file.threads)}</td>
                  <td className={cn(TD, NUM, file.contested_days ? 'text-warning' : null)}>
                    {count(file.contested_days)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={EMPTY}>No file writes recorded in this period.</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Turns by bot"
        description="Context is what FalconDeck adds to each bot turn: built-in guidance, instructions, context files and lists."
      >
        {summary?.bots.length ? (
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Bot</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Avg turn</th>
                <th className={cn(TH, NUM)}>Context per turn</th>
                <th className={cn(TH, NUM)}>Tasks</th>
                <th className={cn(TH, NUM)}>Messages</th>
              </tr>
            </thead>
            <tbody>
              {summary.bots.map((bot) => (
                <tr key={bot.name}>
                  <td className={TD}>{bot.name}</td>
                  <td className={cn(TD, NUM)}>{count(bot.turns)}</td>
                  <td className={cn(TD, NUM)}>{duration(bot.avg_turn_ms)}</td>
                  <td className={cn(TD, NUM)}>≈{compact(bot.avg_context_tokens)}</td>
                  <td className={cn(TD, NUM)}>{count(bot.delegations)}</td>
                  <td className={cn(TD, NUM)}>{count(bot.messages_sent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={EMPTY}>No bot activity in this period.</p>
        )}
        {summary?.providers.length ? (
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Harness</th>
                <th className={cn(TH, NUM)}>Turns</th>
                <th className={cn(TH, NUM)}>Failed</th>
                <th className={cn(TH, NUM)}>Avg turn</th>
                <th className={cn(TH, NUM)}>Input tokens</th>
                <th className={cn(TH, NUM)}>Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {summary.providers.map((provider) => (
                <tr key={provider.provider}>
                  <td className={TD}>{provider.provider}</td>
                  <td className={cn(TD, NUM)}>{count(provider.turns)}</td>
                  <td className={cn(TD, NUM)}>{count(provider.failed)}</td>
                  <td className={cn(TD, NUM)}>{duration(provider.avg_turn_ms)}</td>
                  <td className={cn(TD, NUM)}>{compact(provider.input_tokens)}</td>
                  <td className={cn(TD, NUM)}>{compact(provider.output_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Recording" description="Everything is stored as plain files in FalconDeck's folder on this Mac.">
        <SettingList>
          <SwitchRow
            title="Record activity"
            description="Counts, timings and file paths. No message content except your own messages, below."
            checked={status?.settings.enabled ?? true}
            disabled={!status}
            onCheckedChange={(enabled) => saveSettings({ enabled })}
          />
          <SwitchRow
            title="Keep your messages"
            description="Save the full text of what you send to agents so you can search it later."
            checked={status?.settings.record_prompts ?? true}
            disabled={!status || !status.settings.enabled}
            onCheckedChange={(record_prompts) => saveSettings({ record_prompts })}
          />
          <SettingRow
            title="Keep activity for"
            description="Older activity is deleted automatically. Your messages are kept until you delete them."
            control={
              <SegmentedControl
                ariaLabel="Keep activity for"
                value={String(status?.settings.retention_months ?? 12)}
                onChange={(value) => saveSettings({ retention_months: Number(value) })}
                options={RETENTION}
              />
            }
          />
          <SettingRow
            title="Storage"
            description={
              status ? (
                <span className="flex items-center gap-1.5">
                  <span className="fd-type-mono min-w-0 truncate" title={status.folder}>
                    {status.folder}
                  </span>
                  <CopyButton text={status.folder} label="Copy folder path" />
                </span>
              ) : (
                'Not connected'
              )
            }
            control={
              <span className="text-[length:var(--fd-text-xs)] tabular-nums text-fg-tertiary">
                {status ? `${bytes(status.events_bytes)} activity · ${bytes(status.prompts_bytes)} messages` : '—'}
              </span>
            }
          />
        </SettingList>
        <div className="flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <p className="min-w-0 flex-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
                {confirming === 'prompts'
                  ? 'Delete every recorded message you sent? This cannot be undone.'
                  : 'Delete all recorded activity? This cannot be undone.'}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void clear(confirming)}>
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" disabled={!status} onClick={() => setConfirming('prompts')}>
                Delete your messages
              </Button>
              <Button variant="ghost" size="sm" disabled={!status} onClick={() => setConfirming('events')}>
                Delete activity
              </Button>
            </>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
