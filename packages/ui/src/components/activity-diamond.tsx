import { cn } from '../lib/utils'

type ActivityDiamondProps = {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** `current` inherits the surrounding text colour — for diamonds inside
   *  buttons and chips that already carry their own foreground. */
  tone?: 'accent' | 'current'
  /** `outline` marks work that is in flight without the agent generating —
   *  a backgrounded command the thread is waiting on. Same shape, less ink,
   *  so it reads as "still live" rather than "streaming now". */
  variant?: 'solid' | 'outline'
  className?: string
}

const BOX: Record<NonNullable<ActivityDiamondProps['size']>, string> = {
  xs: 'h-3 w-3',
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
}

const MARK: Record<NonNullable<ActivityDiamondProps['size']>, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
}

/** A quiet active-state marker for live agent work and in-place loading. */
export function ActivityDiamond({
  size = 'sm',
  tone = 'accent',
  variant = 'solid',
  className,
}: ActivityDiamondProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center animate-diamond-activity',
        BOX[size],
        className,
      )}
    >
      <span
        className={cn(
          'block rotate-45',
          variant === 'outline'
            ? cn(
                'border',
                tone === 'current' ? 'border-current' : 'border-accent',
              )
            : tone === 'current'
              ? 'bg-current'
              : 'bg-accent',
          MARK[size],
        )}
      />
    </span>
  )
}
