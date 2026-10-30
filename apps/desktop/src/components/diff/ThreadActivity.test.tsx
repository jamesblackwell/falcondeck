import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsThreadActivity, BotProfile, ThreadSummary } from '@falcondeck/client-core'
import { InfoView } from './InfoView'
import type { ThreadActivityContext } from './ThreadActivity'

const NOW = Date.now()
const at = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString()
const task = (id: string, overrides: Partial<ThreadSummary> = {}) => ({
  id, title: id, workspace_id: 'project', status: 'idle', updated_at: at(0),
  origin: null, variant: null, ...overrides,
}) as ThreadSummary
const selected = task('Juno home')
const iris = task('Iris home', { workspace_id: 'marketing' })
const bots = [{ id: 'iris', thread_id: iris.id, workspace_id: iris.workspace_id, name: 'Iris', icon: { shape: 'star', color: 'cat-2' } }] as BotProfile[]
const child = (id: string, hours = 1) => task(id, {
  workspace_id: 'another-project', status: 'running',
  origin: { kind: 'agent_spawn', parent_thread_id: selected.id, dispatched_at: at(hours) },
})
const data = (overrides: Partial<AnalyticsThreadActivity> = {}): AnalyticsThreadActivity => ({ messages: [], dispatches: [], analytics_enabled: true, ...overrides })
const messages = [
  { at: at(1), from: iris.id, to: selected.id, delivery: 'steer', excerpt: 'Campaign ready for review' },
  { at: at(2), from: selected.id, to: 'Research', delivery: 'queue', excerpt: 'Please verify the figures' },
]

function panel(thread: ThreadSummary, context: ThreadActivityContext) {
  return <InfoView info={{ workspacePath: null, workspaceKind: 'casual', hostName: null, thread, activity: context }} entries={[]} branch={null} isLoading={false} error={null} onSelectChangedFile={vi.fn()} onViewAllChanges={vi.fn()} />
}

