import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import * as Reanimated from 'react-native-reanimated'

import { Spinner } from './Spinner'

const setReducedMotion = (
  Reanimated as unknown as { __setReducedMotionForTests: (value: boolean) => void }
).__setReducedMotionForTests

afterEach(() => setReducedMotion(false))

describe('Spinner reduced motion', () => {
  it('renders a static progress glyph when the OS requests reduced motion', () => {
    setReducedMotion(true)
    let tree: ReturnType<typeof create>
    act(() => {
      tree = create(<Spinner color="#fff" />)
    })

    const animated = tree!.root.findByType('Animated.View' as any)
    expect(animated.props.style).toEqual({ transform: [{ rotate: '0deg' }] })
  })
})
