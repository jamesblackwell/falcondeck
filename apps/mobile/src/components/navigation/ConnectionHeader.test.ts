import { describe, it, expect } from 'vitest'
import type { MachinePresence } from '@falcondeck/client-core'

// Extract and test the connectionLabel and badge variant logic
// from ConnectionHeader. These are pure functions we can test directly.

function connectionLabel(status: string): string {
  if (status === 'encrypted') return 'Connected'
  if (status === 'connected') return 'Securing session...'
  if (status === 'connecting') return 'Connecting...'
  if (status === 'disconnected') return 'Disconnected'
  if (status === 'claiming') return 'Pairing...'
  return 'Not connected'
}

function connectionBadgeState(
  connectionStatus: string,
  isEncrypted: boolean,
  isDesktopOnline: boolean,
): { variant: 'success' | 'danger' | 'warning'; label: string } {
  const relayReady = connectionStatus === 'encrypted' && isEncrypted

  if (relayReady) {
    if (isDesktopOnline) return { variant: 'success', label: 'Connected' }
    return { variant: 'warning', label: 'Desktop offline' }
  }

  return {
    variant: connectionStatus === 'disconnected' ? 'danger' : 'warning',
    label: connectionLabel(connectionStatus),
  }
}

function desktopOnline(machinePresence: MachinePresence | null): boolean {
  return machinePresence?.daemon_connected ?? false
}

describe('ConnectionHeader logic', () => {
  describe('connectionLabel', () => {
    it('returns "Connected" for encrypted status', () => {
      expect(connectionLabel('encrypted')).toBe('Connected')
    })

    it('returns "Securing session..." for connected status', () => {
      expect(connectionLabel('connected')).toBe('Securing session...')
    })

    it('returns "Connecting..." for connecting status', () => {
      expect(connectionLabel('connecting')).toBe('Connecting...')
    })

    it('returns "Disconnected" for disconnected status', () => {
      expect(connectionLabel('disconnected')).toBe('Disconnected')
    })

    it('returns "Pairing..." for claiming status', () => {
      expect(connectionLabel('claiming')).toBe('Pairing...')
    })

    it('returns "Not connected" for unknown/not_connected status', () => {
      expect(connectionLabel('not_connected')).toBe('Not connected')
      expect(connectionLabel('')).toBe('Not connected')
    })
  })

  describe('connectionBadgeState', () => {
    it('returns connected success when relay is ready and desktop is online', () => {
      expect(connectionBadgeState('encrypted', true, true)).toEqual({
        variant: 'success',
        label: 'Connected',
      })
    })

    it('returns desktop offline warning when relay is ready but desktop is offline', () => {
      expect(connectionBadgeState('encrypted', true, false)).toEqual({
        variant: 'warning',
        label: 'Desktop offline',
      })
    })

    it('returns danger when disconnected and not encrypted', () => {
      expect(connectionBadgeState('disconnected', false, false)).toEqual({
        variant: 'danger',
        label: 'Disconnected',
      })
    })

    it('returns warning for connecting and claiming states', () => {
      expect(connectionBadgeState('connecting', false, false)).toEqual({
        variant: 'warning',
        label: 'Connecting...',
      })
      expect(connectionBadgeState('claiming', false, false)).toEqual({
        variant: 'warning',
        label: 'Pairing...',
      })
    })

    it('keeps disconnected state when the transport is no longer encrypted', () => {
      expect(connectionBadgeState('disconnected', false, true)).toEqual({
        variant: 'danger',
        label: 'Disconnected',
      })
    })
  })

  describe('desktopOnline', () => {
    it('returns false when machinePresence is null', () => {
      expect(desktopOnline(null)).toBe(false)
    })

    it('returns false when daemon_connected is false', () => {
      expect(desktopOnline({
        session_id: 's1',
        daemon_connected: false,
        last_seen_at: null,
      })).toBe(false)
    })

    it('returns true when daemon_connected is true', () => {
      expect(desktopOnline({
        session_id: 's1',
        daemon_connected: true,
        last_seen_at: '2026-03-16T10:00:00Z',
      })).toBe(true)
    })
  })
})
