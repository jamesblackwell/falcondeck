import { memo } from 'react'

import { CopyButton } from '@falcondeck/ui'

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

export const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language?: string | null }) {
  const isDiff = language === 'diff'

  return (
    <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span>{language ?? 'code'}</span>
        <CopyButton text={code} variant="labeled" />
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
})
