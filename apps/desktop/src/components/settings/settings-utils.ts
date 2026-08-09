import type {
  RemoteStatusResponse,
  ThinkingDisplay,
  ToolDetailsMode,
  TrustedDevice,
} from '@falcondeck/client-core'
import { Bot, Keyboard, Palette, Plug, Server, Settings, Wifi } from 'lucide-react'

import type { AppUpdaterState } from '../../hooks/useAppUpdater'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'keyboard'
  | 'servers'
  | 'agents'
  | 'connectors'
  | 'remote'

export type SettingsNavItem = {
  id: SettingsSectionId
  label: string
  description: string
  icon: typeof Settings
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Core app behavior and future defaults',
    icon: Settings,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, fonts, and text size',
    icon: Palette,
  },
  {
    id: 'keyboard',
    label: 'Keyboard Shortcuts',
    description: 'Customize every command',
    icon: Keyboard,
  },
  {
    id: 'servers',
    label: 'Servers',
    description: 'Run agents on remote machines',
    icon: Server,
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Built-in and custom ACP agents',
    icon: Bot,
  },
  {
    id: 'connectors',
    label: 'Connectors',
    description: 'MCP servers and agent tools',
    icon: Plug,
  },
  {
    id: 'remote',
    label: 'Remote Access',
    description: 'Pairing, devices, and relay status',
    icon: Wifi,
  },
]

export const TOOL_DETAIL_OPTIONS: Array<{
  value: ToolDetailsMode
  label: string
  description: string
}> = [
  {
    value: 'collapsed',
    label: 'Hidden',
    description: 'Fold tool activity behind a single "Worked for…" line, expandable on click. The default.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Collapse repeated read-only tool chatter, but auto-open diffs, approvals, and failures.',
  },
  {
    value: 'expanded',
    label: 'Expanded',
    description: 'Keep tool output open by default for dense debugging sessions.',
  },
  {
    value: 'compact',
    label: 'Compact',
    description: 'Prefer grouped summaries for read-only work while keeping artifacts visible.',
  },
  {
    value: 'hide_read_only_details',
    label: 'Hide read-only details',
    description: 'Show grouped summaries for read-only inspection without rendering their raw output.',
  },
]

export const THINKING_DISPLAY_OPTIONS: Array<{
  value: ThinkingDisplay
  label: string
  description: string
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Expand the thought while it streams, then collapse it when it ends — unless you opened it yourself. The default.',
  },
  {
    value: 'preview',
    label: 'Preview',
    description: 'Keep a few faded lines of every thought visible; click to read the rest.',
  },
  {
    value: 'always_expanded',
    label: 'Always expanded',
    description: 'Show reasoning in full, for following exactly how the agent got there.',
  },
  {
    value: 'always_collapsed',
    label: 'Always collapsed',
    description: 'Keep every thought behind its own line until you ask for it.',
  },
]

export function statusVariant(status: RemoteStatusResponse['status'] | TrustedDevice['status']) {
  switch (status) {
    case 'connected':
    case 'device_trusted':
    case 'active':
      return 'success'
    case 'pairing_pending':
    case 'connecting':
    case 'degraded':
    case 'offline':
      return 'warning'
    case 'revoked':
      return 'danger'
    default:
      return 'default'
  }
}

export function statusLabel(status: RemoteStatusResponse['status'] | TrustedDevice['status']) {
  switch (status) {
    case 'pairing_pending':
      return 'Waiting for device'
    case 'device_trusted':
      return 'Trusted'
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'degraded':
      return 'Reconnecting'
    case 'offline':
      return 'Offline'
    case 'revoked':
      return 'Revoked'
    case 'active':
      return 'Active'
    case 'error':
      return 'Error'
    case 'inactive':
    default:
      return 'Inactive'
  }
}

export function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  } catch {
    return value
  }
}

export function formatRelative(value: string | null) {
  if (!value) return 'Never'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return formatDateTime(value)

  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const absSeconds = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (absSeconds < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  return formatter.format(days, 'day')
}

export function isMobileDeviceLabel(label: string | null) {
  const normalized = label?.toLowerCase() ?? ''
  return (
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('android')
  )
}

export function updateBadgeVariant(status: AppUpdaterState['status']) {
  switch (status) {
    case 'available':
    case 'downloaded':
      return 'warning'
    case 'upToDate':
      return 'success'
    case 'error':
      return 'danger'
    default:
      return 'default'
  }
}

export function updateStatusLabel(status: AppUpdaterState['status']) {
  switch (status) {
    case 'checking':
      return 'Checking'
    case 'available':
      return 'Update available'
    case 'downloading':
      return 'Downloading'
    case 'downloaded':
      return 'Ready to restart'
    case 'upToDate':
      return 'Up to date'
    case 'error':
      return 'Needs attention'
    case 'unsupported':
      return 'Unavailable'
    default:
      return 'Idle'
  }
}
