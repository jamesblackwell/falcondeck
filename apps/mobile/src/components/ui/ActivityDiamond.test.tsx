import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import * as Reanimated from 'react-native-reanimated'

import { ActivityDiamond } from './ActivityDiamond'

const setReducedMotion = (
  Reanimated as unknown as { __setReducedMotionForTests: (value: boolean) => void }
).__setReducedMotionForTests

afterEach(() => setReducedMotion(false))

describe('ActivityDiamond reduced motion', () => {
  it('renders a static full-size diamond when the OS requests reduced motion', () => {
    setReducedMotion(true)
    let tree: ReturnType<typeof create>
    act(() => {
      tree = create(<ActivityDiamond color="#fff" />)
    })

    const animated = tree!.root.findByType('Animated.View' as any)
    expect(animated.props.style[2]).toEqual({
      opacity: 1,
      transform: [{ rotate: '45deg' }, { scale: 1 }],
    })
  })
})
