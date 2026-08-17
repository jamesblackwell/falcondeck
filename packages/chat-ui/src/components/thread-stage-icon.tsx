import { memo } from 'react'

import type { ThreadTag } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

const STAGE_COLOR_CLASS: Record<string, string> = {
  gray: 'text-fg-muted',
  red: 'text-danger',
  orange: 'text-warning',
  yellow: 'text-warning',
  green: 'text-success',
  blue: 'text-info',
  purple: 'text-accent',
  pink: 'text-accent',
}

function iconFor(stage: Pick<ThreadTag, 'id' | 'icon'>): string {
  return stage.icon ?? (stage.id === 'custom' ? 'custom' : stage.id)
}

function StageGlyph({ icon }: { icon: string }) {
  const common = {
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true as const,
    className: 'h-full w-full',
  }
  switch (icon) {
    case 'backlog':
      return (
        <svg {...common}>
          <circle
            cx="8"
            cy="8"
            r="5.25"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeDasharray="2.5 2.15"
          />
        </svg>
      )
    case 'in_progress':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.75" />
          <path d="M8 2.75A5.25 5.25 0 0 1 8 13.25Z" fill="currentColor" />
        </svg>
      )
    case 'in_review':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M8 2.75A5.25 5.25 0 1 1 2.75 8L8 8Z"
            fill="currentColor"
          />
        </svg>
      )
    case 'done':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M5.1 8.15 7.05 10.1 10.9 5.9"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'canceled':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill="currentColor" />
        </svg>
      )
  }
}

export const ThreadStageIcon = memo(function ThreadStageIcon({
  stage,
  className,
}: {
  stage: Pick<ThreadTag, 'id' | 'color' | 'icon'>
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center',
        STAGE_COLOR_CLASS[stage.color] ?? 'text-fg-muted',
        className,
      )}
    >
      <StageGlyph icon={iconFor(stage)} />
    </span>
  )
})
