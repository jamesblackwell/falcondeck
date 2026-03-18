import { useState } from 'react'
import { BellDot, ChevronDown, ChevronUp } from 'lucide-react'

import type { InteractiveRequest, InteractiveResponsePayload } from '@falcondeck/client-core'
import { Badge } from '@falcondeck/ui'

import { InteractiveRequestCard } from './interactive-request-card'

export type InteractiveRequestBarProps = {
  requests: InteractiveRequest[]
  onRespond: (request: InteractiveRequest, response: InteractiveResponsePayload) => void
}

export function InteractiveRequestBar({ requests, onRespond }: InteractiveRequestBarProps) {
  const [expanded, setExpanded] = useState(true)

  if (requests.length === 0) return null

  return (
    <div className="shrink-0 border-t border-border-subtle bg-surface-1">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 bg-warning-muted/20 px-4 py-2 text-[length:var(--fd-text-xs)] font-medium text-warning transition-colors hover:bg-warning-muted/35"
      >
        <BellDot className="h-3.5 w-3.5" />
        {requests.length === 1 ? '1 response pending' : `${requests.length} responses pending`}
        <Badge variant="warning" className="ml-1">
          {requests.length}
        </Badge>
        <span className="ml-auto">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 py-3">
          {requests.map((request) => (
            <InteractiveRequestCard
              key={request.request_id}
              request={request}
              onRespond={(response) => onRespond(request, response)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
