import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThreadSummary } from '@falcondeck/client-core'
import { thread } from '@/test/factories'
import { cleanup, renderComponent } from '@/test/render'
import { SessionListItem } from './SessionListItem'

afterEach(cleanup)

describe('SessionListItem agent origin', () => {
  it('marks agent-created tasks and keeps the row selectable', () => {
    const onSelectThread = vi.fn()
    const renderer = renderComponent(
      <SessionListItem
        thread={thread({
          id: 'child-1',
          origin: { kind: 'agent_spawn', parent_thread_id: 'parent-1' },
        })}
        workspaceId="workspace-1"
        isSelected={false}
        onSelectThread={onSelectThread}
      />,
    )

    expect(renderer.root.findByProps({
      accessibilityLabel: 'Created by an agent',
    }).props.accessibilityRole).toBe('image')
    act(() => {
      renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress()
    })
    expect(onSelectThread).toHaveBeenCalledWith('workspace-1', 'child-1')
  })

  it('swaps the marker for the nesting elbow once the row sits under its parent', () => {
    const spawned = thread({
      id: 'child-1',
      origin: { kind: 'agent_spawn', parent_thread_id: 'parent-1' },
    })
    const renderRow = (depth: number, trunkMask = 0) => (
      <SessionListItem
        thread={spawned}
        workspaceId="workspace-1"
        isSelected={false}
        onSelectThread={() => {}}
        depth={depth}
        trunkMask={trunkMask}
      />
    )
    const renderer = renderComponent(renderRow(0))
    const connectors = () =>
      renderer.root.findAllByProps({ testID: 'thread-nesting-connector' })
    const markers = () =>
      renderer.root.findAllByProps({ accessibilityLabel: 'Created by an agent' })
    expect(connectors()).toHaveLength(0)
    expect(markers()).toHaveLength(1)

    // Nested under its parent, with a sibling still to come: an elbow plus the
    // upright that carries on down to it.
    act(() => renderer.update(renderRow(1, 0b1)))
    expect(connectors()).not.toHaveLength(0)
    expect(markers()).toHaveLength(0)
    expect(connectors()[0].children).toHaveLength(2)

    // Last child: the elbow alone, with nothing continuing below it.
    act(() => renderer.update(renderRow(1)))
    expect(connectors()[0].children).toHaveLength(1)
  })

  it('updates the marker with the origin without marking manual or automated tasks', () => {
    const base = thread()
    const onSelectThread = vi.fn()
    const renderRow = (value: ThreadSummary) => (
      <SessionListItem
        thread={value}
        workspaceId="workspace-1"
        isSelected={false}
        onSelectThread={onSelectThread}
      />
    )
    const renderer = renderComponent(renderRow(base))
    const markers = () => renderer.root.findAllByProps({
      accessibilityLabel: 'Created by an agent',
    })
    expect(markers()).toHaveLength(0)

    act(() => renderer.update(renderRow({
      ...base,
      origin: { kind: 'agent_spawn', parent_thread_id: 'parent-1' },
    })))
    expect(markers()).toHaveLength(1)

    act(() => renderer.update(renderRow({
      ...base,
      origin: { kind: 'automation', automation_id: 'automation-1', name: 'Daily check' },
    })))
    expect(markers()).toHaveLength(0)
  })
})
