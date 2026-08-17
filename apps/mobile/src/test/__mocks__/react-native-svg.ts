import type { ReactNode } from 'react'

export default function Svg({ children }: { children?: ReactNode }) {
  return children ?? null
}

export function Path() {
  return null
}
