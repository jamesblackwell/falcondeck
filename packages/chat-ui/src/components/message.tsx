import { memo, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'

import type {
  ConversationItem,
  ConversationLiveActivityGroup,
  ToolActivitySummary,
} from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { CodeBlock } from './code-block'
import { InteractiveRequestCard } from './interactive-request-card'
import { attachmentLabel, canRenderAttachmentImage } from './attachment-preview'

const remarkPlugins = [remarkGfm]

const markdownComponents = {
  code(props: { children?: React.ReactNode; className?: string }) {
    const { children, className } = props
    const match = /language-(\w+)/.exec(className ?? '')
    const code = String(children).replace(/\n$/, '')
    const isBlock = Boolean(match) || code.includes('\n')
    if (isBlock) {
      return <CodeBlock code={code} language={match?.[1] ?? null} />
    }
    return (
      <code className="break-all rounded-[var(--fd-radius-sm)] bg-surface-4 px-1.5 py-0.5 font-mono text-[0.9em]">
        {children}
      </code>
    )
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
  },
  ul({ children }: { children?: React.ReactNode }) {
    return <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
  },
  ol({ children }: { children?: React.ReactNode }) {
    return <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li className="leading-relaxed">{children}</li>
  },
  h1({ children }: { children?: React.ReactNode }) {
    return <h1 className="mb-3 mt-5 first:mt-0 text-[1.4em] font-semibold text-fg-primary">{children}</h1>
  },
  h2({ children }: { children?: React.ReactNode }) {
    return <h2 className="mb-2 mt-4 first:mt-0 text-[1.2em] font-semibold text-fg-primary">{children}</h2>
  },
  h3({ children }: { children?: React.ReactNode }) {
    return <h3 className="mb-2 mt-3 first:mt-0 text-[1.1em] font-semibold text-fg-primary">{children}</h3>
  },
  blockquote({ children }: { children?: React.ReactNode }) {
    return <blockquote className="mb-3 border-l-2 border-border-emphasis pl-4 text-fg-secondary italic last:mb-0">{children}</blockquote>
  },
  strong({ children }: { children?: React.ReactNode }) {
    return <strong className="font-semibold text-fg-primary">{children}</strong>
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return <a href={href} className="text-accent underline decoration-accent/40 underline-offset-2" target="_blank" rel="noopener noreferrer">{children}</a>
  },
  hr() {
    return <hr className="my-4 border-border-subtle" />
  },
} as const

function renderMarkdown(text: string) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  )
}

function UserMessage({ item }: { item: Extract<ConversationItem, { kind: 'user_message' }> }) {
  const renderedText = useMemo(() => renderMarkdown(item.text), [item.text])

  return (
    <div className="ml-auto max-w-2xl rounded-[var(--fd-radius-xl)] bg-surface-3 px-5 py-4">
      <div className="max-w-none text-[length:var(--fd-text-md)] text-fg-primary">
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
  const renderedText = useMemo(() => renderMarkdown(item.text), [item.text])

  return (
    <div className="px-1">
      <div className="max-w-none text-[length:var(--fd-text-md)] text-fg-primary">
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
  const hasOutput = Boolean(item.output)
  const detailAvailable = hasOutput && !suppressReadOnlyDetail

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Toggle ${item.title}`}
          className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-2"
        >
          <ToolStatusIcon item={item} />
          <span className="flex-1 truncate font-mono text-[length:var(--fd-text-xs)]">
            {toolCallLabel(item.title)}
          </span>
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 transition-transform duration-[var(--fd-duration-fast)]',
              open && 'rotate-90',
            )}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {detailAvailable ? (
          <div className="mt-1 ml-6">
            <CodeBlock code={item.output ?? ''} language={null} />
          </div>
        ) : suppressReadOnlyDetail && hasOutput ? (
          <p className="mt-1 ml-6 text-[length:var(--fd-text-xs)] text-fg-muted">
            Read-only tool details hidden by preference.
          </p>
        ) : null}
      </Collapsible.Content>
    </Collapsible.Root>
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

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
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
        <CodeBlock code={item.diff} language="diff" />
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
          className="flex w-full items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-3 py-2 text-left transition-colors hover:bg-surface-2"
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
  if (!item.resolved) return null
  return <InteractiveRequestCard request={item.request} resolved={item.resolved} />
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
}: {
  item: ConversationItem
  defaultOpen?: boolean
  expansionMode?: ExpansionMode
  suppressReadOnlyDetail?: boolean
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
      return null
    case 'plan':
      return <PlanMessage item={item} />
    case 'diff':
      return <DiffMessage item={item} defaultOpen={defaultOpen} expansionMode={expansionMode} />
    case 'interactive_request':
      return <InteractiveRequestMessage item={item} />
    case 'service':
      return <ServiceMessage item={item} />
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

export const LiveActivityLane = memo(function LiveActivityLane({
  groups,
}: {
  groups: ConversationLiveActivityGroup[]
}) {
  if (groups.length === 0) return null

  return (
    <div className="shrink-0 border-t border-border-subtle bg-surface-1/95">
      <div className="mx-auto max-w-3xl px-5 py-3">
        <div className="max-h-[184px] space-y-3 overflow-y-auto pr-1">
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
