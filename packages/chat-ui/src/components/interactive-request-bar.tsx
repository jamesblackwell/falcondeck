import { useMemo, useState } from 'react'
import { BellDot, ChevronDown, ChevronUp } from 'lucide-react'

import {
  orderedInteractiveRequestQueue,
  type InteractiveRequest,
  type InteractiveResponsePayload,
} from '@falcondeck/client-core'
import { Badge } from '@falcondeck/ui'

import { InteractiveRequestCard } from './interactive-request-card'

export type InteractiveRequestBarProps = {
  requests: InteractiveRequest[]
  /** Returning the promise lets the card report a failed answer in place. */
  onRespond: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => void | Promise<void>
}

export function InteractiveRequestBar({ requests, onRespond }: InteractiveRequestBarProps) {
  const [expanded, setExpanded] = useState(true)
  const queue = useMemo(() => orderedInteractiveRequestQueue(requests), [requests])
  const activeRequest = queue[0] ?? null

  if (!activeRequest) return null

  return (
    <div className="shrink-0 border-t border-border-subtle bg-surface-1">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="fd-focus-inset flex w-full items-center gap-2 bg-warning-muted/20 px-4 py-2 text-[length:var(--fd-text-xs)] font-medium text-warning transition-colors hover:bg-warning-muted/35"
      >
        <BellDot aria-hidden="true" className="h-3.5 w-3.5" />
        {queue.length === 1 ? '1 response pending' : `${queue.length} responses pending`}
        <Badge variant="warning" className="ml-1">
          {queue.length}
        </Badge>
        <span aria-hidden="true" className="ml-auto">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 py-3">
          <InteractiveRequestCard
            key={activeRequest.request_id}
            request={activeRequest}
            pendingCount={queue.length}
            onRespond={(response) => Promise.resolve(onRespond(activeRequest, response))}
          />
        </div>
      ) : null}
    </div>
  )
}
