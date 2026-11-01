import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Clock, ExternalLink, FileText, Link2 } from 'lucide-react'

import { BotMark, MessageMarkdown } from '@falcondeck/chat-ui'
import {
  REVIEW_DECISIONS,
  REVIEW_DECISION_LABELS,
  REVIEW_STATUS_LABELS,
  buildRespondArgs,
  type BotIcon,
  type DaemonApiClient,
  type Review,
  type ReviewDecision,
  type ReviewDraft,
  type ReviewEvidence,
  type ReviewItem,
} from '@falcondeck/client-core'
import { ActivityDiamond, Badge, Button, Card, Textarea, cn } from '@falcondeck/ui'

import {
  draftHasContent,
  evidenceChip,
  goingAhead,
  reviewAge,
  submitState,
} from '../review-inbox'
import type { FilePreviewTarget } from '../local-file-links'

export type ReviewDetailApi = Pick<
  DaemonApiClient,
  'readReview' | 'respondReview' | 'withdrawReview' | 'readFile'
>

const DECISION_TONE: Record<ReviewDecision, string> = {
  approve: 'border-success/60 bg-success-muted text-success',
  request_changes: 'border-warning/60 bg-warning-muted text-warning',
  reject: 'border-danger/60 bg-danger-muted text-danger',
}

const DECISION_BADGE: Record<ReviewDecision, 'success' | 'warning' | 'danger'> = {
  approve: 'success',
  request_changes: 'warning',
  reject: 'danger',
}

const STATUS_BADGE = {
  open: 'info',
  approved: 'success',
  changes_requested: 'warning',
  rejected: 'danger',
  withdrawn: 'default',
} as const

export function ReviewStatusBadge({ review }: { review: Review }) {
  return (
    <Badge variant={STATUS_BADGE[review.status]} dot>
      {REVIEW_STATUS_LABELS[review.status]}
    </Badge>
  )
}

/** Three exclusive choices as a radio group; arrow keys move and select. */
export function DecisionChips({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  value: ReviewDecision | undefined
  onChange: (decision: ReviewDecision | undefined) => void
  disabled?: boolean
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const current = value ? REVIEW_DECISIONS.indexOf(value) : step > 0 ? -1 : 0
    const next = (current + step + REVIEW_DECISIONS.length) % REVIEW_DECISIONS.length
    onChange(REVIEW_DECISIONS[next])
    refs.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="flex flex-wrap gap-2">
      {REVIEW_DECISIONS.map((decision, index) => {
        const selected = value === decision
        return (
          <button
            key={decision}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // One tab stop per group: the chosen chip, or the first when none is.
            tabIndex={selected || (!value && index === 0) ? 0 : -1}
            disabled={disabled}
            // A second click clears the choice, so a mis-tap is not permanent.
            onClick={() => onChange(selected ? undefined : decision)}
            className={cn(
              'fd-focus rounded-[var(--fd-radius-md)] border px-3 py-1.5 text-[length:var(--fd-text-sm)] font-medium transition-colors disabled:opacity-50',
              selected
                ? DECISION_TONE[decision]
                : 'border-border-default bg-surface-1 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
            )}
          >
            {REVIEW_DECISION_LABELS[decision]}
          </button>
        )
      })}
    </div>
  )
}

