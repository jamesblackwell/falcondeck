import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useVirtualRows } from './useVirtualRows'

type HarnessProps = {
  rowCount: number
  clientHeight?: number
  scrollTop?: number
}

function Harness({ rowCount, clientHeight = 0, scrollTop = 0 }: HarnessProps) {
  const rows = useVirtualRows(rowCount, 32)
  return (
    <div
      ref={(node) => {
        rows.containerRef(node)
        if (node && clientHeight > 0) {
          Object.defineProperty(node, 'clientHeight', {
            value: clientHeight,
            configurable: true,
          })
          node.scrollTop = scrollTop
        }
      }}
      onScroll={rows.onScroll}
    >
      <span data-testid="range">
        {rows.start}:{rows.end}:{rows.offsetY}:{rows.totalHeight}
      </span>
    </div>
  )
}

describe('useVirtualRows', () => {
  it('renders every row until the viewport has been measured', () => {
    render(<Harness rowCount={50} />)
    expect(screen.getByTestId('range').textContent).toBe('0:50:0:1600')
  })

  it('windows rows around the scroll position once measured', () => {
    const { container } = render(<Harness rowCount={100} clientHeight={320} scrollTop={1000} />)
    fireEvent.scroll(container.firstElementChild as HTMLElement)
    expect(screen.getByTestId('range').textContent).toBe('25:47:800:3200')
  })

  it('clamps the window when the list shrinks below the scroll offset', () => {
    const { container } = render(<Harness rowCount={3} clientHeight={320} scrollTop={1000} />)
    fireEvent.scroll(container.firstElementChild as HTMLElement)
    expect(screen.getByTestId('range').textContent).toBe('2:3:64:96')
  })
})
