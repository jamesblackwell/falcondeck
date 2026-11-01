import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Inbox, RefreshCw } from 'lucide-react'

import {
  BotMark,
  LocalPathProvider,
  type LocalPathEditor,
  type LocalPathHandler,
  type LocalPathKindResolver,
} from '@falcondeck/chat-ui'
import {
  REVIEW_STATUS_LABELS,
  resolveBotIcons,
  type BotIcon,
  reviewOutcomeSummary,
  type BotProfile,
  type Review,
} from '@falcondeck/client-core'
import {
  ActivityDiamond,
  Button,
  EmptyState,
  MainView,
  MainViewBody,
  cn,
} from '@falcondeck/ui'

import type { FilePreviewTarget } from '../local-file-links'
import type { ReviewInbox } from '../hooks/useReviewInbox'
import { goingAhead, openReviewCount, reviewAge, reviewSections } from '../review-inbox'
import { ReviewDetail, ReviewStatusBadge, type ReviewDetailApi } from './ReviewDetail'

const HISTORY_PAGE = 12

export type ReviewsViewProps = {
  inbox: ReviewInbox
  api: ReviewDetailApi | null
  bots?: readonly BotProfile[]
  /** Select a review from outside, e.g. from a notification. `key` makes a repeat request count. */
  openRequest?: { id: string; key: number } | null
  onPreview: (target: FilePreviewTarget) => void
  onOpenThread?: ((workspaceId: string | null, threadId: string) => void) | null
  /** Host handler for non-preview path actions (open, reveal, …) from links in the body. */
  onLocalPath?: LocalPathHandler | null
  localPathEditors?: readonly LocalPathEditor[]
  describeLocalPath?: LocalPathKindResolver | null
}

function useBotLookup(bots: readonly BotProfile[] | undefined) {
  return useMemo(() => {
    const list = bots ?? []
    const icons = resolveBotIcons(list)
    return (name: string | null) => {
      const bot = name ? list.find((candidate) => candidate.name === name) : undefined
      return bot ? { name: bot.name, icon: icons.get(bot.id) } : null
    }
  }, [bots])
}

