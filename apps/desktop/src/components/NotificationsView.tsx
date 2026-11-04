import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  CircleAlert,
  CircleCheck,
  FileText,
  Inbox,
  Megaphone,
  MessageCircleQuestion,
  RefreshCw,
} from 'lucide-react'

import {
  LocalPathProvider,
  MessageMarkdown,
  type LocalPathEditor,
  type LocalPathHandler,
  type LocalPathKindResolver,
} from '@falcondeck/chat-ui'
import {
  NOTIFICATION_FILTERS,
  notificationAction,
  notificationDays,
  notificationIsWaiting,
  type NotificationFilter,
  type NotificationRecord,
} from '@falcondeck/client-core'
import { ActivityDiamond, Button, EmptyState, MainView, MainViewBody, cn } from '@falcondeck/ui'

import type { FilePreviewTarget } from '../local-file-links'
import { reviewAge } from '../review-inbox'
import type { NotificationCentre, NotificationCentreApi } from '../hooks/useNotificationCentre'

export type NotificationsViewProps = {
  centre: NotificationCentre
  api: Pick<NotificationCentreApi, 'getNotification'> | null
  /** Open a report from outside, e.g. a notice banner. `key` makes a repeat count. */
  openRequest?: { id: string; key: number } | null
  onOpenThread: (workspaceId: string, threadId: string) => void
  onOpenReview: (reviewId: string) => void
  onPreview: (target: FilePreviewTarget) => void
  onLocalPath?: LocalPathHandler | null
  localPathEditors?: readonly LocalPathEditor[]
  describeLocalPath?: LocalPathKindResolver | null
}

const EMPTY_COPY: Record<NotificationFilter, { title: string; description: string }> = {
  all: {
    title: 'Nothing here yet',
    description: 'Everything that asks for your attention lands here, so a missed alert is never lost.',
  },
  needs_you: { title: 'Nothing needs you', description: 'Approvals, questions and reviews that are waiting show up here.' },
  bots: { title: 'Nothing from bots', description: 'Bots and agents report here when something happens that needs no decision.' },
}

function KindIcon({ record }: { record: NotificationRecord }) {
  const className = 'h-4 w-4'
  if (record.kind === 'agent_notice') {
    return record.has_body ? <FileText aria-hidden="true" className={className} /> : <Megaphone aria-hidden="true" className={className} />
  }
  if (record.kind === 'review') return <Inbox aria-hidden="true" className={className} />
  if (record.kind === 'input_required') return <MessageCircleQuestion aria-hidden="true" className={className} />
  if (record.kind === 'error') return <CircleAlert aria-hidden="true" className={className} />
  return <CircleCheck aria-hidden="true" className={className} />
}

function iconTone(record: NotificationRecord): string {
  if (record.kind === 'error') return 'text-danger'
  if (notificationIsWaiting(record)) return 'text-warning'
  if (record.kind === 'agent_notice') return 'text-accent'
  return 'text-fg-muted'
}

