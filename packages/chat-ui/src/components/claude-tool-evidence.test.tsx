import { ToolItemLoaderContext } from '../lib/tool-item-loader'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ConversationItem } from '@falcondeck/client-core'
import { MessageCard } from './message'

export const claudeAgentFixture: Extract<ConversationItem, { kind: 'tool_call' }> = {
  kind: 'tool_call', id: 'parent', title: 'Agent: Inspect disk usage', tool_kind: 'Agent', status: 'completed',
  output: 'Largest directory: fixtures.', exit_code: null,
  created_at: '2026-11-05T12:00:00Z', completed_at: '2026-11-05T12:00:02Z',
  display: { is_read_only: false, has_side_effect: false, is_error: false, lifecycle: 'succeeded', artifact_kind: 'none', activity_kind: 'other', history_mode: 'full', summary_hint: null },
  detail: { kind: 'dynamic', namespace: 'claude', tool: 'Agent', arguments: { description: 'Inspect disk usage', prompt: 'Find large fixture directories' }, content_items: [], success: true, duration_ms: 2000,
    claude: { result: { totalTokens: 123 }, calls: [{ id: 'child', title: 'du -sk *', tool_kind: 'Bash', status: 'completed', arguments: { command: 'du -sk *', description: 'Measure fixture directories' }, output: '42 fixtures' }] } },
}

it('keeps the parent title and exposes prompt, real child summary and final report on opening', () => {
  render(<MessageCard item={claudeAgentFixture} />)
  expect(screen.queryByText('Final report')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Agent: Inspect disk usage/ }))
  expect(screen.getByText('Final report')).toBeInTheDocument()
  expect(screen.getByText('Largest directory: fixtures.')).toBeInTheDocument()
  expect(screen.getByText(/Find large fixture directories/)).toBeInTheDocument()
  const summary = screen.getByText('Bash: du -sk * · completed')
  expect(summary.tagName).toBe('SUMMARY')
  const child = summary.closest("details")!
  child.open = true
  fireEvent(child, new Event("toggle"))
  expect(screen.getByText('42 fixtures')).toBeInTheDocument()
  expect(screen.getByText(/Measure fixture directories/)).toBeInTheDocument()
  expect(screen.queryByText('code')).not.toBeInTheDocument()
})

it('loads capped desktop/web evidence on expansion and exposes a terminal oversized state', async () => {
  const loader = vi.fn().mockResolvedValue(claudeAgentFixture)
  const truncated = { ...claudeAgentFixture, output: 'Sub-agent activity', display: { ...claudeAgentFixture.display, output_total_bytes: 100_000 },
    detail: { kind: 'dynamic' as const, tool: 'Agent', namespace: 'claude', arguments: null, content_items: [], success: null, duration_ms: null, claude: null } }
  const view = render(<ToolItemLoaderContext.Provider value={loader}><MessageCard item={truncated} /></ToolItemLoaderContext.Provider>)
  expect(loader).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Agent: Inspect disk usage/ }))
  expect(await screen.findByText('Largest directory: fixtures.')).toBeInTheDocument()
  expect(loader).toHaveBeenCalledTimes(1)
  view.unmount()
  loader.mockRejectedValue(new Error('ITEM_TOO_LARGE: Too large to load here'))
  render(<ToolItemLoaderContext.Provider value={loader}><MessageCard item={{ ...truncated, id: 'large' }} defaultOpen /></ToolItemLoaderContext.Provider>)
  expect(await screen.findByText('Too large to load here. Open this tool on the Mac.')).toBeInTheDocument()
  expect(screen.queryByText("Couldn't load tool details. Retry")).not.toBeInTheDocument()
})
