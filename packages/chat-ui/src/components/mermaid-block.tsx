import { memo, useEffect, useState } from 'react'

import { CopyButton, cn, subscribeAppearance } from '@falcondeck/ui'

import { renderMermaidSvg } from '../lib/mermaid'

export const MermaidBlock = memo(function MermaidBlock({
  code,
  pending = false,
}: {
  code: string
  /** Quiet parse failures while the enclosing fence may still be growing. */
  pending?: boolean
}) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let cancelled = false

    const run = () => {
      const trimmed = code.trim()
      if (!trimmed) {
        setSvg(null)
        setError(null)
        return
      }

      void renderMermaidSvg(trimmed)
        .then((next) => {
          if (cancelled) return
          setSvg(next)
          setError(null)
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          setSvg(null)
          setError(
            reason instanceof Error ? reason.message : 'Could not render diagram',
          )
        })
    }

    run()
    const unsubscribe = subscribeAppearance(run)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [code])

  const showingSource = showSource || Boolean(error) || !svg

  return (
    <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span className="min-w-0 truncate">mermaid</span>
        <div className="flex shrink-0 items-center gap-2">
          {error && !pending ? (
            <span role="status" className="truncate">
              Could not render
            </span>
          ) : null}
          {svg ? (
            <button
              type="button"
              onClick={() => setShowSource((value) => !value)}
              className={cn(
                'fd-focus inline-flex items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted',
                'transition-colors hover:bg-surface-3 hover:text-fg-secondary',
              )}
            >
              {showSource ? 'Diagram' : 'Source'}
            </button>
          ) : null}
          <CopyButton text={code} variant="labeled" />
        </div>
      </div>
      {showingSource ? (
        <pre className="overflow-x-auto p-3 text-[length:var(--fd-text-sm)] leading-code text-fg-secondary">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="fd-mermaid overflow-x-auto p-3"
          role="img"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: svg ?? '' }}
        />
      )}
    </div>
  )
})
