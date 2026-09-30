import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'

const AnimationActive = createContext(true)

/** Mounted drawers/screens can be covered without being unmounted. */
export function AnimationVisibility({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(AnimationActive)
  return <AnimationActive.Provider value={parentActive && active}>{children}</AnimationActive.Provider>
}

/** One application-state listener for all repeating status animations. */
export function ForegroundAnimations({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(() => AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'))
    setActive(AppState.currentState === 'active')
    return () => subscription.remove()
  }, [])
  return <AnimationVisibility active={active}>{children}</AnimationVisibility>
}

export function useAnimationActive() {
  return useContext(AnimationActive)
}
