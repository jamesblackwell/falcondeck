import { describe, it, expect } from 'vitest'
import type { MachinePresence } from '@falcondeck/client-core'

import { connectionLabel, connectionState } from './ConnectionHeader'

function desktopOnline(machinePresence: MachinePresence | null): boolean {
  return machinePresence?.daemon_connected ?? false
}

describe('ConnectionHeader logic', () => {
  describe('connectionLabel', () => {
    it('returns "Connected" for encrypted status', () => {
      expect(connectionLabel('encrypted')).toBe('Connected')
    })

    it('returns "Securing session…" for connected status', () => {
      expect(connectionLabel('connected')).toBe('Securing session…')
    })

    it('returns "Connecting…" for connecting status', () => {
      expect(connectionLabel('connecting')).toBe('Connecting…')
    })

    it('returns "Disconnected" for disconnected status', () => {
      expect(connectionLabel('disconnected')).toBe('Disconnected')
    })

    it('returns "Pairing…" for claiming status', () => {
      expect(connectionLabel('claiming')).toBe('Pairing…')
    })

    it('returns "Not connected" for unknown/not_connected status', () => {
      expect(connectionLabel('not_connected')).toBe('Not connected')
      expect(connectionLabel('')).toBe('Not connected')
    })
  })

  describe('connectionState', () => {
    it('returns connected success when relay is ready and desktop is online', () => {
      expect(connectionState('encrypted', true, true)).toEqual({
        tone: 'connected',
        label: 'Connected',
      })
    })

    it('returns desktop offline warning when relay is ready but desktop is offline', () => {
      expect(connectionState('encrypted', true, false)).toEqual({
        tone: 'disconnected',
        label: 'Your Mac is offline',
      })
    })

    it('returns a warning while the daemon RPC registry is repairing', () => {
      expect(connectionState('encrypted', true, true, false)).toEqual({
        tone: 'repairing',
        label: 'Sync repairing',
      })
    })

    it('waits for presence rather than claiming the desktop is offline', () => {
      expect(connectionState('encrypted', true, false, false, false)).toEqual({
        tone: 'repairing',
        label: 'Checking your Mac…',
      })
    })

    it('returns danger when disconnected and not encrypted', () => {
      expect(connectionState('disconnected', false, false)).toEqual({
        tone: 'disconnected',
        label: 'Disconnected',
      })
    })

    it('returns warning for connecting and claiming states', () => {
      expect(connectionState('connecting', false, false)).toEqual({
        tone: 'disconnected',
        label: 'Connecting…',
      })
      expect(connectionState('claiming', false, false)).toEqual({
        tone: 'disconnected',
        label: 'Pairing…',
      })
    })

    it('keeps disconnected state when the transport is no longer encrypted', () => {
      expect(connectionState('disconnected', false, true)).toEqual({
        tone: 'disconnected',
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
