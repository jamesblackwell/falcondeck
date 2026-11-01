import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FalconDeckPreferences } from '@falcondeck/client-core'

import { GeneralSettingsPanel } from './GeneralSettingsPanel'
import { SETTINGS_GROUPS } from './settings-utils'

const baseProps = {
  updater: { status: 'idle' },
  updaterProgressPercent: null,
  onCheckForUpdates: vi.fn(),
  onDownloadUpdate: vi.fn(),
  onRestartToInstallUpdate: vi.fn(),
  onShowOnboardingAtNextLaunch: vi.fn(),
} as never

describe('Review inbox setting', () => {
  it('reflects the preference and writes review_inbox_enabled', () => {
    const onUpdatePreferences = vi.fn()
    const { rerender } = render(
      <GeneralSettingsPanel
        {...(baseProps as object)}
        preferences={{ review_inbox_enabled: true } as FalconDeckPreferences}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    const toggle = screen.getByRole('switch', { name: 'Review inbox' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(onUpdatePreferences).toHaveBeenCalledWith({ review_inbox_enabled: false })

    rerender(
      <GeneralSettingsPanel
        {...(baseProps as object)}
        preferences={{ review_inbox_enabled: false } as FalconDeckPreferences}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    expect(screen.getByRole('switch', { name: 'Review inbox' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('switch', { name: 'Review inbox' }))
    expect(onUpdatePreferences).toHaveBeenLastCalledWith({ review_inbox_enabled: true })
  })

  it('is listed in the searchable General settings under the same title', () => {
    const general = SETTINGS_GROUPS.flatMap((group) => group.items).find((item) => item.id === 'general')
    expect(general?.settings).toContain('Review inbox')
  })
})
