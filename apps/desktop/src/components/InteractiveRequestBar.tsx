import { BellDot, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

import type { InteractiveRequest, InteractiveResponsePayload } from '@falcondeck/client-core'
import { InteractiveRequestCard } from '@falcondeck/chat-ui'
import { Badge } from '@falcondeck/ui'

export type InteractiveRequestBarProps = {
  requests: InteractiveRequest[]
  onRespond: (request: InteractiveRequest, response: InteractiveResponsePayload) => void
}

export function InteractiveRequestBar({ requests, onRespond }: InteractiveRequestBarProps) {
  const [expanded, setExpanded] = useState(false)

  if (requests.length === 0) return null

  return (
    <div className="border-b border-border-subtle">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 bg-warning-muted/30 px-4 py-2 text-[length:var(--fd-text-xs)] font-medium text-warning transition-colors hover:bg-warning-muted/50"
      >
        <BellDot className="h-3.5 w-3.5" />
        {requests.length === 1 ? '1 response pending' : `${requests.length} responses pending`}
        <Badge variant="warning" className="ml-1">{requests.length}</Badge>
        <span className="ml-auto">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded ? (
        <div className="max-h-[360px] space-y-2 overflow-y-auto bg-surface-1 p-3">
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
