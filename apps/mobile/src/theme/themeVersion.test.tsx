import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

const native = vi.hoisted(() => ({
  listener: null as ((dependencies: number[]) => void) | null,
}))

vi.mock('react-native-unistyles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native-unistyles')>()
  return {
    ...actual,
    StyleSheet: {
      ...actual.StyleSheet,
      addChangeListener: (onChanged: (dependencies: number[]) => void) => {
        native.listener = onChanged
        return () => {
          native.listener = null
        }
      },
    },
  }
})

import { useThemeVersion } from './themeVersion'

afterEach(cleanup)

function Probe({ onRender }: { onRender: (version: number) => void }) {
  onRender(useThemeVersion())
  return null
}

describe('useThemeVersion', () => {
  it('re-renders a memoised subtree when the theme changes, and only then', () => {
    const renders: number[] = []
    const Memo = React.memo(Probe)
    renderComponent(<Memo onRender={(version) => renders.push(version)} />)
    expect(renders).toEqual([0])

    // Insets, orientation and the like do not touch colours.
    act(() => native.listener?.([9, 7]))
    expect(renders).toHaveLength(1)

    act(() => native.listener?.([0]))
    expect(renders).toEqual([0, 1])

    // Switching light/dark reports the theme name.
    act(() => native.listener?.([1, 5]))
    expect(renders).toEqual([0, 1, 2])
  })
})