function ReviewRow({
  review,
  selected,
  bot,
  onSelect,
}: {
  review: Review
  selected: boolean
  bot: { name: string; icon: BotIcon | undefined } | null
  onSelect: () => void
}) {
  const isOpen = review.status === 'open'
  const ahead = isOpen ? goingAhead(review) : null
  const who = bot?.name ?? review.bot ?? review.created_by.name
  const failedDelivery = review.delivery?.state === 'failed'
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${review.id} ${review.title}`}
        className={cn(
          'fd-focus-inset flex w-full flex-col gap-1 border-b border-border-subtle px-4 py-3 text-left transition-colors',
          selected ? 'bg-surface-3' : 'hover:bg-surface-2',
          !isOpen && !selected && 'opacity-75',
        )}
      >
        <span className="flex items-center gap-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          {bot?.icon ? <BotMark icon={bot.icon} size={12} /> : null}
          <span className="min-w-0 flex-1 truncate">{who}</span>
          <span className="shrink-0 tabular-nums">{reviewAge(review.created_at)}</span>
        </span>
        <span
          className={cn(
            'text-[length:var(--fd-text-sm)] text-fg-primary',
            isOpen ? 'font-semibold' : 'font-medium',
          )}
        >
          {review.title}
        </span>
        <span className="line-clamp-2 text-[length:var(--fd-text-xs)] text-fg-secondary">{review.ask}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
          {isOpen ? (
            <>
              <span>
                {review.items.length} {review.items.length === 1 ? 'item' : 'items'}
              </span>
              {ahead ? (
                <span className={cn('inline-flex items-center gap-1', ahead.passed && 'text-warning')}>
                  <Clock aria-hidden="true" className="h-3 w-3" />
                  {ahead.label.replace(' unless you say no', '')}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <ReviewStatusBadge review={review} />
              {review.status !== 'withdrawn' ? <span>{reviewOutcomeSummary(review)}</span> : null}
              {failedDelivery ? <span className="text-danger">Not delivered</span> : null}
            </>
          )}
        </span>
      </button>
    </li>
  )
}

export function ReviewsView({
  inbox,
  api,
  bots,
  openRequest = null,
  onPreview,
  onOpenThread = null,
  onLocalPath = null,
  localPathEditors,
  describeLocalPath = null,
}: ReviewsViewProps) {
  const { reviews, loading, error, refresh, drafts, updateDraft, clearDraft, accept } = inbox
  const sections = useMemo(() => reviewSections(reviews), [reviews])
  const botFor = useBotLookup(bots)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE)
  const [refreshing, setRefreshing] = useState(false)

  // Land on something: the review a notification named, else the newest open one.
  useEffect(() => {
    if (openRequest) setSelectedId(openRequest.id)
  }, [openRequest])
  const selected = reviews.find((review) => review.id === selectedId) ?? null
  const fallback = sections.open[0] ?? sections.history[0] ?? null
  const shown = selected ?? (openRequest && loading ? null : fallback)
  // Once something is showing, it stays: a newer review arriving must not swap
  // the one being read (and answered) out from under the reader.
  const shownId = shown?.id ?? null
  useEffect(() => {
    if (shownId) setSelectedId((current) => current ?? shownId)
  }, [selectedId, shownId])

  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  const localPath = useCallback<LocalPathHandler>(
    (action, path, editorId) => {
      if (action === 'preview') {
        onPreview({
          path,
          workspaceId: shown?.source_workspace_id ?? undefined,
          threadId: shown?.source_thread_id ?? undefined,
        })
        return
      }
      return onLocalPath?.(action, path, editorId)
    },
    [onLocalPath, onPreview, shown?.source_thread_id, shown?.source_workspace_id],
  )

  const openCount = openReviewCount(reviews)
  const meta =
    openCount > 0 ? `${openCount} waiting on you` : reviews.length > 0 ? 'Nothing waiting' : undefined

  return (
    <MainView
      icon={<Inbox aria-hidden="true" className="h-4 w-4" />}
      title="Reviews"
      meta={meta}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh reviews"
          onClick={() => void refreshNow()}
          disabled={refreshing}
        >
          {refreshing ? <ActivityDiamond size="md" tone="current" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
        </Button>
      }
    >
      <MainViewBody layout="workspace">
        <div className="flex h-full min-h-0">
          <nav
            aria-label="Reviews"
            className="flex w-[22rem] max-w-[40%] shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-surface-1"
          >
            {error ? (
              <p role="alert" className="border-b border-border-subtle px-4 py-3 text-[length:var(--fd-text-xs)] text-danger">
                {error}
              </p>
            ) : null}
            {loading && reviews.length === 0 ? (
              <div role="status" aria-label="Loading reviews" className="flex justify-center py-10">
                <ActivityDiamond size="lg" />
              </div>
            ) : null}
            {!loading && reviews.length === 0 && !error ? (
              <EmptyState
                icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
                title="Nothing to review"
                description="When an agent needs a decision from you, it shows up here with the evidence."
              />
            ) : null}
            {sections.open.length > 0 ? (
              <section aria-label="Open reviews">
                <h2 className="fd-type-eyebrow flex items-baseline gap-2 px-4 pb-1.5 pt-3 text-fg-muted">
                  Open
                  <span className="fd-type-meta tabular-nums">{sections.open.length}</span>
                </h2>
                <ul>
                  {sections.open.map((review) => (
                    <ReviewRow
                      key={review.id}
                      review={review}
                      bot={botFor(review.bot)}
                      selected={shown?.id === review.id}
                      onSelect={() => setSelectedId(review.id)}
                    />
                  ))}
                </ul>
              </section>
            ) : reviews.length > 0 ? (
              <p className="px-4 py-4 text-[length:var(--fd-text-sm)] text-fg-muted">Nothing is waiting on you.</p>
            ) : null}
            {sections.history.length > 0 ? (
              <section aria-label="History" className="mt-2">
                <h2 className="fd-type-eyebrow flex items-baseline gap-2 px-4 pb-1.5 pt-3 text-fg-muted">
                  History
                  <span className="fd-type-meta tabular-nums">{sections.history.length}</span>
                </h2>
                <ul>
                  {sections.history.slice(0, historyShown).map((review) => (
                    <ReviewRow
                      key={review.id}
                      review={review}
                      bot={botFor(review.bot)}
                      selected={shown?.id === review.id}
                      onSelect={() => setSelectedId(review.id)}
                    />
                  ))}
                </ul>
                {sections.history.length > historyShown ? (
                  <div className="px-4 py-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setHistoryShown((count) => count + HISTORY_PAGE)}
                    >
                      Show {Math.min(HISTORY_PAGE, sections.history.length - historyShown)} more
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </nav>

          <div className="min-w-0 flex-1">
            {shown ? (
              <LocalPathProvider
                onLocalPath={localPath}
                editors={localPathEditors}
                describePath={describeLocalPath}
              >
                <ReviewDetail
                  key={shown.id}
                  review={shown}
                  api={api}
                  draft={drafts[shown.id] ?? { items: {} }}
                  bot={botFor(shown.bot)}
                  onDraftChange={(change) => updateDraft(shown.id, change)}
                  onDraftClear={() => clearDraft(shown.id)}
                  onChanged={(changed) => {
                    setSelectedId(changed.id)
                    accept(changed)
                  }}
                  onPreview={onPreview}
                  onOpenThread={onOpenThread}
                />
              </LocalPathProvider>
            ) : (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  title={reviews.length > 0 ? 'Choose a review' : loading ? 'Loading reviews' : 'No reviews yet'}
                  description={
                    reviews.length > 0
                      ? `${REVIEW_STATUS_LABELS.open} reviews are listed on the left.`
                      : undefined
                  }
                />
              </div>
            )}
          </div>
        </div>
      </MainViewBody>
    </MainView>
  )
}
