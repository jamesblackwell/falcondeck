import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemotePreferencesModal } from './RemotePreferencesModal'
import type { NotificationPreference } from '../lib/remoteAppUtils'

function renderModal(overrides: Partial<Parameters<typeof RemotePreferencesModal>[0]> = {}) {
  const onClose = vi.fn()
  const onUpdatePreferences = vi.fn()
  const onNotificationPreferenceChange = vi.fn()
  render(
    <RemotePreferencesModal
      isOpen
      preferences={null}
      notificationPreference={'default' as NotificationPreference}
      onClose={onClose}
      onUpdatePreferences={onUpdatePreferences}
      onNotificationPreferenceChange={onNotificationPreferenceChange}
      {...overrides}
    />,
  )
  return { onClose, onUpdatePreferences, onNotificationPreferenceChange }
}

const notificationToggleName = /notify me about thread activity/i

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.style.overflow = ''
})

describe('RemotePreferencesModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <RemotePreferencesModal
        isOpen={false}
        preferences={null}
        notificationPreference="default"
        onClose={vi.fn()}
        onUpdatePreferences={vi.fn()}
        onNotificationPreferenceChange={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('is a modal dialog and locks the page behind it', () => {
    renderModal()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('closes on Escape', () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exposes tool detail options as a radio group', () => {
    renderModal()
    const group = screen.getByRole('radiogroup', { name: 'Tool detail' })
    // Defaults come from normalizePreferences, which falls back to 'collapsed'.
    expect(within(group).getByRole('radio', { name: 'Hidden' })).toBeChecked()
    fireEvent.click(within(group).getByRole('radio', { name: 'Expanded' }))
  })

  it('can change how reasoning is revealed', () => {
    const { onUpdatePreferences } = renderModal()
    const group = screen.getByRole('radiogroup', { name: 'Reasoning display' })
    expect(within(group).getByRole('radio', { name: /^Auto/ })).toBeChecked()

    fireEvent.click(within(group).getByRole('radio', { name: /^Preview/ }))
    expect(onUpdatePreferences).toHaveBeenCalledWith({
      conversation: { thinking_display: 'preview' },
    })
  })

  it('asks the browser for permission inside the click that enables notifications', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const { onNotificationPreferenceChange } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: notificationToggleName }))

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onNotificationPreferenceChange).toHaveBeenCalledWith('enabled'))
  })

  it('does not enable when the browser refuses the prompt', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    })
    const { onNotificationPreferenceChange } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: notificationToggleName }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/permission was not granted/i),
    )
    expect(onNotificationPreferenceChange).not.toHaveBeenCalled()
  })

  it('contains a notification API that throws synchronously', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn(() => {
        throw new Error('notifications unavailable')
      }),
    })
    const { onNotificationPreferenceChange } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: notificationToggleName }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/permission was not granted/i),
    )
    expect(onNotificationPreferenceChange).not.toHaveBeenCalled()
  })

  it('explains a hard browser block instead of re-prompting', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission })
    const { onNotificationPreferenceChange } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: notificationToggleName }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/blocking/i))
    expect(requestPermission).not.toHaveBeenCalled()
    expect(onNotificationPreferenceChange).not.toHaveBeenCalled()
  })

  it('turns notifications back off without touching the browser prompt', () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission })
    const { onNotificationPreferenceChange } = renderModal({ notificationPreference: 'enabled' })

    const toggle = screen.getByRole('button', { name: notificationToggleName })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)

    expect(onNotificationPreferenceChange).toHaveBeenCalledWith('disabled')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('reports unsupported browsers rather than failing silently', async () => {
    vi.stubGlobal('Notification', undefined)
    const { onNotificationPreferenceChange } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: notificationToggleName }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/does not support/i))
    expect(onNotificationPreferenceChange).not.toHaveBeenCalled()
  })
})
