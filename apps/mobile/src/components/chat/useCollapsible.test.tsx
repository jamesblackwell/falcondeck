import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup, renderComponent } from '@/test/render'

import { useCollapsible } from './useCollapsible'

afterEach(cleanup)

describe('useCollapsible', () => {
  it('snaps back to the new item default when the instance is recycled', () => {
    let value: ReturnType<typeof useCollapsible> | null = null

    function Harness({ open, itemId }: { open: boolean; itemId: string }) {
      value = useCollapsible(open, itemId)
      return null
    }

    const renderer = renderComponent(<Harness open={false} itemId="item-1" />)
    act(() => {
      value!.toggle()
    })
    expect(value!.isOpen).toBe(true)

    // FlashList reuses the component instance for a different block; the
    // previous block's open state must not leak into it.
    act(() => {
      renderer.update(<Harness open={false} itemId="item-2" />)
    })
    expect(value!.isOpen).toBe(false)
  })

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
