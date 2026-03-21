import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { useCollapsible } from './useCollapsible'

afterEach(cleanup)

describe('useCollapsible', () => {
  it('tracks open state and toggles it', () => {
    let value: ReturnType<typeof useCollapsible> | null = null

    function Harness({ open }: { open: boolean }) {
      value = useCollapsible(open)
      return null
    }

    const renderer = renderComponent(<Harness open={false} />)
    expect(value!.isOpen).toBe(false)

    expect(() => {
      act(() => {
        value!.toggle()
      })
    }).not.toThrow()

    act(() => {
      renderer.update(<Harness open={true} />)
    })
    expect(value!.isOpen).toBe(true)

    act(() => {
      renderer.update(<Harness open={false} />)
    })
    expect(value!.isOpen).toBe(false)

    expect(() =>
      value!.onContentLayout({ nativeEvent: { layout: { height: 120 } } } as any),
    ).not.toThrow()
  })
})
