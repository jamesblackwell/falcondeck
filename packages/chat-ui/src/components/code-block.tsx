import { Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@falcondeck/ui'

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return <span className="text-fg-tertiary">{line}</span>
  }
  if (line.startsWith('+')) {
    return <span className="text-success">{line}</span>
  }
  if (line.startsWith('-')) {
    return <span className="text-danger">{line}</span>
  }
  if (line.startsWith('@@')) {
    return <span className="text-info">{line}</span>
  }
  return <span>{line}</span>
}

export function CodeBlock({ code, language }: { code: string; language?: string | null }) {
  const [copied, setCopied] = useState(false)
  const isDiff = language === 'diff'

  async function handleCopy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span>{language ?? 'code'}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void handleCopy()}>
          <Copy className="h-3 w-3" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
        <code>
          {isDiff
            ? code.split('\n').map((line, i) => (
                <span key={`${i}-${line.slice(0, 20)}`}>
                  <DiffLine line={line} />
                  {'\n'}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  )
}
