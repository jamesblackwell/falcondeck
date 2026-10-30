import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { BotMark, MessageMarkdown, ThreadLinkProvider } from '@falcondeck/chat-ui'
import { Switch } from '@falcondeck/ui'
import { formatReceivedAgo, resolveBotIcons, type Automation, type BotProfile, type ThreadSummary } from '@falcondeck/client-core'
import { useThreadResource } from '../../hooks/useThreadResource'
import { ActivitySection, ACTIVITY_ROW_CLASS, ThreadActivity, type ThreadActivityContext } from './ThreadActivity'
import { readBotSidebar, setScheduleEnabled, type BotSidebarApi } from './bot-sidebar-data'

export type BotInfoContext = {
  api: BotSidebarApi
  onOpenTickets: () => void
  onOpenAutomation: (id: string) => void
  onError: (title: string, description: string) => void
}

function More({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`${ACTIVITY_ROW_CLASS} text-fg-muted`} aria-expanded={expanded}>
    <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 ${expanded ? 'rotate-180' : ''}`} />
    {expanded ? 'Show less' : 'Show all'}
  </button>
}

export function BotInfo({ bot, thread, activity, context, children }: {
  bot: BotProfile
  thread: ThreadSummary
  activity: ThreadActivityContext
  context: BotInfoContext
  children: ReactNode
}) {
  const load = useCallback(() => readBotSidebar(context.api, bot.id, bot.name), [context.api, bot.id, bot.name])
  const result = useThreadResource(bot.id, thread.updated_at, load)
  const data = result.data
  const [statusExpanded, setStatusExpanded] = useState(false)
  const [statusOverflow, setStatusOverflow] = useState(false)
  const [ticketsExpanded, setTicketsExpanded] = useState(false)
  const [schedulesExpanded, setSchedulesExpanded] = useState(false)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Record<string, Automation>>({})
  const statusRef = useRef<HTMLDivElement>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useLayoutEffect(() => {
    const node = statusRef.current
    if (!node || statusExpanded) return
    const measure = () => setStatusOverflow(node.scrollHeight > node.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [data?.status?.content, statusExpanded])
  const icon = useMemo(() => resolveBotIcons(activity.bots).get(bot.id), [activity.bots, bot.id])
  const targetIds = new Set([bot.thread_id, ...activity.threads.filter((task) => task.origin?.kind === 'agent_spawn' && task.origin.parent_thread_id === bot.thread_id).map((task) => task.id)])
  const schedules = (data?.schedules ?? []).map((schedule) => {
    const override = overrides[schedule.id]
    return override && override.revision > schedule.revision ? override : schedule
  }).filter((schedule) => schedule.target.thread && 'thread_id' in schedule.target.thread && targetIds.has(schedule.target.thread.thread_id ?? ''))
    .sort((a, b) => (a.next_run_at ?? 'z').localeCompare(b.next_run_at ?? 'z') || a.name.localeCompare(b.name))
  const tickets = (data?.tickets ?? []).filter((ticket) => ticket.owner === bot.name && ticket.state !== 'done' && ticket.state !== 'dropped')
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.created_at.localeCompare(b.created_at))
  const modifiedAt = data?.status?.modified_at
  const stale = modifiedAt && result.observedAt - Date.parse(modifiedAt) > 24 * 60 * 60 * 1000
  const toggle = async (schedule: Automation, enabled: boolean) => {
    if (pending.has(schedule.id)) return
    setPending((ids) => new Set(ids).add(schedule.id))
    try {
      const updated = await setScheduleEnabled(context.api, schedule, enabled)
      if (active.current) setOverrides((rows) => ({ ...rows, [updated.id]: updated }))
    } catch (error) {
      if (active.current) context.onError('Could not update automation', error instanceof Error ? error.message : String(error))
    } finally {
      if (active.current) {
        setPending((ids) => { const next = new Set(ids); next.delete(schedule.id); return next })
        result.refresh()
      }
    }
  }
  return <div className="pb-4 pt-3">
    <div className="flex items-center gap-2 px-3 pb-1">
      {icon ? <BotMark icon={icon} size={24} /> : null}
      <h2 className="min-w-0 truncate text-base font-semibold text-fg-primary">{bot.name}</h2>
    </div>
    <ActivitySection title="Status">
      {modifiedAt ? <p className="mb-2 px-3 text-xs text-fg-muted">
        <time dateTime={modifiedAt} title={stale ? 'STATUS.md is more than 24 hours old' : new Date(modifiedAt).toLocaleString()} className={stale ? 'rounded-[var(--fd-radius-sm)] bg-warning-muted px-1 py-0.5 text-warning' : undefined}>Updated {formatReceivedAgo(modifiedAt, result.observedAt)}</time>
      </p> : null}
      {data?.status?.content.trim() ? <>
        <ThreadLinkProvider onOpenThread={(id) => {
          const target = activity.threads.find((task) => task.id === id)
          if (target) activity.onSelectThread(target.workspace_id, target.id)
          else context.onError('Task unavailable', 'This task is no longer available on this computer.')
        }}>
          <div ref={statusRef} className={`px-3 text-sm text-fg-secondary ${statusExpanded ? '' : 'max-h-[calc(12*1.6*var(--fd-text-sm))] overflow-hidden'}`}>
            <MessageMarkdown text={data.status.content} interpretDirectives={false} />
          </div>
        </ThreadLinkProvider>
        {statusOverflow || statusExpanded ? <button type="button" className={`${ACTIVITY_ROW_CLASS} text-fg-muted`} aria-expanded={statusExpanded} onClick={() => setStatusExpanded(!statusExpanded)}>{statusExpanded ? 'Show less' : 'Show more'}</button> : null}
      </> : <p className="px-3 text-xs text-fg-muted">{data?.statusError || result.error ? 'Could not load STATUS.md.' : data ? 'No STATUS.md yet' : 'Loading status…'}</p>}
    </ActivitySection>
    <ThreadActivity thread={thread} context={activity} />
    {tickets.length || data?.ticketsError ? <ActivitySection title="Tickets">
      {data?.ticketsError ? <p className="px-3 text-xs text-fg-muted">Could not load tickets.</p> : (ticketsExpanded ? tickets : tickets.slice(0, 8)).map((ticket) => <button key={ticket.id} type="button" aria-label={`${ticket.id}: ${ticket.title}`} className={ACTIVITY_ROW_CLASS} onClick={context.onOpenTickets}>
        <span className="shrink-0 text-xs text-fg-muted">{ticket.id}</span>
        <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
        <span className="shrink-0 text-xs text-fg-muted">{ticket.priority}</span>
      </button>)}
      {tickets.length > 8 ? <More expanded={ticketsExpanded} onClick={() => setTicketsExpanded(!ticketsExpanded)} /> : null}
    </ActivitySection> : null}
    {schedules.length || data?.schedulesError ? <ActivitySection title="Schedules">
      {data?.schedulesError ? <p className="px-3 text-xs text-fg-muted">Could not load schedules.</p> : (schedulesExpanded ? schedules : schedules.slice(0, 8)).map((schedule) => {
        const flags = data?.health.find((health) => health.id === schedule.id)?.flags ?? []
        return <div key={schedule.id} className="mx-3 mb-2 flex min-w-0 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 pr-2">
          <button type="button" aria-label={`Edit ${schedule.name}`} className={`${ACTIVITY_ROW_CLASS} flex-1 flex-col items-stretch gap-1 rounded-[inherit] px-2`} onClick={() => context.onOpenAutomation(schedule.id)}>
            <span className="truncate font-medium">{schedule.name}</span>
            <span className="truncate text-xs text-fg-muted" title={schedule.resolved_schedule}>{schedule.resolved_schedule}</span>
            <span className="truncate text-xs text-fg-muted">{schedule.state === 'enabled' && schedule.next_run_at ? `Next ${new Date(schedule.next_run_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : schedule.state}</span>
            {flags.length ? <span className="truncate text-xs text-fg-muted" title={flags.map((flag) => flag.replaceAll('_', ' ')).join(', ')}>{flags.map((flag) => flag.replaceAll('_', ' ')).join(' · ')}</span> : null}
          </button>
          <Switch label={`${schedule.name} enabled`} checked={schedule.state === 'enabled'} disabled={pending.has(schedule.id) || schedule.state === 'completed' || schedule.state === 'failed'} onCheckedChange={(enabled) => { void toggle(schedule, enabled) }} />
        </div>
      })}
      {schedules.length > 8 ? <More expanded={schedulesExpanded} onClick={() => setSchedulesExpanded(!schedulesExpanded)} /> : null}
    </ActivitySection> : null}
    <details className="mt-3 border-t border-border-subtle pt-2">
      <summary className="fd-focus-inset cursor-pointer px-3 py-1 text-sm text-fg-muted">Details</summary>
      <div className="pt-2">{children}</div>
    </details>
  </div>
}
