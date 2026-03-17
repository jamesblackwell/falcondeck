import { describe, it, expect } from 'vitest'
import { SidebarView, ConnectionHeader } from './index'

describe('navigation barrel exports', () => {
  it('exports SidebarView', () => {
    expect(SidebarView).toBeDefined()
  })

  it('exports ConnectionHeader', () => {
    expect(ConnectionHeader).toBeDefined()
  })
})