/** An image evidence thumbnail, read through the daemon like any file. */
function EvidenceImage({
  evidence,
  api,
  onOpen,
}: {
  evidence: ReviewEvidence
  api: Pick<ReviewDetailApi, 'readFile'> | null
  onOpen: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const path = evidence.open_path
  useEffect(() => {
    if (!api || !path) return
    let cancelled = false
    let objectUrl: string | null = null
    setFailed(false)
    api
      .readFile({ path })
      .then(({ blob }) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setUrl(null)
    }
  }, [api, path])

  const label = evidenceChip(evidence).label
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${label}`}
      className="fd-focus group flex w-full flex-col overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-0 text-left transition-colors hover:border-border-emphasis"
    >
      <span className="flex h-44 items-center justify-center overflow-hidden bg-[length:16px_16px] [background-image:repeating-conic-gradient(var(--fd-bg-1)_0%_25%,var(--fd-bg-2)_0%_50%)]">
        {url ? (
          <img src={url} alt={evidence.caption ?? label} className="max-h-full max-w-full object-contain" />
        ) : failed ? (
          <span className="px-3 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            Couldn’t load the image. Open it to see why.
          </span>
        ) : (
          <ActivityDiamond size="md" />
        )}
      </span>
      <span className="flex items-baseline gap-2 border-t border-border-subtle px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
          {label}
        </span>
        {evidenceChip(evidence).detail ? (
          <span className="fd-type-meta shrink-0 text-fg-muted">{evidenceChip(evidence).detail}</span>
        ) : null}
      </span>
      {evidence.caption ? (
        <span className="px-3 pb-2 text-[length:var(--fd-text-xs)] text-fg-secondary">{evidence.caption}</span>
      ) : null}
    </button>
  )
}

function EvidenceView({
  item,
  api,
  onPreview,
}: {
  item: ReviewItem
  api: Pick<ReviewDetailApi, 'readFile'> | null
  onPreview: (target: FilePreviewTarget) => void
}) {
  if (item.evidence.length === 0) return null
  const images = item.evidence.filter((evidence) => evidenceChip(evidence).isImage)
  const others = item.evidence.filter((evidence) => !evidenceChip(evidence).isImage)
  const open = (evidence: ReviewEvidence) => {
    const chip = evidenceChip(evidence)
    if (chip.path) onPreview({ path: chip.path, title: chip.label })
  }
  return (
    <div className="space-y-3">
      {images.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {images.map((evidence) => (
            <EvidenceImage key={evidence.id} evidence={evidence} api={api} onOpen={() => open(evidence)} />
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached files">
          {others.map((evidence) => {
            const chip = evidenceChip(evidence)
            const body = (
              <>
                {evidence.kind === 'url' ? (
                  <Link2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                ) : (
                  <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                )}
                <span className="min-w-0 max-w-[16rem] truncate font-medium text-fg-primary">{chip.label}</span>
                {chip.detail ? <span className="fd-type-meta shrink-0 text-fg-muted">{chip.detail}</span> : null}
                {evidence.kind === 'url' ? (
                  <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-muted" />
                ) : null}
              </>
            )
            const className =
              'fd-focus inline-flex items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2.5 py-1.5 text-[length:var(--fd-text-xs)] transition-colors hover:border-border-emphasis hover:bg-surface-3'
            return (
              <li key={evidence.id}>
                {evidence.kind === 'url' && evidence.url ? (
                  <a href={evidence.url} className={className} title={evidence.url}>
                    {body}
                  </a>
                ) : (
                  <button type="button" onClick={() => open(evidence)} className={className} aria-label={`Open ${chip.label}`}>
                    {body}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="whitespace-pre-wrap border-l-2 border-border-emphasis pl-3 text-[length:var(--fd-text-sm)] text-fg-secondary">
      {text}
    </blockquote>
  )
}

function ItemCard({
  review,
  item,
  index,
  draft,
  readOnly,
  api,
  onDecision,
  onFeedback,
  onPreview,
}: {
  review: Review
  item: ReviewItem
  index: number
  draft: ReviewDraft['items'][string] | undefined
  readOnly: boolean
  api: Pick<ReviewDetailApi, 'readFile'> | null
  onDecision: (decision: ReviewDecision | undefined) => void
  onFeedback: (feedback: string) => void
  onPreview: (target: FilePreviewTarget) => void
}) {
  const feedbackId = useId()
  const decision = readOnly ? item.decision ?? undefined : draft?.decision
  return (
    <Card className="space-y-3 p-4" aria-labelledby={`${feedbackId}-title`}>
      <div className="flex items-baseline gap-2">
        <span className="fd-type-meta shrink-0 tabular-nums text-fg-muted">
          {index + 1} of {review.items.length}
        </span>
        <h3 id={`${feedbackId}-title`} className="min-w-0 flex-1 text-[length:var(--fd-text-base)] font-semibold text-fg-primary">
          {item.title}
        </h3>
        {readOnly && decision ? (
          <Badge variant={DECISION_BADGE[decision]}>{REVIEW_DECISION_LABELS[decision]}</Badge>
        ) : null}
      </div>
      {item.note.trim() ? (
        <div className="text-[length:var(--fd-text-sm)] text-fg-secondary">
          <MessageMarkdown text={item.note} defer={false} interpretDirectives={false} />
        </div>
      ) : null}
      <EvidenceView item={item} api={api} onPreview={onPreview} />
      {readOnly ? (
        item.feedback?.trim() ? <Quote text={item.feedback} /> : null
      ) : (
        <div className="space-y-2">
          <DecisionChips
            label={`Decision for ${item.title}`}
            value={decision}
            onChange={onDecision}
          />
          <label htmlFor={feedbackId} className="sr-only">
            Feedback for {item.title}
          </label>
          <Textarea
            id={feedbackId}
            rows={2}
            value={draft?.feedback ?? ''}
            onChange={(event) => onFeedback(event.target.value)}
            placeholder={
              decision === 'request_changes'
                ? 'What should change?'
                : 'Feedback (optional)'
            }
            className="min-h-[3.25rem] resize-y"
          />
        </div>
      )}
    </Card>
  )
}

export type ReviewDetailProps = {
  review: Review
  api: ReviewDetailApi | null
  draft: ReviewDraft
  bot?: { name: string; icon: BotIcon | undefined } | null
  onDraftChange: (change: (draft: ReviewDraft) => ReviewDraft) => void
  onDraftClear: () => void
  /** The daemon's answer after respond or withdraw. */
  onChanged: (review: Review) => void
  onPreview: (target: FilePreviewTarget) => void
  onOpenThread?: ((workspaceId: string | null, threadId: string) => void) | null
}

export function ReviewDetail({
  review,
  api,
  draft,
  bot,
  onDraftChange,
  onDraftClear,
  onChanged,
  onPreview,
  onOpenThread,
}: ReviewDetailProps) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDismiss, setConfirmingDismiss] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const readOnly = review.status !== 'open'
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const submitId = useId()
  const overallId = useId()

  // A different review starts clean and at the top.
  useEffect(() => {
    setError(null)
    setNotice(null)
    setConfirmingDismiss(false)
    scrollRef.current?.scrollTo?.({ top: 0 })
  }, [review.id])

  const state = submitState(review, draft)
  const ahead = goingAhead(review)
  const args = state.ready ? buildRespondArgs(review, draft) : null

  /** On any failed write, find out whether the review closed underneath us. */
  const reconcile = async (failure: unknown) => {
    const message = failure instanceof Error ? failure.message : 'The request failed.'
    try {
      const latest = await api?.readReview(review.id)
      if (latest && latest.status !== 'open') {
        onChanged(latest)
        setNotice(`This review was already ${REVIEW_STATUS_LABELS[latest.status].toLowerCase()}. What you typed is kept at the bottom.`)
        setError(null)
        return
      }
    } catch {
      // The write error is the more useful one to show.
    }
    setError(message)
  }

  const submit = async () => {
    if (!api || !args || sending) return
    setSending(true)
    setError(null)
    try {
      const updated = await api.respondReview(args)
      onChanged(updated)
      onDraftClear()
    } catch (failure) {
      await reconcile(failure)
    } finally {
      setSending(false)
    }
  }

  const dismiss = async () => {
    if (!api || sending) return
    setSending(true)
    setError(null)
    try {
      onChanged(await api.withdrawReview(review.id))
      setConfirmingDismiss(false)
    } catch (failure) {
      setConfirmingDismiss(false)
      await reconcile(failure)
    } finally {
      setSending(false)
    }
  }

  const preview = (target: FilePreviewTarget) =>
    onPreview({
      ...target,
      workspaceId: review.source_workspace_id ?? undefined,
      threadId: review.source_thread_id ?? undefined,
    })

  const who = bot?.name ?? review.bot ?? review.created_by.name

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6" aria-label={`Review ${review.id}: ${review.title}`}>
          <header className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
              {bot?.icon ? <BotMark icon={bot.icon} size={14} /> : null}
              <span className="font-medium text-fg-secondary">{who}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{review.id}</span>
              <span aria-hidden="true">·</span>
              <span>{reviewAge(review.created_at)} ago</span>
              {review.source_thread_id && onOpenThread ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => onOpenThread(review.source_workspace_id, review.source_thread_id!)}
                >
                  Open task
                </Button>
              ) : null}
            </div>
            <h2 className="fd-type-heading text-fg-primary">{review.title}</h2>
            <p className="text-[length:var(--fd-text-base)] text-fg-primary">{review.ask}</p>
            {ahead ? (
              <p
                className={cn(
                  'flex items-center gap-1.5 text-[length:var(--fd-text-xs)]',
                  ahead.passed && !readOnly ? 'text-warning' : 'text-fg-muted',
                )}
              >
                <Clock aria-hidden="true" className="h-3.5 w-3.5" />
                {ahead.label}
              </p>
            ) : null}
          </header>

          <section
            aria-label="Recommendation"
            className="rounded-[var(--fd-radius-lg)] border border-border-default border-l-2 border-l-accent bg-surface-2 px-4 py-3"
          >
            <p className="fd-type-eyebrow mb-1 text-fg-muted">Recommendation</p>
            <p className="text-[length:var(--fd-text-sm)] text-fg-primary">{review.recommendation}</p>
          </section>

          {review.body.trim() ? (
            <div className="text-[length:var(--fd-text-sm)] text-fg-primary">
              <MessageMarkdown text={review.body} defer={false} interpretDirectives={false} />
            </div>
          ) : null}

          {readOnly ? <ClosedSummary review={review} /> : null}

          <div className="space-y-4">
            {review.items.map((item, index) => (
              <ItemCard
                key={item.id}
                review={review}
                item={item}
                index={index}
                draft={draft.items[item.id]}
                readOnly={readOnly}
                api={api}
                onPreview={preview}
                onDecision={(decision) =>
                  onDraftChange((current) => ({
                    ...current,
                    items: { ...current.items, [item.id]: { ...current.items[item.id], decision } },
                  }))
                }
                onFeedback={(feedback) =>
                  onDraftChange((current) => ({
                    ...current,
                    items: { ...current.items, [item.id]: { ...current.items[item.id], feedback } },
                  }))
                }
              />
            ))}
          </div>

          {!readOnly ? (
            <Card className="space-y-3 p-4">
              <div>
                <h3 className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary">Whole review</h3>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  Optional when every item has a decision. One choice here covers any item you leave undecided.
                </p>
              </div>
              <DecisionChips
                label="Decision for the whole review"
                value={draft.overall?.decision}
                onChange={(decision) =>
                  onDraftChange((current) => ({ ...current, overall: { ...current.overall, decision } }))
                }
              />
              <label htmlFor={overallId} className="sr-only">
                Note on the whole review
              </label>
              <Textarea
                id={overallId}
                rows={2}
                value={draft.overall?.note ?? ''}
                onChange={(event) =>
                  onDraftChange((current) => ({
                    ...current,
                    overall: { ...current.overall, note: event.target.value },
                  }))
                }
                placeholder="Note for the agent (optional)"
                className="min-h-[3.25rem] resize-y"
              />
            </Card>
          ) : null}
        </article>
      </div>

      {!readOnly ? (
        <div className="shrink-0 border-t border-border-subtle bg-surface-1 px-6 py-3">
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3">
            <p
              id={submitId}
              role="status"
              className={cn(
                'min-w-0 flex-1 text-[length:var(--fd-text-sm)]',
                state.ready ? 'text-fg-muted' : 'text-fg-secondary',
              )}
            >
              {state.ready ? (
                <span className="inline-flex items-center gap-1.5">
                  <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                  {state.message}
                </span>
              ) : (
                state.message
              )}
            </p>
            {confirmingDismiss ? (
              <>
                <span className="text-[length:var(--fd-text-sm)] text-fg-secondary">Dismiss without answering?</span>
                <Button type="button" variant="ghost" onClick={() => setConfirmingDismiss(false)} disabled={sending}>
                  Keep
                </Button>
                <Button type="button" variant="danger" onClick={() => void dismiss()} disabled={sending || !api}>
                  Dismiss review
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirmingDismiss(true)}
                  disabled={sending || !api}
                  title="Withdraw this review without a decision"
                >
                  Dismiss
                </Button>
                <Button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!state.ready || sending || !api}
                  aria-describedby={submitId}
                >
                  {sending ? <ActivityDiamond size="md" tone="current" /> : null}
                  Send decision
                </Button>
              </>
            )}
          </div>
          {error ? (
            <p role="alert" className="mx-auto mt-2 w-full max-w-3xl text-[length:var(--fd-text-sm)] text-danger">
              {error} Your answers are still here; try again.
            </p>
          ) : null}
        </div>
      ) : notice || draftHasContent(draft) ? (
        <div className="max-h-56 shrink-0 space-y-2 overflow-y-auto border-t border-border-subtle bg-surface-1 px-6 py-3">
          <div className="mx-auto w-full max-w-3xl space-y-2">
            <p role="status" className="text-[length:var(--fd-text-sm)] text-fg-secondary">
              {notice ?? 'You have an unsent draft for this closed review.'}
            </p>
            {draftHasContent(draft) ? (
              <>
                <DraftRecap review={review} draft={draft} />
                <Button type="button" variant="ghost" size="sm" onClick={onDraftClear}>
                  Discard draft
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The unsent text, still readable once the review it was meant for has closed. */
function DraftRecap({ review, draft }: { review: Review; draft: ReviewDraft }) {
  const rows = review.items.flatMap((item) => {
    const entry = draft.items[item.id]
    if (!entry?.decision && !entry?.feedback?.trim()) return []
    return [{ key: item.id, title: item.title, decision: entry.decision, feedback: entry.feedback?.trim() ?? '' }]
  })
  return (
    <ul aria-label="Unsent draft" className="space-y-2">
      {rows.map((row) => (
        <li key={row.key} className="text-[length:var(--fd-text-xs)]">
          <span className="font-medium text-fg-primary">{row.title}</span>
          {row.decision ? <span className="text-fg-muted"> · {REVIEW_DECISION_LABELS[row.decision]}</span> : null}
          {row.feedback ? <Quote text={row.feedback} /> : null}
        </li>
      ))}
      {draft.overall?.decision || draft.overall?.note?.trim() ? (
        <li className="text-[length:var(--fd-text-xs)]">
          <span className="font-medium text-fg-primary">Whole review</span>
          {draft.overall.decision ? (
            <span className="text-fg-muted"> · {REVIEW_DECISION_LABELS[draft.overall.decision]}</span>
          ) : null}
          {draft.overall.note?.trim() ? <Quote text={draft.overall.note.trim()} /> : null}
        </li>
      ) : null}
    </ul>
  )
}

function ClosedSummary({ review }: { review: Review }) {
  const failed = review.delivery?.state === 'failed'
  return (
    <section aria-label="Your response" className="space-y-3 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReviewStatusBadge review={review} />
        {review.overall_decision ? (
          <Badge variant={DECISION_BADGE[review.overall_decision]}>
            Whole review: {REVIEW_DECISION_LABELS[review.overall_decision]}
          </Badge>
        ) : null}
        {review.responded_at ? (
          <span className="fd-type-meta text-fg-muted">answered {reviewAge(review.responded_at)} ago</span>
        ) : null}
      </div>
      {review.overall_note?.trim() ? <Quote text={review.overall_note} /> : null}
      {failed && review.delivery?.state === 'failed' ? (
        <p role="alert" className="rounded-[var(--fd-radius-md)] border border-danger/40 bg-danger-muted px-3 py-2 text-[length:var(--fd-text-sm)] text-danger">
          Your response is saved, but it didn’t reach the agent: {review.delivery.error}
        </p>
      ) : review.delivery?.state === 'delivered' ? (
        <p className="fd-type-meta text-fg-muted">Delivered to the agent.</p>
      ) : null}
    </section>
  )
}
