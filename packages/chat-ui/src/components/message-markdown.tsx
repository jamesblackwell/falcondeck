import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GitCommitHorizontal, Terminal, Upload } from 'lucide-react'

import { CodeBlock } from './code-block'

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
    // [overflow-wrap:anywhere] lets bare URLs break mid-token instead of
    // stretching the message bubble past the column edge.
    return <a href={href} className="[overflow-wrap:anywhere] text-accent underline decoration-accent/40 underline-offset-2" target="_blank" rel="noopener noreferrer">{children}</a>
  },
  hr() {
    return <hr className="my-4 border-border-subtle" />
  },
} as const

export function renderMarkdown(text: string) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  )
}

/* --- Inline agent directives ---------------------------------------- */
/* Codex emits machine-readable action markers like
   `::git-push{cwd="/path" branch="master"}` on their own lines. Render
   them as compact chips instead of leaking raw syntax into the chat. */

const DIRECTIVE_LINE_RE = /^::([a-z0-9][a-z0-9_-]*)\{([^}]*)\}\s*$/

const DIRECTIVE_ICONS: Record<string, typeof Terminal> = {
  'git-commit': GitCommitHorizontal,
  'git-push': Upload,
}

function parseDirectiveAttrs(raw: string): Array<[string, string]> {
  const attrs: Array<[string, string]> = []
  const attrRe = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(raw)) !== null) {
    attrs.push([match[1], match[2] ?? match[3] ?? match[4] ?? ''])
  }
  return attrs
}

function directiveAttrLabel(key: string, value: string) {
  // Paths compress to their basename; the full value stays in the tooltip.
  if (key === 'cwd' || key === 'path') return value.split('/').filter(Boolean).pop() ?? value
  return value
}

function DirectiveChip({ name, attrs }: { name: string; attrs: Array<[string, string]> }) {
  const Icon = DIRECTIVE_ICONS[name] ?? Terminal
  // Styled like the compact tool rows (bare icon + muted mono text) so it
  // reads as an activity annotation, not a pressable button.
  return (
    <div className="my-1.5 flex max-w-full items-center gap-2 px-1 text-fg-muted">
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 text-[length:var(--fd-text-xs)] font-medium">
        {name.replace(/-/g, ' ')}
      </span>
      {attrs.map(([key, value]) => (
        <span
          key={key}
          title={`${key}=${value}`}
          className="max-w-56 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-faint"
        >
          {directiveAttrLabel(key, value)}
        </span>
      ))}
    </div>
  )
}

type MessageSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'directive'; name: string; attrs: Array<[string, string]> }

function splitMessageSegments(text: string): MessageSegment[] {
  if (!text.includes('::')) return [{ kind: 'markdown', text }]
  const segments: MessageSegment[] = []
  let buffer: string[] = []
  const flush = () => {
    if (buffer.length === 0) return
    const chunk = buffer.join('\n')
    if (chunk.trim().length > 0) segments.push({ kind: 'markdown', text: chunk })
    buffer = []
  }
  for (const line of text.split('\n')) {
    const match = DIRECTIVE_LINE_RE.exec(line.trim())
    if (match) {
      flush()
      segments.push({ kind: 'directive', name: match[1], attrs: parseDirectiveAttrs(match[2]) })
    } else {
      buffer.push(line)
    }
  }
  flush()
  return segments
}

export function renderMessageContent(text: string) {
  const segments = splitMessageSegments(text)
  if (segments.length === 1 && segments[0].kind === 'markdown') {
    return renderMarkdown(text)
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'markdown' ? (
          <div key={index}>{renderMarkdown(segment.text)}</div>
        ) : (
          <DirectiveChip key={index} name={segment.name} attrs={segment.attrs} />
        ),
      )}
    </>
  )
}
