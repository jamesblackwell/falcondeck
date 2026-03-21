import { Badge, cn } from '@falcondeck/ui'

type PreferenceToggleProps = {
  label: string
  description: string
  enabled: boolean
  onToggle: (next: boolean) => void
}

export function PreferenceToggle({
  label,
  description,
  enabled,
  onToggle,
}: PreferenceToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      className={cn(
        'flex w-full items-start justify-between gap-4 rounded-[var(--fd-radius-lg)] border px-4 py-3 text-left transition-colors',
        enabled
          ? 'border-accent/40 bg-accent/10'
          : 'border-border-subtle bg-surface-2 hover:bg-surface-3',
      )}
    >
      <div>
        <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{label}</p>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">{description}</p>
      </div>
      <Badge variant={enabled ? 'success' : 'default'} dot>
        {enabled ? 'On' : 'Off'}
      </Badge>
    </button>
  )
}
