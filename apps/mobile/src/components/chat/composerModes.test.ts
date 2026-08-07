import { describe, expect, it } from 'vitest'

import {
  SANDBOX_DEFAULT_VALUE,
  humanizeModeId,
  permissionChipLabel,
  permissionModeItems,
  permissionModeLabel,
  sandboxChipLabel,
  sandboxModeItems,
  sandboxModeLabel,
} from './composerModes'

// The daemon's real capability lists, so a rename there fails a test here.
const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']
const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

describe('mode labels', () => {
  it('names each Claude permission mode the way desktop does', () => {
    expect(CLAUDE_PERMISSION_MODES.map(permissionModeLabel)).toEqual([
      'Ask to approve',
      'Accept edits',
      'Auto',
      "Don't ask",
      'Bypass permissions',
    ])
  })

  it('names each Codex sandbox mode the way desktop does', () => {
    expect(CODEX_SANDBOX_MODES.map(sandboxModeLabel)).toEqual([
      'Read only',
      'Workspace write',
      'Full access',
    ])
  })

  it('humanizes ids this build has never seen', () => {
    expect(humanizeModeId('plan-only')).toBe('Plan only')
    expect(humanizeModeId('read_write')).toBe('Read write')
    expect(permissionModeLabel('someNewMode')).toBe('SomeNewMode')
    expect(sandboxModeLabel('brand-new')).toBe('Brand new')
  })
})

describe('permissionModeItems', () => {
  it('keeps daemon order and includes default', () => {
    expect(permissionModeItems(CLAUDE_PERMISSION_MODES).map((item) => item.value)).toEqual(
      CLAUDE_PERMISSION_MODES,
    )
  })

  it('is empty for a provider with no permission modes', () => {
    expect(permissionModeItems([])).toEqual([])
  })
})

describe('sandboxModeItems', () => {
  it('leads with a synthetic default the provider does not supply', () => {
    const items = sandboxModeItems(CODEX_SANDBOX_MODES)
    expect(items[0]).toEqual({ value: SANDBOX_DEFAULT_VALUE, label: 'Default sandbox' })
    expect(items.slice(1).map((item) => item.value)).toEqual(CODEX_SANDBOX_MODES)
  })

  it('does not offer the default twice if a provider names one', () => {
    const items = sandboxModeItems(['default', 'read-only'])
    expect(items.filter((item) => item.value === SANDBOX_DEFAULT_VALUE)).toHaveLength(1)
  })
})

describe('chip labels', () => {
  it("shows the provider's own default when nothing is chosen", () => {
    expect(permissionChipLabel(null, CLAUDE_PERMISSION_MODES)).toBe('Ask to approve')
  })

  it('falls back to a neutral noun when the provider has no default mode', () => {
    expect(permissionChipLabel(null, ['acceptEdits'])).toBe('Permissions')
  })

  it('shows the chosen mode', () => {
    expect(permissionChipLabel('dontAsk', CLAUDE_PERMISSION_MODES)).toBe("Don't ask")
    expect(sandboxChipLabel('danger-full-access')).toBe('Full access')
  })

  it('reads as the default sandbox when nothing is chosen', () => {
    expect(sandboxChipLabel(null)).toBe('Default sandbox')
  })
})