function setup(response = data(), threads = [selected, iris], thread = selected) {
  const context: ThreadActivityContext = { threads, bots, loadMessages: vi.fn().mockResolvedValue(response), onSelectThread: vi.fn() }
  const view = render(panel(thread, context))
  return { ...view, context }
}

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Info activity', () => {
  it('shows newest dispatches across projects and both message directions, and navigates', async () => {
    const { context } = setup(data({ messages }), [selected, iris, task('Research'), child('Older', 3), child('Newest')])
    const dispatches = screen.getByRole('region', { name: 'Dispatched' })
    expect(within(dispatches).getAllByRole('button').map((row) => row.textContent)).toEqual(['Newest1h ago', 'Older3h ago'])
    expect(within(dispatches).getAllByRole('img', { name: 'running' })).toHaveLength(2)
    fireEvent.click(within(dispatches).getByRole('button', { name: /Newest/ }))
    expect(context.onSelectThread).toHaveBeenCalledWith('another-project', 'Newest')
    const inbound = await screen.findByRole('button', { name: 'From Iris: Campaign ready for review' })
    expect(inbound.querySelector('svg polygon')).toBeInTheDocument()
    fireEvent.click(inbound)
    expect(context.onSelectThread).toHaveBeenCalledWith('marketing', iris.id)
    fireEvent.click(screen.getByRole('button', { name: 'To Research: Please verify the figures' }))
    expect(context.onSelectThread).toHaveBeenCalledWith('project', 'Research')
    expect(screen.getByText('steer')).toBeInTheDocument()
    expect(screen.getByText('queue')).toBeInTheDocument()
    const rows = within(screen.getByRole('region', { name: 'Messages' })).getAllByRole('button')
    expect(rows[0]).toBe(inbound)
    expect(within(inbound).getByText('Campaign ready for review')).toHaveClass('truncate', 'text-fg-muted')
  })

  it('links a dispatched task back to its parent by bot name', async () => {
    const thread = task('Child', { origin: { kind: 'agent_spawn', parent_thread_id: iris.id } })
    const { context } = setup(data(), [thread, iris], thread)
    fireEvent.click(screen.getByRole('button', { name: 'Dispatched by Iris' }))
    expect(context.onSelectThread).toHaveBeenCalledWith('marketing', iris.id)
    await waitFor(() => expect(context.loadMessages).toHaveBeenCalledWith(thread.id))
  })

  it('uses delegation timestamps for legacy origins, never last-updated times', async () => {
    const legacy = child('Legacy')
    legacy.origin = { kind: 'agent_spawn', parent_thread_id: selected.id }
    setup(data({ dispatches: [{ thread_id: legacy.id, at: at(2) }] }), [selected, legacy, child('Old but active', 49), child('Future', -1), { ...legacy, id: 'Unknown age' }])
    expect(await screen.findByText('Legacy')).toBeInTheDocument()
    expect(screen.queryByText('Old but active')).not.toBeInTheDocument()
    expect(screen.queryByText('Future')).not.toBeInTheDocument()
    expect(screen.queryByText('Unknown age')).not.toBeInTheDocument()
  })

  it('hides empty activity sections', async () => {
    const { context } = setup()
    await waitFor(() => expect(context.loadMessages).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Dispatched' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Messages' })).not.toBeInTheDocument()
  })

  it('shows the analytics-off hint while keeping dispatches available', async () => {
    setup(data({ analytics_enabled: false, messages }), [selected, child('Worker')])
    expect(await screen.findByText('Enable analytics in Settings to see agent messages.')).toBeInTheDocument()
    expect(screen.getByText('Worker')).toBeInTheDocument()
    expect(screen.queryByText('Campaign ready for review')).not.toBeInTheDocument()
  })

  it('caps and expands each list independently', async () => {
    setup(data({ messages: Array.from({ length: 9 }, (_, i) => ({ ...messages[0]!, excerpt: `Message ${i}` })) }), [selected, iris, ...Array.from({ length: 9 }, (_, i) => child(`Child ${i}`, i + 1))])
    const dispatches = screen.getByRole('region', { name: 'Dispatched' })
    expect(screen.queryByText('Child 8')).not.toBeInTheDocument()
    fireEvent.click(within(dispatches).getByRole('button', { name: 'Show all' }))
    expect(screen.getByText('Child 8')).toBeInTheDocument()
    const section = await screen.findByRole('region', { name: 'Messages' })
    expect(screen.queryByText('Message 8')).not.toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: 'Show all' }))
    expect(screen.getByText('Message 8')).toBeInTheDocument()
    fireEvent.click(within(dispatches).getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText('Child 8')).not.toBeInTheDocument()
  })

  it('coalesces updates, does not poll unchanged tasks, and refreshes on selection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { context, rerender } = setup()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(context.loadMessages).toHaveBeenCalledTimes(1)
    rerender(panel({ ...selected, updated_at: at(-1) }, context))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    rerender(panel({ ...selected, updated_at: at(-2) }, context))
    await act(() => vi.advanceTimersByTimeAsync(3999))
    expect(context.loadMessages).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(context.loadMessages).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(context.loadMessages).toHaveBeenCalledTimes(2)
    rerender(panel(iris, context))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(context.loadMessages).toHaveBeenLastCalledWith(iris.id)
    expect(context.loadMessages).toHaveBeenCalledTimes(3)
  })

  it('disables unavailable counterparts and reports a failed local query', async () => {
    const { context, rerender } = setup(data({ messages: [{ ...messages[0]!, from: 'Deleted task' }] }))
    expect(await screen.findByRole('button', { name: /From Deleted task/ })).toBeDisabled()
    rerender(panel(iris, { ...context, loadMessages: vi.fn().mockRejectedValue(new Error('offline')) }))
    expect(await screen.findByText('Could not load messages.')).toBeInTheDocument()
  })
})
