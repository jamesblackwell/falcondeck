import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-test-renderer'

import { cleanup, renderComponent } from '@/test/render'
import { useRelayStore, useSessionStore } from '@/store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  sidebarProps: null as Record<string, (...args: unknown[]) => unknown> | null,
}))

vi.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ navigate: mocks.navigate }),
}))

vi.mock('@react-navigation/drawer', () => ({
  useDrawerStatus: () => 'open',
}))

vi.mock('@react-navigation/native', () => ({
  DrawerActions: {
    closeDrawer: () => ({ type: 'CLOSE_DRAWER' }),
  },
}))

vi.mock('./SidebarView', () => ({
  SidebarView: (props: Record<string, (...args: unknown[]) => unknown>) => {
    mocks.sidebarProps = props
    return null
  },
}))

import { SidebarDrawerContent } from './SidebarDrawerContent'

afterEach(() => {
  cleanup()
  useSessionStore.getState().reset()
  vi.restoreAllMocks()
  mocks.navigate.mockReset()
  mocks.sidebarProps = null
})

describe('SidebarDrawerContent', () => {
  it('closes the drawer after selecting a conversation', () => {
    const dispatch = vi.fn()
    renderComponent(
      <SidebarDrawerContent navigation={{ dispatch } as never} />,
    )

    act(() => {
      mocks.sidebarProps?.onSelectThread('workspace-1', 'thread-1')
    })

    expect(useSessionStore.getState().selectedWorkspaceId).toBe('workspace-1')
    expect(useSessionStore.getState().selectedThreadId).toBe('thread-1')
    expect(mocks.navigate).toHaveBeenCalledWith('/(app)')
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' })
  })

  it('closes the drawer after starting a new conversation', () => {
    const dispatch = vi.fn()
    renderComponent(
      <SidebarDrawerContent navigation={{ dispatch } as never} />,
    )

    act(() => {
      mocks.sidebarProps?.onNewThread('workspace-1')
    })

    expect(useSessionStore.getState().selectedWorkspaceId).toBe('workspace-1')
    expect(useSessionStore.getState().selectedThreadId).toBeNull()
    expect(mocks.navigate).toHaveBeenCalledWith('/(app)')
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' })
  })

  it('closes the drawer after creating a standalone chat', async () => {
    vi.spyOn(useRelayStore.getState(), '_callRpc').mockResolvedValue({
      id: 'chat-workspace',
    } as never)
    const dispatch = vi.fn()
    renderComponent(
      <SidebarDrawerContent navigation={{ dispatch } as never} />,
    )

    await act(async () => {
      await mocks.sidebarProps?.onNewChat()
    })

    expect(useSessionStore.getState().selectedWorkspaceId).toBe('chat-workspace')
    expect(useSessionStore.getState().selectedThreadId).toBeNull()
    expect(mocks.navigate).toHaveBeenCalledWith('/(app)')
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' })
  })

  it('responds immediately while standalone chat creation is pending', async () => {
    let resolveRpc!: (workspace: { id: string }) => void
    const rpc = new Promise<{ id: string }>((resolve) => {
      resolveRpc = resolve
    })
    vi.spyOn(useRelayStore.getState(), '_callRpc').mockReturnValue(rpc as never)
    const dispatch = vi.fn()
    renderComponent(
      <SidebarDrawerContent navigation={{ dispatch } as never} />,
    )

    let pending!: Promise<void>
    act(() => {
      pending = mocks.sidebarProps?.onNewChat() as Promise<void>
    })

    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' })
    expect(mocks.navigate).not.toHaveBeenCalled()

    await act(async () => {
      resolveRpc({ id: 'chat-workspace' })
      await pending
    })

    expect(mocks.navigate).toHaveBeenCalledWith('/(app)')
  })
})
