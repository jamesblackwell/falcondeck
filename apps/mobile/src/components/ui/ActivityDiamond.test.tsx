import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Animated } from 'react-native'

import * as Reanimated from 'react-native-reanimated'

import { ActivityDiamond } from './ActivityDiamond'
import { cleanup, renderComponent } from '@/test/render'

const setReducedMotion = (
  Reanimated as unknown as { __setReducedMotionForTests: (value: boolean) => void }
).__setReducedMotionForTests

afterEach(() => { cleanup(); setReducedMotion(false); vi.restoreAllMocks() })

describe('ActivityDiamond clock', () => {
  it('renders a static full-size diamond when the OS requests reduced motion', () => {
    setReducedMotion(true)
    const loop = vi.spyOn(Animated, 'loop')
    const tree = renderComponent(<ActivityDiamond color="#fff" />)

    const animated = tree.root.findByType('Animated.View' as any)
    expect(animated.props.style[2]).toEqual({
      opacity: 1,
      transform: [{ rotate: '45deg' }, { scale: 1 }],
    })
    expect(loop).not.toHaveBeenCalled()
  })

  it('shares one native driver and stops only when its last consumer leaves', () => {
    const start = vi.fn(), stop = vi.fn()
    const timing = vi.spyOn(Animated, 'timing')
    const loop = vi.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: vi.fn() })
    const first = renderComponent(<ActivityDiamond color="#fff" />)
    const second = renderComponent(<ActivityDiamond color="#fff" variant="outline" />)
    expect(loop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      useNativeDriver: true, isInteraction: false, duration: 2400,
    }))
    act(() => first.update(<ActivityDiamond color="#000" size={24} />))
    expect(loop).toHaveBeenCalledTimes(1)
    act(() => first.unmount())
    expect(stop).not.toHaveBeenCalled()
    act(() => second.unmount())
    expect(stop).toHaveBeenCalledTimes(1)
  })

})