function NotificationRow({ record, onOpen }: { record: NotificationRecord; onOpen: () => void }) {
  const unread = !record.read_at
  const detail = [
    record.bot,
    record.importance === 'high' ? 'High importance' : null,
    record.resolved_at ? 'Resolved' : null,
    record.repeat_count > 0 ? `${record.repeat_count + 1} updates` : null,
  ].filter(Boolean)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${unread ? 'Unread: ' : ''}${record.title}. ${record.preview}`}
        className="fd-focus-inset flex w-full items-start gap-3 rounded-[var(--fd-radius-md)] px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <span aria-hidden="true" className="flex h-5 w-2 shrink-0 items-center justify-center">
          {unread ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        </span>
        <span className={cn('mt-0.5 shrink-0', iconTone(record))}>
          <KindIcon record={record} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className={cn('min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-fg-primary', unread ? 'font-semibold' : 'font-medium')}>
              {record.title}
            </span>
            <span className="shrink-0 text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">{reviewAge(record.created_at)}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 text-[length:var(--fd-text-sm)] text-fg-secondary">{record.preview}</span>
          {detail.length > 0 ? (
            <span className="mt-0.5 block text-[length:var(--fd-text-xs)] text-fg-muted">{detail.join(' · ')}</span>
          ) : null}
        </span>
      </button>
    </li>
  )
}

function NotificationReport({
  id,
  summary,
  api,
  onBack,
  onOpenThread,
  onPreview,
  onLocalPath,
  localPathEditors,
  describeLocalPath,
}: Pick<NotificationsViewProps, 'api' | 'onOpenThread' | 'onPreview' | 'onLocalPath' | 'localPathEditors' | 'describeLocalPath'> & {
  id: string
  /** The row it was opened from, shown until the report arrives. */
  summary: NotificationRecord | null
  onBack: () => void
}) {
  const [loaded, setLoaded] = useState<{ id: string; record: NotificationRecord } | null>(null)
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)
  useEffect(() => {
    if (!api) return
    let current = true
    api.getNotification(id).then(
      (next) => {
        if (current) setLoaded({ id, record: next })
      },
      (error: unknown) => {
        if (!current) return
        const gone = (error as { status?: number } | null)?.status === 404
        setFailed({
          id,
          message: gone
            ? 'This report is no longer available.'
            : error instanceof Error
              ? error.message
              : 'This report could not be loaded.',
        })
      },
    )
    return () => {
      current = false
    }
  }, [api, id])

  const record = loaded?.id === id ? loaded.record : summary
  const error = failed?.id === id ? failed.message : null
  const body = loaded?.id === id ? loaded.record.body : undefined
  const workspaceId = record?.workspace_id
  const threadId = record?.thread_id
  const localPath = useCallback<LocalPathHandler>(
    (action, path, editorId) => {
      if (action === 'preview') {
        onPreview({ path, workspaceId: workspaceId ?? undefined, threadId: threadId ?? undefined })
        return
      }
      return onLocalPath?.(action, path, editorId)
    },
    [onLocalPath, onPreview, threadId, workspaceId],
  )
  const when = record ? new Date(record.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : undefined

  return (
    <MainView
      icon={
        <Button type="button" variant="ghost" size="icon" aria-label="Back to notifications" onClick={onBack}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Button>
      }
      title={record?.title ?? 'Report'}
      meta={[record?.bot, when].filter(Boolean).join(' · ') || undefined}
      actions={
        workspaceId && threadId ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenThread(workspaceId, threadId)}>
            Open task
          </Button>
        ) : null
      }
    >
      <MainViewBody layout="workspace">
        <div className="h-full overflow-y-auto">
          <article className="mx-auto max-w-3xl px-6 py-6">
            {error ? (
              <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">{error}</p>
            ) : body !== undefined ? (
              <LocalPathProvider onLocalPath={localPath} editors={localPathEditors} describePath={describeLocalPath}>
                <MessageMarkdown text={body} defer={false} interpretDirectives={false} />
              </LocalPathProvider>
            ) : loaded?.id === id ? (
              <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">{record?.preview}</p>
            ) : (
              <div role="status" aria-label="Loading report" className="flex justify-center py-10">
                <ActivityDiamond size="lg" />
              </div>
            )}
          </article>
        </div>
      </MainViewBody>
    </MainView>
  )
}

export function NotificationsView({
  centre,
  api,
  openRequest = null,
  onOpenThread,
  onOpenReview,
  onPreview,
  onLocalPath = null,
  localPathEditors,
  describeLocalPath = null,
}: NotificationsViewProps) {
  const { records, counts, filter, setFilter, loading, loadingMore, hasMore, error, refresh, loadMore, markRead, markAllRead } = centre
  const days = useMemo(() => notificationDays(records), [records])
  const [reportId, setReportId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!openRequest) return
    setReportId(openRequest.id)
    void markRead(openRequest.id)
  }, [markRead, openRequest])

  const open = useCallback(
    (record: NotificationRecord) => {
      void markRead(record.id)
      const action = notificationAction(record)
      if (action.type === 'report') setReportId(record.id)
      else if (action.type === 'review') onOpenReview(action.review_id)
      else if (action.type === 'thread') onOpenThread(action.workspace_id, action.thread_id)
    },
    [markRead, onOpenReview, onOpenThread],
  )

  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  if (reportId) {
    return (
      <NotificationReport
        id={reportId}
        summary={records.find((record) => record.id === reportId) ?? null}
        api={api}
        onBack={() => setReportId(null)}
        onOpenThread={onOpenThread}
        onPreview={onPreview}
        onLocalPath={onLocalPath}
        localPathEditors={localPathEditors}
        describeLocalPath={describeLocalPath}
      />
    )
  }

  const meta = [
    counts.unread_count > 0 ? `${counts.unread_count} unread` : null,
    counts.needs_you_count > 0 ? `${counts.needs_you_count} need you` : null,
  ].filter(Boolean).join(' · ')
  const empty = EMPTY_COPY[filter]

  return (
    <MainView
      icon={<Bell aria-hidden="true" className="h-4 w-4" />}
      title="Notifications"
      meta={meta || undefined}
      actions={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={() => void markAllRead()} disabled={counts.unread_count === 0}>
            Mark all read
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Refresh notifications" onClick={() => void refreshNow()} disabled={refreshing}>
            {refreshing ? <ActivityDiamond size="md" tone="current" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
          </Button>
        </>
      }
    >
      <MainViewBody layout="workspace">
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 pb-6">
            <div className="sticky top-0 z-10 bg-surface-1 py-3">
              <div role="group" aria-label="Filter notifications" className="flex gap-1">
                {NOTIFICATION_FILTERS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={filter === option.value}
                    onClick={() => setFilter(option.value)}
                    className={cn(
                      'fd-focus rounded-[var(--fd-radius-md)] px-3 py-1.5 text-[length:var(--fd-text-sm)] transition-colors',
                      filter === option.value ? 'bg-surface-3 text-fg-primary' : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {error ? (
              <p role="alert" className="px-3 pb-3 text-[length:var(--fd-text-xs)] text-danger">{error}</p>
            ) : null}
            {loading && records.length === 0 ? (
              <div role="status" aria-label="Loading notifications" className="flex justify-center py-10">
                <ActivityDiamond size="lg" />
              </div>
            ) : null}
            {!loading && records.length === 0 && !error ? (
              <EmptyState icon={<Bell aria-hidden="true" className="h-6 w-6" />} title={empty.title} description={empty.description} />
            ) : null}
            {days.map((day) => (
              <section key={day.key} aria-label={day.label}>
                <h2 className="fd-type-eyebrow px-3 pb-1 pt-3 text-fg-muted">{day.label}</h2>
                <ul>
                  {day.items.map((record) => (
                    <NotificationRow key={record.id} record={record} onOpen={() => open(record)} />
                  ))}
                </ul>
              </section>
            ))}
            {hasMore ? (
              <div className="px-3 py-3">
                <Button type="button" variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Show older'}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </MainViewBody>
    </MainView>
  )
}
