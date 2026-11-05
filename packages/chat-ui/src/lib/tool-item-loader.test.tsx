import { renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { normalizeConversationItem, type ConversationItem } from '@falcondeck/client-core'
import { ToolItemLoaderContext, useToolItem } from './tool-item-loader'

it('does not refetch full evidence for every growing child update', async () => {
  const source = normalizeConversationItem({ kind: 'tool_call', id: 'p', title: 'Agent: Example', tool_kind: 'Agent', status: 'running', output: 'Sub-agent activity', display: { output_total_bytes: 10_000 }, detail: { kind: 'dynamic', namespace: 'claude', tool: 'Agent', arguments: null }, created_at: '2026-11-05T12:00:00Z' }) as Extract<ConversationItem, { kind: 'tool_call' }>
  const loader = vi.fn().mockResolvedValue({ ...source, display: { ...source.display, output_total_bytes: null } })
  const wrapper = ({ children }: { children: ReactNode }) => <ToolItemLoaderContext.Provider value={loader}>{children}</ToolItemLoaderContext.Provider>
  const { result, rerender } = renderHook(({ item }) => useToolItem(item, true), { initialProps: { item: source }, wrapper })
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(1))
  for (let index = 0; index < 50; index++) rerender({ item: { ...source, display: { ...source.display, output_total_bytes: 20_000 + index } } })
  expect(loader).toHaveBeenCalledTimes(1)
  rerender({ item: { ...source, status: 'completed', completed_at: '2026-11-05T12:00:01Z' } })
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.status).toBe('ready'))
  rerender({ item: { ...source, status: 'completed', output: 'Final report', display: { ...source.display, output_total_bytes: null } } })
  await waitFor(() => expect(result.current.item.output).toBe('Final report'))
  expect(result.current.status).toBe('idle')
})
