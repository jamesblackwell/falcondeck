import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('shared DOM reduced-motion contract', () => {
  it('covers both DOM clients and suppresses animation, transitions, and smooth scrolling', () => {
    const shared = readFileSync(
      resolve(process.cwd(), '../../packages/ui/src/styles.css'),
      'utf8',
    )
    const desktop = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const remote = readFileSync(
      resolve(process.cwd(), '../remote-web/src/styles.css'),
      'utf8',
    )

    expect(desktop).toContain('@import "@falcondeck/ui/styles.css"')
    expect(remote).toContain('@import "@falcondeck/ui/styles.css"')
    expect(shared).toContain('@media (prefers-reduced-motion: reduce)')
    expect(shared).toContain('animation-duration: 0.01ms !important')
    expect(shared).toContain('transition-duration: 0.01ms !important')
    expect(shared).toContain('scroll-behavior: auto !important')
  })
})
