import { beforeEach, describe, expect, it } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import { setJson } from './mmkv'
import { loadAutomationCache } from './automation-cache'

describe('automation cache', () => {
  beforeEach(() => {
    __resetAllStores()
  })

  it('rejects null automation entries that would crash list consumers', () => {
    setJson('mobile.automations-cache', {
      version: 1,
      sessionId: 'session-1',
      automations: [null],
      settings: null,
      runsByAutomation: {},
      savedAt: '2026-08-30T00:00:00.000Z',
    })

    expect(loadAutomationCache('session-1')).toBeNull()
  })
})
