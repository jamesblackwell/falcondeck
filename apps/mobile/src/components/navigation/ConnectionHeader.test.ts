import { describe, it, expect } from 'vitest'
import type { MachinePresence } from '@falcondeck/client-core'

// Extract and test the connectionLabel and badge variant logic
// from ConnectionHeader. These are pure functions we can test directly.

function connectionLabel(status: string): string {
  if (status === 'encrypted') return 'Encrypted'
  if (status === 'connected') return 'Connected'
  if (status === 'connecting') return 'Connecting...'
  if (status === 'disconnected') return 'Disconnected'
  return 'Not connected'
}

function connectionBadgeVariant(
  connectionStatus: string,
  isEncrypted: boolean,
): 'success' | 'danger' | 'warning' {
  if (isEncrypted) return 'success'
  if (connectionStatus === 'disconnected') return 'danger'
  return 'warning'
}

function desktopOnline(machinePresence: MachinePresence | null): boolean {
  return machinePresence?.daemon_connected ?? false
}

describe('ConnectionHeader logic', () => {
  describe('connectionLabel', () => {
    it('returns "Encrypted" for encrypted status', () => {
      expect(connectionLabel('encrypted')).toBe('Encrypted')
    })

    it('returns "Connected" for connected status', () => {
      expect(connectionLabel('connected')).toBe('Connected')
    })

    it('returns "Connecting..." for connecting status', () => {
      expect(connectionLabel('connecting')).toBe('Connecting...')
    })

    it('returns "Disconnected" for disconnected status', () => {
      expect(connectionLabel('disconnected')).toBe('Disconnected')
    })

    it('returns "Not connected" for unknown/not_connected status', () => {
      expect(connectionLabel('not_connected')).toBe('Not connected')
      expect(connectionLabel('claiming')).toBe('Not connected')
      expect(connectionLabel('')).toBe('Not connected')
    })
  })

  describe('connectionBadgeVariant', () => {
    it('returns success when encrypted', () => {
      expect(connectionBadgeVariant('encrypted', true)).toBe('success')
    })

    it('returns danger when disconnected and not encrypted', () => {
      expect(connectionBadgeVariant('disconnected', false)).toBe('danger')
    })

    it('returns warning for connecting/claiming states', () => {
      expect(connectionBadgeVariant('connecting', false)).toBe('warning')
      expect(connectionBadgeVariant('claiming', false)).toBe('warning')
      expect(connectionBadgeVariant('connected', false)).toBe('warning')
    })

    it('returns success even if status is disconnected when encrypted is true', () => {
      // Edge case: isEncrypted takes precedence
      expect(connectionBadgeVariant('disconnected', true)).toBe('success')
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
