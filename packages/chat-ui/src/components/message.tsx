import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, ChevronRight, CheckCircle2, Circle, Loader2, Wrench, Brain } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'

import type { ConversationItem } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { CodeBlock } from './code-block'

function renderMarkdown(text: string) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code(props) {
          const { children, className } = props
          const match = /language-(\w+)/.exec(className ?? '')
          const code = String(children).replace(/\n$/, '')
          const isBlock = Boolean(match) || code.includes('\n')
          if (isBlock) {
            return <CodeBlock code={code} language={match?.[1] ?? null} />
          }
          return (
            <code className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-[length:var(--fd-text-sm)] text-fg-secondary">
              {children}
            </code>
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function UserMessage({ item }: { item: Extract<ConversationItem, { kind: 'user_message' }> }) {
  return (
    <div className="ml-10 rounded-[var(--fd-radius-lg)] border-l-2 border-l-accent bg-surface-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[length:var(--fd-text-xs)] font-medium text-accent">You</span>
        <span className="text-[length:var(--fd-text-2xs)] text-fg-muted">
          {new Date(item.created_at).toLocaleTimeString()}
        </span>
      </div>
      <div className="prose prose-invert mt-2 max-w-none text-[length:var(--fd-text-sm)] text-fg-primary">
        {renderMarkdown(item.text)}
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
  return (
    <div className="px-1">
      <div className="flex items-center gap-2">
        <span className="text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary">Codex</span>
        <span className="text-[length:var(--fd-text-2xs)] text-fg-muted">
          {new Date(item.created_at).toLocaleTimeString()}
        </span>
      </div>
      <div className="prose prose-invert mt-2 max-w-none text-[length:var(--fd-text-sm)] text-fg-primary">
        {renderMarkdown(item.text)}
      </div>
    </div>
  )
}

function ToolCallMessage({ item }: { item: Extract<ConversationItem, { kind: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Toggle ${item.tool_kind}: ${item.title}`}
          className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] border-l-2 border-l-info bg-surface-1 px-3 py-2 text-left transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-2"
        >
          <Wrench className="h-3.5 w-3.5 shrink-0 text-info" />
          <span className="flex-1 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
            {item.tool_kind}: {item.title}
          </span>
          <span className="text-[length:var(--fd-text-2xs)] uppercase tracking-widest text-fg-muted">
            {item.status}
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
        {item.output ? (
          <div className="mt-1 ml-5">
            <CodeBlock code={item.output} language={null} />
          </div>
        ) : null}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

function ReasoningMessage({ item }: { item: Extract<ConversationItem, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-label="Toggle reasoning"
          className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-2"
        >
          <Brain className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-[length:var(--fd-text-xs)] italic">
            {item.summary ?? 'Reasoning...'}
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
        <div className="prose prose-invert mt-1 max-w-none px-3 text-[length:var(--fd-text-sm)] text-fg-tertiary">
          {renderMarkdown(item.content)}
        </div>
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

function ApprovalMessage({ item }: { item: Extract<ConversationItem, { kind: 'approval' }> }) {
  return (
    <div className="rounded-[var(--fd-radius-lg)] border border-warning/20 bg-warning-muted px-4 py-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{item.request.title}</p>
          {item.request.detail ? (
            <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">{item.request.detail}</p>
          ) : null}
          {item.request.command ? (
            <pre className="mt-2 overflow-x-auto rounded-[var(--fd-radius-md)] bg-surface-1 px-2.5 py-1.5 font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
              {item.request.command}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ServiceMessage({ item }: { item: Extract<ConversationItem, { kind: 'service' }> }) {
  return (
    <p className="text-center text-[length:var(--fd-text-xs)] italic text-fg-muted">
      {item.message}
    </p>
  )
}

export function MessageCard({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <UserMessage item={item} />
    case 'assistant_message':
      return <AssistantMessage item={item} />
    case 'tool_call':
      return <ToolCallMessage item={item} />
    case 'reasoning':
      return <ReasoningMessage item={item} />
    case 'plan':
      return <PlanMessage item={item} />
    case 'diff':
      return <DiffMessage item={item} />
    case 'approval':
      return <ApprovalMessage item={item} />
    case 'service':
      return <ServiceMessage item={item} />
  }
}
