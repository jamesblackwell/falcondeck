import { memo, useMemo } from 'react'
import { Workflow } from 'lucide-react'

import type { ActiveSubagent } from '@falcondeck/client-core'
import { ActivityDiamond, Badge, cn } from '@falcondeck/ui'

/** Lines shown under a sidebar row before the rest collapse into "+N more". */
const MAX_LINES = 3

export function formatSubagentElapsed(startedAt: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function describe(agent: ActiveSubagent) {
  return [
    agent.label,
    agent.agent_type ? `(${agent.agent_type})` : null,
    agent.background ? '· background' : null,
  ]
    .filter(Boolean)
    .join(' ')
}

/** Tooltip text listing every running sub-agent, one per line. */
export function describeSubagents(agents: ActiveSubagent[]) {
  return agents.map(describe).join('\n')
}

export type SubagentLinesProps = {
  agents: ActiveSubagent[]
  /** The owning row's spawn-tree depth, so the lines indent under its title. */
  depth?: number
  /** The owning row's trunk mask: ancestor uprights pass through the lines. */
  trunkMask?: number
  /** Re-render clock for the elapsed labels. */
  nowTick?: number
}

/** Rung geometry shared with ThreadItem's nesting connector. */
const NESTING_RUNG = 14
const NESTING_LINE = 6

/**
 * Read-only lines under a sidebar thread row naming the native sub-agents it
 * is running. They are not threads: no selection, no menu. The row above
 * stays the click target.
 */
export const SubagentLines = memo(function SubagentLines({
  agents,
  depth = 0,
  trunkMask = 0,
  nowTick = 0,
}: SubagentLinesProps) {
  const now = useMemo(() => Date.now(), [nowTick, agents])
  if (agents.length === 0) return null
  const shown = agents.slice(0, MAX_LINES)
  const hidden = agents.length - shown.length
  return (
    <ul
      aria-label={`${agents.length} running sub-agent${agents.length === 1 ? '' : 's'}`}
      data-testid="thread-subagents"
      className="@container relative -mt-1 mb-0.5 flex flex-col"
      // Title column: row padding + status slot + gap, past the elbow.
      style={{ paddingLeft: depth * NESTING_RUNG + 32 }}
    >
      {Array.from({ length: depth }, (_, index) => index + 1)
        .filter((rung) => trunkMask & (1 << (rung - 1)))
        .map((rung) => (
          <span
            key={rung}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 border-l border-border-emphasis"
            style={{ left: 10 + (rung - 1) * NESTING_RUNG + NESTING_LINE }}
          />
        ))}
      {shown.map((agent) => (
        <li
          key={agent.id}
          title={describe(agent)}
          className="flex min-w-0 items-center gap-1.5 py-0.5 pr-2.5 text-[length:var(--fd-text-xs)] text-fg-muted"
        >
          <ActivityDiamond size="xs" />
          <span className="min-w-0 flex-1 truncate text-fg-secondary">{agent.label}</span>
          {agent.agent_type ? (
            <span className="hidden shrink-0 truncate @[13rem]:inline">{agent.agent_type}</span>
          ) : null}
          <span className="fd-type-meta shrink-0 tabular-nums">
            {formatSubagentElapsed(agent.started_at, now)}
          </span>
        </li>
      ))}
      {hidden > 0 ? (
        <li
          title={describeSubagents(agents.slice(MAX_LINES))}
          className="py-0.5 pl-[18px] text-[length:var(--fd-text-xs)] text-fg-muted"
        >
          +{hidden} more
        </li>
      ) : null}
    </ul>
  )
})

/** Compact header badge: "2 agents", with the list in its tooltip. */
export function SubagentBadge({
  agents,
  className,
}: {
  agents: ActiveSubagent[]
  className?: string
}) {
  if (agents.length === 0) return null
  const noun = agents.length === 1 ? 'agent' : 'agents'
  return (
    <Badge
      variant="default"
      role="status"
      aria-label={`${agents.length} running sub-${noun}: ${agents.map((a) => a.label).join(', ')}`}
      title={describeSubagents(agents)}
      className={cn(
        'h-5 gap-1 px-1.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em]',
        className,
      )}
    >
      <Workflow aria-hidden="true" className="h-3 w-3" />
      {agents.length} {noun}
    </Badge>
  )
}

/** Stable identity for memo comparators. */
export function subagentsKey(agents: ActiveSubagent[] | undefined) {
  return (agents ?? [])
    .map((a) => `${a.id}:${a.label}:${a.agent_type ?? ''}:${a.background ? 1 : 0}`)
    .join('|')
}
