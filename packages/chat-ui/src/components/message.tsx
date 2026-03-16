import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { ConversationItem } from '@falcondeck/client-core'

import { Badge, Card, CardContent } from '@falcondeck/ui'

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
          return <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm">{children}</code>
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

export function MessageCard({ item }: { item: ConversationItem }) {
  if (item.kind === 'user_message') {
    return (
      <Card className="border-emerald-400/15 bg-emerald-400/5">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-2">
            <Badge variant="success">You</Badge>
            <span className="text-xs text-zinc-400">{new Date(item.created_at).toLocaleTimeString()}</span>
          </div>
          <div className="prose prose-invert max-w-none text-sm">{renderMarkdown(item.text)}</div>
          {item.attachments.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {item.attachments.map((attachment) => (
                <img
                  key={attachment.id}
                  src={attachment.url}
                  alt={attachment.name ?? 'attachment'}
                  className="aspect-square rounded-2xl border border-white/10 object-cover"
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    )
  }

  if (item.kind === 'assistant_message') {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-2">
            <Badge>Codex</Badge>
            <span className="text-xs text-zinc-400">{new Date(item.created_at).toLocaleTimeString()}</span>
          </div>
          <div className="prose prose-invert max-w-none text-sm">{renderMarkdown(item.text)}</div>
        </CardContent>
      </Card>
    )
  }

  if (item.kind === 'reasoning') {
    return (
      <Card className="bg-white/5">
        <CardContent className="space-y-2 pt-6">
          <Badge>Reasoning</Badge>
          {item.summary ? <p className="text-sm text-zinc-300">{item.summary}</p> : null}
          <div className="prose prose-invert max-w-none text-sm">{renderMarkdown(item.content)}</div>
        </CardContent>
      </Card>
    )
  }

  if (item.kind === 'tool_call') {
    return (
      <Card className="bg-white/5">
        <CardContent className="space-y-2 pt-6">
          <div className="flex items-center justify-between">
            <Badge>{item.tool_kind}</Badge>
            <span className="text-xs uppercase tracking-[0.2em] text-zinc-500">{item.status}</span>
          </div>
          <h4 className="text-sm font-medium text-white">{item.title}</h4>
          {item.output ? <CodeBlock code={item.output} language={null} /> : null}
        </CardContent>
      </Card>
    )
  }

  if (item.kind === 'plan') {
    return (
      <Card className="bg-white/5">
        <CardContent className="space-y-3 pt-6">
          <Badge>Plan</Badge>
          {item.plan.explanation ? <p className="text-sm text-zinc-300">{item.plan.explanation}</p> : null}
          <div className="space-y-2">
            {item.plan.steps.map((step, index) => (
              <div key={`${step.step}-${index}`} className="flex items-center justify-between text-sm">
                <span className="text-zinc-100">{step.step}</span>
                <span className="text-zinc-500">{step.status}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (item.kind === 'diff') {
    return (
      <Card className="bg-white/5">
        <CardContent className="space-y-2 pt-6">
          <Badge>Patch</Badge>
          <CodeBlock code={item.diff} language="diff" />
        </CardContent>
      </Card>
    )
  }

  if (item.kind === 'approval') {
    return (
      <Card className="border-amber-300/20 bg-amber-300/5">
        <CardContent className="space-y-2 pt-6">
          <Badge variant="warning">Approval</Badge>
          <p className="text-sm font-medium text-white">{item.request.title}</p>
          {item.request.detail ? <p className="text-sm text-zinc-300">{item.request.detail}</p> : null}
          {item.request.command ? <CodeBlock code={item.request.command} language="sh" /> : null}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-white/5">
      <CardContent className="space-y-2 pt-6">
        <Badge>{item.kind.replace('_', ' ')}</Badge>
        {'message' in item ? <p className="text-sm text-zinc-300">{item.message}</p> : null}
      </CardContent>
    </Card>
  )
}
