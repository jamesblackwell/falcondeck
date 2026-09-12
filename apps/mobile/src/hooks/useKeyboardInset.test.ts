import { describe, expect, it } from 'vitest'

import { keyboardInsetFromMetrics } from './useKeyboardInset'

const WINDOW = 874

describe('keyboardInsetFromMetrics', () => {
  it('pads by the keyboard height when it is docked to the bottom edge', () => {
    expect(keyboardInsetFromMetrics({ screenY: 538, height: 336 }, WINDOW)).toBe(336)
  })

  it('tolerates sub-pixel drift at the bottom edge', () => {
    expect(keyboardInsetFromMetrics({ screenY: 538.4, height: 336 }, WINDOW)).toBe(336)
  })

  it('ignores the launch-time frame that starts at the top of the screen', () => {
    // Resuming with a focused composer reports a frame that is not laid out
    // against the window yet; padding by it pushed the composer under the header.
    expect(keyboardInsetFromMetrics({ screenY: 0, height: 336 }, WINDOW)).toBe(0)
    expect(keyboardInsetFromMetrics({ screenY: 0, height: WINDOW }, WINDOW)).toBe(0)
  })

  it('ignores frames that stop short of the bottom edge (floating keyboard)', () => {
    expect(keyboardInsetFromMetrics({ screenY: 300, height: 200 }, WINDOW)).toBe(0)
  })

  it('ignores hidden or missing frames', () => {
    expect(keyboardInsetFromMetrics({ screenY: WINDOW, height: 0 }, WINDOW)).toBe(0)
    expect(keyboardInsetFromMetrics(null, WINDOW)).toBe(0)
    expect(keyboardInsetFromMetrics({ screenY: 538, height: 336 }, 0)).toBe(0)
  })
})
