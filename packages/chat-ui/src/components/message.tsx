import { memo, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'

import type { ConversationItem } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { CodeBlock } from './code-block'
import { InteractiveRequestCard } from './interactive-request-card'

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
            <img
              key={attachment.id}
              src={attachment.url}
              alt={attachment.name ?? 'attachment'}
              className="h-16 w-16 rounded-[var(--fd-radius-md)] border border-border-default object-cover"
            />
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

function ToolCallMessage({ item }: { item: Extract<ConversationItem, { kind: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  const isCompleted = item.status === 'completed'

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Toggle ${item.title}`}
          className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-2"
        >
          {isCompleted ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
          )}
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
        {item.output ? (
          <div className="mt-1 ml-6">
            <CodeBlock code={item.output} language={null} />
          </div>
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

function DiffMessage({ item }: { item: Extract<ConversationItem, { kind: 'diff' }> }) {
  return (
    <div>
      <p className="mb-1 px-1 text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary">Patch</p>
      <CodeBlock code={item.diff} language="diff" />
    </div>
  )
}

function InteractiveRequestMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'interactive_request' }>
}) {
  return <InteractiveRequestCard request={item.request} resolved={item.resolved} />
}

function ServiceMessage({ item }: { item: Extract<ConversationItem, { kind: 'service' }> }) {
  return (
    <p className="text-center text-[length:var(--fd-text-xs)] italic text-fg-muted">
      {item.message}
    </p>
  )
}

export const MessageCard = memo(function MessageCard({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <UserMessage item={item} />
    case 'assistant_message':
      return <AssistantMessage item={item} />
    case 'tool_call':
      return <ToolCallMessage item={item} />
    case 'reasoning':
      return null
    case 'plan':
      return <PlanMessage item={item} />
    case 'diff':
      return <DiffMessage item={item} />
    case 'interactive_request':
      return <InteractiveRequestMessage item={item} />
    case 'service':
      return <ServiceMessage item={item} />
  }
})
