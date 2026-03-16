import { Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@falcondeck/ui'

export function CodeBlock({ code, language }: { code: string; language?: string | null }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-zinc-400">
        <span>{language ?? 'code'}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void handleCopy()}>
          <Copy className="h-4 w-4" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm text-zinc-100">
        <code>{code}</code>
      </pre>
    </div>
  )
}
