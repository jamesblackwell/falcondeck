import { beforeEach, describe, expect, it } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import { MOBILE_SESSION_CACHE_VERSION } from '@falcondeck/client-core'

import { getJson, setJson } from './mmkv'
import { loadMobileSessionCache } from './mobile-session-cache'

describe('mobile session cache', () => {
  beforeEach(() => {
    __resetAllStores()
  })

  it('rejects a version-matching cache whose thread history cannot hydrate', () => {
    setJson('mobile.session-cache', {
      version: MOBILE_SESSION_CACHE_VERSION,
      snapshot: { workspaces: [], threads: [], interactive_requests: [] },
      selectedWorkspaceId: null,
      selectedThreadId: null,
      recentThreadIds: ['thread-1'],
      threadHistories: {
        'thread-1': { thread_id: 'thread-1', items: null },
      },
    })

    expect(loadMobileSessionCache()).toBeNull()
    expect(getJson('mobile.session-cache')).toBeNull()
  })
})
