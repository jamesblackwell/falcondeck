import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from 'lucide-react'
import {
  formatReceivedAgo,
  resolveBotIcons,
  type AnalyticsThreadActivity,
  type BotProfile,
  type ThreadSummary,
} from '@falcondeck/client-core'
import { BotMark } from '@falcondeck/chat-ui'
import { ActivityDiamond, StatusIndicator } from '@falcondeck/ui'
import { useThreadResource } from '../../hooks/useThreadResource'

export type ThreadActivityContext = {
  threads: readonly ThreadSummary[]
  bots: readonly BotProfile[]
  loadMessages: (id: string) => Promise<AnalyticsThreadActivity>
  onSelectThread: (workspaceId: string, threadId: string) => void
}

const LIMIT = 8
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000
export const ACTIVITY_ROW_CLASS = 'fd-focus-inset flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-secondary hover:bg-interactive-hover disabled:cursor-default disabled:hover:bg-transparent'
const ROW_CLASS = ACTIVITY_ROW_CLASS

export function ActivitySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-3 border-t border-border-subtle pt-3">
      <h3 className="px-3 pb-1 text-2xs font-medium uppercase tracking-[0.08em] text-fg-muted">{title}</h3>
      {children}
    </section>
  )
}
const Section = ActivitySection

function Expand({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`${ROW_CLASS} text-fg-muted`} onClick={onClick} aria-expanded={expanded}>
      <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 ${expanded ? 'rotate-180' : ''}`} />
      {expanded ? 'Show less' : 'Show all'}
    </button>
  )
}

export function ThreadActivity({ thread, context }: { thread: ThreadSummary; context: ThreadActivityContext }) {
  const result = useThreadResource(thread.id, thread.updated_at, context.loadMessages)
  const [expandedDispatches, setExpandedDispatches] = useState(false)
  const [expandedMessages, setExpandedMessages] = useState(false)
  const threads = useMemo(() => new Map(context.threads.map((task) => [task.id, task])), [context.threads])
  const bots = useMemo(() => new Map(context.bots.map((bot) => [bot.thread_id, bot])), [context.bots])
  const icons = useMemo(() => resolveBotIcons(context.bots), [context.bots])
  const now = result.observedAt
  const dispatchTimes = new Map(result?.data?.dispatches.map((dispatch) => [dispatch.thread_id, dispatch.at]))
  const dispatched = context.threads.flatMap((task) => {
    if (task.origin?.kind !== 'agent_spawn' || task.origin.parent_thread_id !== thread.id) return []
    const at = task.origin.dispatched_at ?? dispatchTimes.get(task.id)
    const time = at ? Date.parse(at) : NaN
    return at && time >= now - WINDOW_MS && time <= now ? [{ task, at, time }] : []
  }).sort((a, b) => b.time - a.time)
  const parentId = thread.origin?.kind === 'agent_spawn' ? thread.origin.parent_thread_id : null
  const messages = result?.data?.analytics_enabled ? result.data.messages : []
  const name = (id: string) => bots.get(id)?.name ?? threads.get(id)?.title ?? id
  const open = (id: string) => {
    const workspaceId = threads.get(id)?.workspace_id ?? bots.get(id)?.workspace_id
    if (workspaceId) context.onSelectThread(workspaceId, id)
  }
  const canOpen = (id: string) => threads.has(id) || bots.has(id)
  const mark = (id: string) => {
    const bot = bots.get(id)
    const icon = bot && icons.get(bot.id)
    return icon ? <BotMark icon={icon} /> : null
  }

  if (!parentId && !dispatched.length && !messages.length && !result?.error && result?.data?.analytics_enabled !== false) return null
  return (
    <div aria-label="Activity">
      {parentId ? (
        <div className="mt-3 border-t border-border-subtle pt-2">
          <button type="button" className={ROW_CLASS} disabled={!canOpen(parentId)} onClick={() => open(parentId)}>
            {mark(parentId)}
            <span className="truncate">Dispatched by {name(parentId)}</span>
          </button>
        </div>
      ) : null}
      {dispatched.length ? (
        <Section title="Dispatched">
          {(expandedDispatches ? dispatched : dispatched.slice(0, LIMIT)).map(({ task, at }) => (
            <button key={task.id} type="button" className={ROW_CLASS} onClick={() => open(task.id)}>
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" role="img" aria-label={task.status.replaceAll('_', ' ')}>
                {task.status === 'running' ? <ActivityDiamond size="xs" /> : <StatusIndicator status={task.status === 'waiting_for_input' ? 'warning' : task.status} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{name(task.id)}</span>
              <time dateTime={at} title={new Date(at).toLocaleString()} className="shrink-0 text-xs text-fg-muted">{formatReceivedAgo(at, now)}</time>
            </button>
          ))}
          {dispatched.length > LIMIT ? <Expand expanded={expandedDispatches} onClick={() => setExpandedDispatches(!expandedDispatches)} /> : null}
        </Section>
      ) : null}
      {messages.length || result?.data?.analytics_enabled === false || result?.error ? (
        <Section title="Messages">
          {result?.data?.analytics_enabled === false ? <p className="px-3 text-xs text-fg-muted">Enable analytics in Settings to see agent messages.</p> : result?.error ? <p className="px-3 text-xs text-fg-muted">Could not load messages.</p> : (
            <>
              {(expandedMessages ? messages : messages.slice(0, LIMIT)).map((message, index) => {
                const outbound = message.from === thread.id
                const counterpart = outbound ? message.to : message.from
                const Arrow = outbound ? ArrowUpRight : ArrowDownLeft
                return (
                  <button key={`${message.at}:${index}`} type="button" className={ROW_CLASS} disabled={!canOpen(counterpart)} onClick={() => open(counterpart)} aria-label={`${outbound ? 'To' : 'From'} ${name(counterpart)}: ${message.excerpt}`}>
                    <Arrow aria-hidden="true" className="h-3.5 w-3.5 shrink-0 self-start text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {mark(counterpart)}
                        <span className="min-w-0 flex-1 truncate">{name(counterpart)}</span>
                        {message.delivery === 'steer' || message.delivery === 'queue' ? <span className="text-xs text-fg-muted">{message.delivery}</span> : null}
                        <time dateTime={message.at} title={new Date(message.at).toLocaleString()} className="shrink-0 text-xs text-fg-muted">{formatReceivedAgo(message.at, now)}</time>
                      </span>
                      <span className="block truncate text-xs text-fg-muted">{message.excerpt}</span>
                    </span>
                  </button>
                )
              })}
              {messages.length > LIMIT ? <Expand expanded={expandedMessages} onClick={() => setExpandedMessages(!expandedMessages)} /> : null}
            </>
          )}
        </Section>
      ) : null}
    </div>
  )
}
