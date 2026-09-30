import { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { AppState, View, type AppStateStatus } from 'react-native'
import { cleanup, renderComponent } from '@/test/render'
import { AnimationVisibility, ForegroundAnimations, useAnimationActive } from './AnimationVisibility'

function Consumer() {
  return <View testID={useAnimationActive() ? 'active' : 'paused'} />
}

afterEach(() => { cleanup(); AppState.currentState = 'active'; vi.restoreAllMocks() })

it('a visible nested region cannot restart animations under a hidden parent', () => {
  const tree = renderComponent(
    <AnimationVisibility active={false}><AnimationVisibility active><Consumer /></AnimationVisibility></AnimationVisibility>,
  )
  expect(tree.root.findByType('View' as any).props.testID).toBe('paused')
})

it('pauses in inactive/background states and resumes with one shared listener', () => {
  let change: (status: AppStateStatus) => void = () => {}
  const remove = vi.fn()
  const subscribe = vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    change = listener
    return { remove }
  })
  const tree = renderComponent(<ForegroundAnimations><Consumer /></ForegroundAnimations>)
  expect(tree.root.findByType('View' as any).props.testID).toBe('active')
  act(() => change('inactive'))
  expect(tree.root.findByType('View' as any).props.testID).toBe('paused')
  act(() => change('background'))
  expect(tree.root.findByType('View' as any).props.testID).toBe('paused')
  act(() => change('active'))
  expect(tree.root.findByType('View' as any).props.testID).toBe('active')
  expect(subscribe).toHaveBeenCalledTimes(1)
  act(() => tree.unmount())
  expect(remove).toHaveBeenCalledTimes(1)
})
