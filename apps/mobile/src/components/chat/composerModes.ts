import type { OptionSheetItem } from '@/components/ui'

/** Labels are copied verbatim from the desktop composer so the two clients
    name the same setting the same way. */
const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Ask to approve',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

const SANDBOX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

/** The sheet value standing in for "send nothing and let the daemon decide". */
export const SANDBOX_DEFAULT_VALUE = 'default'

/** Providers can offer modes this build has never heard of, so unknown ids get
    a readable form rather than being dropped. */
export function humanizeModeId(id: string): string {
  const spaced = id.replace(/[-_]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function permissionModeLabel(mode: string): string {
  return PERMISSION_MODE_LABELS[mode] ?? humanizeModeId(mode)
}

export function sandboxModeLabel(mode: string): string {
  return SANDBOX_MODE_LABELS[mode] ?? humanizeModeId(mode)
}

/** Options in daemon order, `default` included — selecting it clears the
    override rather than sending the string. */
export function permissionModeItems(modes: readonly string[]): OptionSheetItem[] {
  return modes.map((mode) => ({ value: mode, label: permissionModeLabel(mode) }))
}

/** A synthetic "Default sandbox" leads, matching desktop: the provider's own
    modes never include the unset state. */
export function sandboxModeItems(modes: readonly string[]): OptionSheetItem[] {
  return [
    { value: SANDBOX_DEFAULT_VALUE, label: 'Default sandbox' },
    ...modes
      .filter((mode) => mode !== SANDBOX_DEFAULT_VALUE)
      .map((mode) => ({ value: mode, label: sandboxModeLabel(mode) })),
  ]
}

/** What the permission chip reads when nothing has been chosen: the provider's
    own `default` if it offers one, otherwise a neutral noun. */
export function permissionChipLabel(selected: string | null, modes: readonly string[]): string {
  if (selected) return permissionModeLabel(selected)
  return modes.includes('default') ? permissionModeLabel('default') : 'Permissions'
}

export function sandboxChipLabel(selected: string | null): string {
  return selected ? sandboxModeLabel(selected) : 'Default sandbox'
}
