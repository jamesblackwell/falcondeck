import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronRight, CheckCircle2, Circle, FileDiff, Loader2 } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'

import {
  formatWorkDuration,
  type ConversationItem,
  type ConversationLiveActivityGroup,
  type ThinkingDisplay,
  type ToolActivitySummary,
  type WorkSessionEntry,
} from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { FileDiffLink, useOpenFileDiff } from '../lib/file-diff-context'
import { extractFilePath, fileBaseName } from '../lib/tool-file-path'
import { CodeBlock } from './code-block'
import { DiffBlock } from './diff-block'
import { useParsedDiff } from './diff-lines'
import { renderMessageContent } from './message-markdown'
import { attachmentLabel, canRenderAttachmentImage } from './attachment-preview'

function UserMessage({ item }: { item: Extract<ConversationItem, { kind: 'user_message' }> }) {
  const renderedText = useMemo(() => renderMessageContent(item.text), [item.text])

  return (
    <div className="ml-auto w-fit min-w-0 max-w-2xl rounded-[var(--fd-radius-xl)] bg-surface-3 px-5 py-4">
      <div className="max-w-none break-words text-[length:var(--fd-text-md)] text-fg-primary">
        {renderedText}
      </div>
      {item.attachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.attachments.map((attachment) => (
            canRenderAttachmentImage(attachment.url) ? (
              <img
                key={attachment.id}
                src={attachment.url}
                alt={attachment.name ?? 'attachment'}
                className="h-16 w-16 rounded-[var(--fd-radius-md)] border border-border-default object-cover"
              />
            ) : (
              <div
                key={attachment.id}
                className="inline-flex max-w-48 items-center rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-secondary"
                title={attachment.local_path ?? attachment.url}
              >
                {attachmentLabel(attachment)}
              </div>
            )
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AssistantMessage({ item }: { item: Extract<ConversationItem, { kind: 'assistant_message' }> }) {
  const renderedText = useMemo(() => renderMessageContent(item.text), [item.text])

  return (
    <div className="min-w-0 px-1">
      <div className="max-w-none break-words text-[length:var(--fd-text-md)] text-fg-primary">
        {renderedText}
      </div>
    </div>
  )
}

function toolCallLabel(title: string) {
  // Simplify verbose shell commands: "/bin/zsh -lc 'git diff --stat'" → "git diff --stat"
  const shellMatch = /['"](.+?)['"]/.exec(title)
  if (shellMatch) return shellMatch[1]
  return title
}

type ExpansionMode = 'default' | 'expanded' | 'collapsed'

function ToolStatusIcon({
  item,
  className = 'h-3.5 w-3.5 shrink-0',
}: {
  item: Extract<ConversationItem, { kind: 'tool_call' }>
  className?: string
}) {
  const isCompleted = item.status === 'completed' || item.status === 'success'
  const isRunning = item.status === 'running' || item.status === 'in_progress'
  if (isRunning) {
    return <Loader2 className={cn(className, 'animate-spin text-accent')} />
  }
  if (isCompleted) {
    return <CheckCircle2 className={cn(className, 'text-fg-muted')} />
  }
  return <Circle className={cn(className, 'text-fg-faint')} />
}

function ToolCallCompactRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'tool_call' }>
}) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1 text-fg-muted">
      <ToolStatusIcon item={item} className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate font-mono text-[length:var(--fd-text-xs)]">
        {toolCallLabel(item.title)}
      </span>
    </div>
  )
}

function useExpansionState(defaultOpen: boolean, expansionMode: ExpansionMode, seed: string) {
  const [open, setOpen] = useState(defaultOpen)

  useEffect(() => {
    if (expansionMode === 'expanded') {
      setOpen(true)
      return
    }
    if (expansionMode === 'collapsed') {
      setOpen(false)
      return
    }
    setOpen(defaultOpen)
  }, [defaultOpen, expansionMode, seed])

  return [open, setOpen] as const
}

/**
 * Work that changes something, and so earns a bordered card. Everything else —
 * reads, searches, fetches — stays a quiet one-line row.
 */
const CARD_ACTIVITY_KINDS = new Set(['edit', 'diff', 'command', 'test'])

/**
 * A call the agent cannot proceed past until someone answers. No provider sets
 * a dedicated status for this yet, so an approval-flavoured call that is still
 * in flight is the live signal; the explicit statuses are accepted ahead of a
 * daemon that starts sending them.
 */
function isAwaitingConfirmation(item: Extract<ConversationItem, { kind: 'tool_call' }>) {
  return (
    item.status === 'awaiting_confirmation' ||
    item.status === 'awaiting_approval' ||
    item.status === 'pending_approval' ||
    (item.display.artifact_kind === 'approval_related' &&
      (item.status === 'running' || item.status === 'in_progress'))
  )
}

function ToolCallMessage({
  item,
  defaultOpen = false,
  expansionMode = 'default',
  suppressReadOnlyDetail = false,
}: {
  item: Extract<ConversationItem, { kind: 'tool_call' }>
  defaultOpen?: boolean
  expansionMode?: ExpansionMode
  suppressReadOnlyDetail?: boolean
}) {
  const [open, setOpen] = useExpansionState(defaultOpen, expansionMode, item.id)
  const openFileDiff = useOpenFileDiff()
  const hasOutput = Boolean(item.output)
  const detailAvailable = hasOutput && !suppressReadOnlyDetail
  const label = toolCallLabel(item.title)

  const activityKind = item.display.activity_kind
  const touchesFile = activityKind === 'edit' || activityKind === 'diff'
  const filePath = useMemo(
    () => (touchesFile || activityKind === 'read' ? extractFilePath(label) : null),
    [activityKind, label, touchesFile],
  )
  // Output highlighting is only safe when the file names the language: a shell
  // command's output has nothing to do with the path that appears in it.
  const outputFilePath = activityKind === 'read' || touchesFile ? filePath : null

  // You cannot hide what you are being asked to approve, so a pending
  // confirmation is forced open and its toggle is disabled.
  const awaitingConfirmation = isAwaitingConfirmation(item)
  const asCard = awaitingConfirmation || CARD_ACTIVITY_KINDS.has(activityKind)
  const effectiveOpen = awaitingConfirmation ? true : open

  const detail = detailAvailable ? (
    <CodeBlock code={item.output ?? ''} language={null} filePath={outputFilePath} />
  ) : suppressReadOnlyDetail && hasOutput ? (
    <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
      Read-only tool details hidden by preference.
    </p>
  ) : null

  const fileLink =
    openFileDiff && touchesFile && filePath ? (
      // Sibling of the trigger, not a child: a nested button would be invalid
      // markup and would swallow the toggle.
      <span className="flex shrink-0 items-center gap-1 text-fg-faint">
        <FileDiff aria-hidden="true" className="h-3 w-3" />
        <FileDiffLink
          filePath={filePath}
          label={fileBaseName(filePath)}
          className="max-w-40 truncate font-mono text-[length:var(--fd-text-2xs)] text-fg-tertiary"
        />
      </span>
    ) : null

  return (
    <Collapsible.Root
      open={effectiveOpen}
      onOpenChange={awaitingConfirmation ? undefined : setOpen}
    >
      <div
        // The tier is the contract these cards are built around, so it is
        // stated once here rather than inferred from styling.
        data-tool-tier={awaitingConfirmation ? 'confirm' : asCard ? 'card' : 'row'}
        className={cn(
          'group',
          asCard &&
            'overflow-hidden rounded-[var(--fd-radius-lg)] border bg-surface-1',
          asCard &&
            (awaitingConfirmation ? 'border-warning/40' : 'border-border-subtle'),
        )}
      >
        <div
          className={cn(
            'flex w-full items-center gap-1 pr-2 transition-colors duration-[var(--fd-duration-fast)]',
            asCard ? 'bg-surface-2/40' : 'rounded-[var(--fd-radius-md)] hover:bg-surface-2',
          )}
        >
          <Collapsible.Trigger asChild disabled={awaitingConfirmation}>
            <button
              type="button"
              aria-expanded={effectiveOpen}
              aria-label={`Toggle ${item.title}`}
              disabled={awaitingConfirmation}
              className={cn(
                'fd-focus flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-fg-muted',
                awaitingConfirmation && 'cursor-default',
              )}
            >
              <ToolStatusIcon item={item} />
              <span
                className={cn(
                  'flex-1 truncate font-mono text-[length:var(--fd-text-xs)]',
                  item.display.is_error && 'text-danger',
                )}
              >
                {label}
              </span>
              {awaitingConfirmation ? (
                <span className="shrink-0 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-warning">
                  Awaiting approval
                </span>
              ) : (
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 transition-[transform,opacity] duration-[var(--fd-duration-fast)]',
                    open && 'rotate-90',
                    // The quiet tier earns its quietness by holding the chevron
                    // back until the row is hovered, focused, or already open.
                    !asCard &&
                      !open &&
                      'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                  )}
                />
              )}
            </button>
          </Collapsible.Trigger>
          {fileLink}
        </div>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
          {detail ? <div className={asCard ? 'px-2 pt-1 pb-2' : 'mt-1 ml-6'}>{detail}</div> : null}
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  )
}

/** Height of the `preview` excerpt before the fade takes over. */
const REASONING_PREVIEW_MAX_HEIGHT_PX = 88

function ReasoningMessage({
  item,
  thinkingDisplay = 'auto',
  streaming = false,
}: {
  item: Extract<ConversationItem, { kind: 'reasoning' }>
  thinkingDisplay?: ThinkingDisplay
  streaming?: boolean
}) {
  // `null` means "still following the preference". A click pins the state so
  // that a thought the reader opened does not slam shut the moment it stops
  // streaming — Zed's rule, and the reason `auto` cannot be plain derived state.
  const [override, setOverride] = useState<boolean | null>(null)

  useEffect(() => {
    setOverride(null)
  }, [item.id, thinkingDisplay])

  const open =
    override ??
    (thinkingDisplay === 'always_expanded'
      ? true
      : thinkingDisplay === 'auto'
        ? streaming
        : false)
  // Preview keeps the excerpt on screen when closed; the other modes hide the
  // body entirely, so only preview renders content in the closed state.
  const showPreview = thinkingDisplay === 'preview' && !open
  const body = useMemo(() => renderMessageContent(item.content), [item.content])
  const summary = item.summary?.trim()
  const label = streaming ? 'Thinking…' : summary || 'Thought'

  return (
    <div className="min-w-0 border-l-2 border-border-subtle pl-3">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="fd-focus flex max-w-full items-center gap-1.5 rounded-[var(--fd-radius-sm)] py-0.5 text-left text-[length:var(--fd-text-sm)] text-fg-muted transition-colors hover:text-fg-secondary"
      >
        {streaming ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : null}
        <span className="min-w-0 truncate font-medium">{label}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open || showPreview ? (
        <div
          className={cn('relative mt-1', showPreview && 'overflow-hidden')}
          style={showPreview ? { maxHeight: REASONING_PREVIEW_MAX_HEIGHT_PX } : undefined}
        >
          <div className="max-w-none break-words text-[length:var(--fd-text-sm)] text-fg-tertiary">
            {body}
          </div>
          {showPreview ? (
            <button
              type="button"
              onClick={() => setOverride(true)}
              aria-label="Show the full thought"
              className="fd-focus absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-1 to-transparent"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PlanStepIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
    case 'done':
      return <CheckCircle2 className="h-3.5 w-3.5 text-success" />
    case 'in_progress':
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
    default:
      return <Circle className="h-3.5 w-3.5 text-fg-faint" />
  }
}

function PlanMessage({ item }: { item: Extract<ConversationItem, { kind: 'plan' }> }) {
  return (
    <div className="px-1">
      <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary">Plan</p>
      {item.plan.explanation ? (
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-secondary">{item.plan.explanation}</p>
      ) : null}
      <div className="mt-2 space-y-1">
        {item.plan.steps.map((step, index) => (
          <div key={`${step.step}-${index}`} className="flex items-start gap-2 py-0.5">
            <PlanStepIcon status={step.status} />
            <span className="flex-1 text-[length:var(--fd-text-sm)] text-fg-primary">{step.step}</span>
            <span className="text-[length:var(--fd-text-2xs)] text-fg-muted">{step.status}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DiffMessage({
  item,
  defaultOpen = false,
  expansionMode = 'default',
}: {
  item: Extract<ConversationItem, { kind: 'diff' }>
  defaultOpen?: boolean
  expansionMode?: ExpansionMode
}) {
  const [open, setOpen] = useExpansionState(defaultOpen, expansionMode, item.id)
  const parsed = useParsedDiff(item.diff)

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <span className="flex-1 text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary">
            Patch
          </span>
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-fg-muted transition-transform duration-[var(--fd-duration-fast)]',
              open && 'rotate-90',
            )}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {parsed.status === 'unparsed' ? (
          <CodeBlock code={item.diff} language="diff" />
        ) : (
          <DiffBlock diff={item.diff} parsed={parsed} title="Patch" />
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

function ToolSummaryMessage({
  summary,
  items,
  defaultOpen = false,
  expansionMode = 'default',
  suppressReadOnlyDetail = false,
}: {
  summary: ToolActivitySummary
  items: Extract<ConversationItem, { kind: 'tool_call' }>[]
  defaultOpen?: boolean
  expansionMode?: ExpansionMode
  suppressReadOnlyDetail?: boolean
}) {
  const [open, setOpen] = useExpansionState(defaultOpen, expansionMode, items[0]?.id ?? 'tool-summary')

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-3 py-2 text-left transition-colors hover:bg-surface-2"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
              {summary.title}
            </p>
            <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
              {summary.subtitle || summary.summary_hint || 'Grouped tool activity'}
            </p>
          </div>
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-fg-muted transition-transform duration-[var(--fd-duration-fast)]',
              open && 'rotate-90',
            )}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="space-y-1 overflow-hidden pt-2 data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {items.map((item) => (
          <ToolCallMessage
            key={item.id}
            item={item}
            defaultOpen={defaultOpen}
            expansionMode={expansionMode}
            suppressReadOnlyDetail={suppressReadOnlyDetail}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

function InteractiveRequestMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'interactive_request' }>
}) {
  // Unresolved requests live in the pinned approval bar, not the transcript.
  if (!item.resolved) return null
  // A resolved approval is history: it needs a quiet one-line receipt, not a
  // warning-coloured card with a raw JSON body. The detail stays one click
  // away for anyone auditing what was approved.
  return <ResolvedInteractiveRequestRow item={item} />
}

function ResolvedInteractiveRequestRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'interactive_request' }>
}) {
  const [open, setOpen] = useState(false)
  const request = item.request
  const summary =
    request.command?.trim() ||
    request.path?.trim() ||
    request.detail?.trim() ||
    ''
  const hasDetail = Boolean(request.detail?.trim() || request.command?.trim())

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild disabled={!hasDetail}>
        <button
          type="button"
          aria-expanded={open}
          disabled={!hasDetail}
          className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-2 disabled:hover:bg-transparent"
        >
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />
          <span className="shrink-0 text-[length:var(--fd-text-xs)]">
            {resolvedApprovalLabel(request.title)}
          </span>
          {summary ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-tertiary">
              {summary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {hasDetail ? (
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 transition-transform duration-[var(--fd-duration-fast)]',
                open && 'rotate-90',
              )}
            />
          ) : null}
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {hasDetail ? (
          <div className="mt-1 ml-6">
            <CodeBlock code={request.command?.trim() || request.detail?.trim() || ''} language={null} />
          </div>
        ) : null}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

/** "Allow Read?" → "Allowed Read"; anything unrecognized passes through. */
function resolvedApprovalLabel(title: string) {
  const trimmed = title.trim().replace(/\?$/, '')
  if (/^allow /i.test(trimmed)) {
    return `Allowed ${trimmed.slice('allow '.length)}`
  }
  if (/^approve /i.test(trimmed)) {
    return `Approved ${trimmed.slice('approve '.length)}`
  }
  return trimmed
}

function ServiceMessage({ item }: { item: Extract<ConversationItem, { kind: 'service' }> }) {
  return (
    <p className="text-center text-[length:var(--fd-text-xs)] italic text-fg-muted">
      {item.message}
    </p>
  )
}

export const MessageCard = memo(function MessageCard({
  item,
  defaultOpen = false,
  expansionMode = 'default',
  suppressReadOnlyDetail = false,
  thinkingDisplay = 'auto',
  isStreamingReasoning = false,
}: {
  item: ConversationItem
  defaultOpen?: boolean
  expansionMode?: ExpansionMode
  suppressReadOnlyDetail?: boolean
  thinkingDisplay?: ThinkingDisplay
  /** True only for the thought currently arriving, which `auto` expands. */
  isStreamingReasoning?: boolean
}) {
  switch (item.kind) {
    case 'user_message':
      return <UserMessage item={item} />
    case 'assistant_message':
      return <AssistantMessage item={item} />
    case 'tool_call':
      return (
        <ToolCallMessage
          item={item}
          defaultOpen={defaultOpen}
          expansionMode={expansionMode}
          suppressReadOnlyDetail={suppressReadOnlyDetail}
        />
      )
    case 'reasoning':
      return (
        <ReasoningMessage
          item={item}
          thinkingDisplay={thinkingDisplay}
          streaming={isStreamingReasoning}
        />
      )
    case 'plan':
      return <PlanMessage item={item} />
    case 'diff':
      return <DiffMessage item={item} defaultOpen={defaultOpen} expansionMode={expansionMode} />
    case 'interactive_request':
      return <InteractiveRequestMessage item={item} />
    case 'service':
      return <ServiceMessage item={item} />
    default:
      // Item kinds from a newer daemon must degrade gracefully, not crash the
      // conversation view (returning undefined throws in React).
      return null
  }
})

export const ToolSummaryCard = memo(function ToolSummaryCard(props: {
  summary: ToolActivitySummary
  items: Extract<ConversationItem, { kind: 'tool_call' }>[]
  defaultOpen?: boolean
  expansionMode?: ExpansionMode
  suppressReadOnlyDetail?: boolean
}) {
  return <ToolSummaryMessage {...props} />
})

/** One buried run of tool work: a single quiet line ("Working…" while live,
    "Worked for 2m 14s" when done) that expands to the full tool detail. */
export const WorkSessionCard = memo(function WorkSessionCard({
  items,
  running,
  startedAt,
  completedAt,
  expansionMode = 'default',
  thinkingDisplay = 'auto',
}: {
  items: WorkSessionEntry[]
  running: boolean
  startedAt: string
  completedAt: string | null
  expansionMode?: ExpansionMode
  thinkingDisplay?: ThinkingDisplay
}) {
  const [open, setOpen] = useExpansionState(false, expansionMode, items[0]?.id ?? 'work')
  const toolCalls = items.filter(
    (entry): entry is Extract<ConversationItem, { kind: 'tool_call' }> =>
      entry.kind === 'tool_call',
  )
  const currentLabel = running
    ? toolCallLabel(
        [...toolCalls]
          .reverse()
          .find((item) => item.status === 'running' || item.status === 'in_progress')?.title ??
          toolCalls[toolCalls.length - 1]?.title ??
          '',
      )
    : null

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="fd-focus group flex max-w-full items-center gap-1.5 rounded-[var(--fd-radius-sm)] py-1 text-[length:var(--fd-text-sm)] text-fg-muted transition-colors hover:text-fg-secondary"
        >
          {running ? (
            <>
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
              <span className="shrink-0 font-medium">Working…</span>
              {currentLabel ? (
                <span className="min-w-0 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-faint">
                  {currentLabel}
                </span>
              ) : null}
            </>
          ) : (
            <span className="font-medium">
              Worked for {formatWorkDuration(startedAt, completedAt ?? startedAt)}
            </span>
          )}
          <ChevronRight
            aria-hidden="true"
            className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        <div className="mt-1 space-y-1 border-l border-border-subtle pl-3">
          {items.map((entry) =>
            entry.kind === 'reasoning' ? (
              <ReasoningMessage
                key={`reasoning:${entry.id}`}
                item={entry}
                thinkingDisplay={thinkingDisplay}
              />
            ) : (
              <ToolCallMessage key={entry.id} item={entry} />
            ),
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  )
})

export const LiveActivityLane = memo(function LiveActivityLane({
  groups,
}: {
  groups: ConversationLiveActivityGroup[]
}) {
  if (groups.length === 0) return null

  // Rendered in the conversation flow (not a pinned lane), matching where the
  // resulting tool-summary cards will appear once the work completes.
  return (
    <div className="min-w-0">
      <div>
        <div className="space-y-3">
          {groups.map((group) => (
            <div
              key={group.id}
              className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1"
            >
              <div className="border-b border-border-subtle px-3 py-2">
                <p className="truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
                  {group.summary.title}
                </p>
                {group.summary.subtitle ? (
                  <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                    {group.summary.subtitle}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1 p-2">
                {group.items.map((item) => (
                  <ToolCallCompactRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})
