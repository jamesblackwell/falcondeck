import { memo, useCallback, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '../lib/utils'

export type CopyButtonProps = {
  text: string
  className?: string
  variant?: 'icon' | 'labeled'
}

export const CopyButton = memo(function CopyButton({ text, className, variant = 'icon' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [text])

  if (variant === 'labeled') {
    return (
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'inline-flex items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary',
          className,
        )}
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary',
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  )
})
