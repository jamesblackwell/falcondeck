import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@falcondeck/ui'
import type { OperationalCondition } from '@falcondeck/client-core'
import { RuntimeHealthNotifier } from './RuntimeHealthNotifier'

const condition: OperationalCondition = {
  id: 'condition-memory',
  key: 'runtime-memory-pressure',
  workspace_id: '',
  level: 'warning',
  message: 'FalconDeck and its agent processes are using 1.8 GB.',
  source: 'runtime-health',
  created_at: '2026-08-21T06:00:00Z',
  updated_at: '2026-08-21T06:00:00Z',
}

it('shows one warning toast for a memory-pressure condition version', () => {
  const { rerender } = render(
    <ToastProvider>
      <RuntimeHealthNotifier conditions={[condition]} />
    </ToastProvider>,
  )
  expect(screen.getByText('FalconDeck is using a lot of memory')).toBeInTheDocument()
  expect(screen.getAllByText(condition.message)).toHaveLength(1)

  rerender(
    <ToastProvider>
      <RuntimeHealthNotifier conditions={[condition]} />
    </ToastProvider>,
  )
  expect(screen.getAllByText(condition.message)).toHaveLength(1)
})
