import { claudeEditDiff } from '@falcondeck/client-core'
import { useState } from 'react'
import type { ClaudeNestedCall, ToolCallDetail } from '@falcondeck/client-core'
import { CodeBlock } from './code-block'

type Detail = Extract<ToolCallDetail, { kind: 'dynamic' }>

/** Mounted only after the parent opens. Child bodies stay unmounted until requested. */
export function ClaudeToolEvidence({ detail }: { detail: Detail }) {
  const diff = claudeEditDiff(detail.claude?.result)
  return <div className="space-y-2" aria-label="Claude tool details">
    {detail.arguments != null ? <CodeBlock label="Arguments" code={JSON.stringify(detail.arguments, null, 2)} language="json" previewLines={0} /> : null}
    {detail.claude?.calls.length ? <div className="space-y-1" aria-label="Sub-agent calls">
      {detail.claude.calls.map(call => <ClaudeChildCall key={call.id} call={call} />)}
    </div> : null}
    {diff ? <CodeBlock label="Changes" code={diff} language="diff" previewLines={0} /> : null}
    {detail.claude?.result != null ? <CodeBlock label="Result details" code={JSON.stringify(detail.claude.result, null, 2)} language="json" /> : null}
  </div>
}

function ClaudeChildCall({ call }: { call: ClaudeNestedCall }) {
  const [open, setOpen] = useState(false)
  return <details className="rounded border border-border-subtle px-3 py-2" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="fd-focus cursor-pointer text-fg-secondary">{call.tool_kind}: {call.title} · {call.status}</summary>
    {open ? <div className="space-y-2 pt-2">
      <CodeBlock label="Arguments" code={JSON.stringify(call.arguments, null, 2)} language="json" previewLines={0} />
      {call.output != null ? <CodeBlock label="Output" code={call.output} previewLines={0} /> : null}
    </div> : null}
  </details>
}
