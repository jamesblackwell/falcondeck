import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import ConversationSettingsScreen from '@/app/(app)/settings/conversation'
import NotificationSettingsScreen from '@/app/(app)/settings/notifications'
import { setPushEnabled } from '@/lib/push-notifications'
import { useRelayStore } from '@/store/relay-store'
import { useSessionStore } from '@/store/session-store'
import { snapshot, snapshotEvent } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('mobile preference screens', () => {
  const originalCallRpc = useRelayStore.getState()._callRpc

  beforeEach(() => {
    __resetAllStores()
    useSessionStore.getState().reset()
    useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot()))
    useRelayStore.getState()._callRpc = originalCallRpc
  })

  afterEach(cleanup)

  it('coalesces repeated conversation preference taps while the update is pending', async () => {
    const response = deferred<unknown>()
    const rpc = vi.fn().mockReturnValue(response.promise)
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const renderer = renderComponent(<ConversationSettingsScreen />)
    const expanded = renderer.root.findByProps({ label: 'Expanded' })

    act(() => {
      expanded.props.onPress()
      expanded.props.onPress()
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    await act(async () => {
      response.resolve(snapshot().preferences)
      await response.promise
    })
  })

  it('coalesces repeated notification preference taps while the update is pending', async () => {
    const response = deferred<unknown>()
    const rpc = vi.fn().mockReturnValue(response.promise)
    useRelayStore.getState()._callRpc = rpc as typeof originalCallRpc
    const renderer = renderComponent(<NotificationSettingsScreen />)
    const push = renderer.root.findByProps({ accessibilityLabel: 'Push notifications' })

    act(() => {
      push.props.onValueChange(false)
      push.props.onValueChange(false)
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    await act(async () => {
      response.resolve(snapshot().preferences)
      await response.promise
    })
  })

  it('keeps a device-local push disable visible when daemon preferences are enabled', () => {
    setPushEnabled(false)

    const renderer = renderComponent(<NotificationSettingsScreen />)

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Push notifications' }).props.value,
    ).toBe(false)
  })
})
