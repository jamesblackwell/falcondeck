import { beforeEach, describe, expect, it } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import { MOBILE_SESSION_CACHE_VERSION } from '@falcondeck/client-core'

import { getJson, setJson } from './mmkv'
import {
  loadMobileSessionCache,
  persistMobileSessionCache,
  setMobileSessionCacheKey,
} from './mobile-session-cache'

describe('mobile session cache', () => {
  beforeEach(() => {
    __resetAllStores()
    setMobileSessionCacheKey(new Uint8Array(32).fill(7))
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

  it('encrypts snapshots at rest and rejects a different session key', () => {
    const cache = {
      version: MOBILE_SESSION_CACHE_VERSION,
      snapshot: { workspaces: [], threads: [], interactive_requests: [] },
      selectedWorkspaceId: null,
      selectedThreadId: null,
      recentThreadIds: [],
      threadHistories: {},
    }
    persistMobileSessionCache(cache as never)

    const raw = JSON.stringify(getJson('mobile.session-cache'))
    expect(raw).not.toContain('interactive_requests')
    expect(loadMobileSessionCache()).toMatchObject(cache)

    setMobileSessionCacheKey(new Uint8Array(32).fill(8))
    expect(loadMobileSessionCache()).toBeNull()
  })
})
