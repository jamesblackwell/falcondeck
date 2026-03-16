import { cn } from '../lib/utils'

type StatusIndicatorProps = {
  status: 'idle' | 'active' | 'warning' | 'error' | 'connected' | 'disconnected'
  size?: 'sm' | 'md'
  pulse?: boolean
  className?: string
}

const statusColors: Record<StatusIndicatorProps['status'], string> = {
  idle: 'bg-fg-muted',
  active: 'bg-accent',
  warning: 'bg-warning',
  error: 'bg-danger',
  connected: 'bg-success',
  disconnected: 'bg-fg-faint',
}

export function StatusIndicator({ status, size = 'sm', pulse = false, className }: StatusIndicatorProps) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded-full',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2.5 w-2.5',
        statusColors[status],
        pulse && 'animate-pulse',
        className,
      )}
    />
  )
}
