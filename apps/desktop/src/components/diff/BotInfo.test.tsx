import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation, BotProfile, ThreadSummary, Ticket } from '@falcondeck/client-core'
import { InfoView } from './InfoView'
import type { BotInfoContext } from './BotInfo'
import type { ThreadActivityContext } from './ThreadActivity'
import { readBotSidebar } from './bot-sidebar-data'

const NOW = Date.now()
const at = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()
const thread = { id: 'home', workspace_id: 'bot-space', title: 'Home', updated_at: at(0), status: 'idle' } as ThreadSummary
const bot = { id: 'juno', name: 'Juno', thread_id: thread.id, workspace_id: thread.workspace_id, icon: { shape: 'diamond', color: 'cat-1' } } as BotProfile
const worker = { ...thread, id: 'worker', workspace_id: 'product', title: 'Ship the feature', origin: { kind: 'agent_spawn', parent_thread_id: thread.id, dispatched_at: at(2) } } as ThreadSummary
const schedule = {
  id: 'daily', revision: 3, name: 'Daily priorities', state: 'enabled',
  target: { thread: { kind: 'existing', thread_id: thread.id } },
  next_run_at: at(-1), resolved_schedule: 'At 09:00 daily (Europe/London)',
} as Automation
const ticket = { id: 'FD-1', owner: bot.name, state: 'active', title: 'Launch the dashboard', priority: 'P1', created_at: at(3) } as Ticket
const conflict = { ok: false, operation: 'automation.pause', error: { code: 'revision_conflict', message: 'Changed elsewhere', retryable: true, field_errors: [] } }

function setup({ content = '# Priorities\n\n**Ship** [the feature](falcondeck://thread/worker)', modified = at(2), docs = ['STATUS.md'], schedules = [schedule], tickets = [ticket], flags = ['rarely_useful'] } = {}) {
  const api: BotInfoContext['api'] = {
    botDocuments: vi.fn().mockResolvedValue(docs),
    readBotDocument: vi.fn().mockResolvedValue({ name: 'STATUS.md', content, version: 'v1', modified_at: modified }),
    listTickets: vi.fn().mockResolvedValue(tickets),
    controlGet: vi.fn().mockImplementation(async (request) => ({ resource: request.resource, data:
      request.resource === 'automations' ? schedules : request.resource === 'automation' ? { ...schedule, revision: 5 } : { automations: [{ id: schedule.id, flags }] },
    })),
    controlExecute: vi.fn().mockResolvedValue({ ok: true, operation: 'automation.pause', data: { ...schedule, state: 'paused', revision: 4 } }),
  }
  const context: BotInfoContext = { api, onOpenTickets: vi.fn(), onOpenAutomation: vi.fn(), onError: vi.fn() }
  const activity: ThreadActivityContext = {
    threads: [thread, worker], bots: [bot], onSelectThread: vi.fn(),
    loadMessages: vi.fn().mockResolvedValue({ analytics_enabled: true, dispatches: [], messages: [{ at: at(1), from: worker.id, to: thread.id, excerpt: 'Ready to ship', delivery: 'steer' }] }),
  }
  const panel = (selected = thread) => <InfoView info={{ workspacePath: '/bots/juno', workspaceKind: 'casual', hostName: null, thread: selected, activity, botInfo: context }} entries={[]} branch={null} isLoading={false} error={null} onSelectChangedFile={vi.fn()} onViewAllChanges={vi.fn()} />
  const view = render(panel())
  return { ...view, api, context, activity, panel }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('Bot Info sidebar', () => {
  it('shows the bot header and ordered sections, renders status markdown and opens task links', async () => {
    const { api, context, activity } = setup()
    expect(await screen.findByRole('heading', { name: 'Priorities' })).toBeInTheDocument()
    await screen.findByText('Ready to ship')
    expect(screen.getByRole('heading', { name: 'Juno' }).previousElementSibling).toHaveAttribute('width', '24')
    expect(screen.getAllByRole('region').map((node) => node.getAttribute('aria-label'))).toEqual(['Status', 'Dispatched', 'Messages', 'Tickets', 'Schedules'])
    expect(screen.getByText('Ship').tagName).toBe('STRONG')
    fireEvent.click(screen.getByRole('link', { name: 'the feature' }))
    expect(activity.onSelectThread).toHaveBeenCalledWith('product', 'worker')
    expect(screen.getByText(/Updated.*ago/)).not.toHaveClass('text-warning')
    expect(api.listTickets).toHaveBeenCalledWith({ owner: 'Juno', include_closed: false })
    fireEvent.click(screen.getByRole('button', { name: 'FD-1: Launch the dashboard' }))
    expect(context.onOpenTickets).toHaveBeenCalledOnce()
    expect(screen.getByText('At 09:00 daily (Europe/London)')).toHaveClass('truncate')
    expect(screen.getByText('rarely useful')).toHaveClass('text-fg-muted')
    expect(screen.getByText(/^Next /)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily priorities' }))
    expect(context.onOpenAutomation).toHaveBeenCalledWith('daily')
    const details = screen.getByText('Details').closest('details')
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByText('Local')).not.toBeVisible()
    fireEvent.click(screen.getByText('Details'))
    expect(screen.getByText('Local')).toBeVisible()
  })

  it('collapses long status, allows expanding it, and flags a stale file', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    setup({ content: Array.from({ length: 25 }, (_, i) => `Line ${i}`).join('\n\n'), modified: at(26) })
    const more = await screen.findByRole('button', { name: 'Show more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Updated 1d ago')).toHaveClass('text-warning', 'bg-warning-muted')
    fireEvent.click(more)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows missing status and hides empty tickets and schedules', async () => {
    const { api } = setup({ docs: [], tickets: [], schedules: [] })
    expect(await screen.findByText('No STATUS.md yet')).toBeInTheDocument()
    expect(api.readBotDocument).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Tickets' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Schedules' })).not.toBeInTheDocument()
  })

  it('excludes closed/unowned tickets and unrelated schedules, includes worker targets', async () => {
    setup({
      tickets: [ticket, { ...ticket, id: 'closed', title: 'Finished', state: 'done' }, { ...ticket, id: 'other', title: 'Another owner', owner: 'Iris' }],
      schedules: [{ ...schedule, id: 'worker-schedule', name: 'Worker check', target: { ...schedule.target, thread: { kind: 'existing', thread_id: worker.id } } }, { ...schedule, id: 'unrelated', name: 'Other bot', target: { ...schedule.target, thread: { kind: 'existing', thread_id: 'iris' } } }],
    })
    expect(await screen.findByText('Worker check')).toBeInTheDocument()
    expect(screen.queryByText('Other bot')).not.toBeInTheDocument()
    expect(screen.queryByText('Finished')).not.toBeInTheDocument()
    expect(screen.queryByText('Another owner')).not.toBeInTheDocument()
  })

  it('pauses with the read revision, without opening the editor, and retries a conflict once', async () => {
    const { api, context } = setup()
    vi.mocked(api.controlExecute).mockResolvedValueOnce(conflict).mockResolvedValueOnce({ ok: true, operation: 'automation.pause', data: { ...schedule, revision: 6, state: 'paused' } })
    const control = await screen.findByRole('switch', { name: 'Daily priorities enabled' })
    fireEvent.click(control)
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'false'))
    expect(api.controlExecute).toHaveBeenNthCalledWith(1, { operation: 'automation.pause', arguments: { automation_id: 'daily' }, expected_revision: 3 })
    expect(api.controlGet).toHaveBeenCalledWith({ resource: 'automation', id: 'daily' })
    expect(api.controlExecute).toHaveBeenNthCalledWith(2, { operation: 'automation.pause', arguments: { automation_id: 'daily' }, expected_revision: 5 })
    expect(context.onOpenAutomation).not.toHaveBeenCalled()
    vi.mocked(api.controlExecute).mockResolvedValueOnce({ ok: true, operation: 'automation.resume', data: { ...schedule, revision: 7 } })
    fireEvent.click(control)
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'true'))
    expect(api.controlExecute).toHaveBeenLastCalledWith({ operation: 'automation.resume', arguments: { automation_id: 'daily' }, expected_revision: 6 })
  })

  it('stops after a second conflict and shows a toast', async () => {
    const { api, context } = setup()
    vi.mocked(api.controlExecute).mockResolvedValue(conflict)
    fireEvent.click(await screen.findByRole('switch', { name: 'Daily priorities enabled' }))
    await waitFor(() => expect(context.onError).toHaveBeenCalledWith('Could not update automation', 'Changed elsewhere'))
    expect(api.controlExecute).toHaveBeenCalledTimes(2)
  })

  it('refreshes status from task updates with no idle polling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { api, panel, rerender } = setup()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(api.readBotDocument).toHaveBeenCalledTimes(1)
    vi.mocked(api.readBotDocument).mockResolvedValue({ name: 'STATUS.md', content: 'Updated priorities', version: 'v2', modified_at: at(0) })
    rerender(panel({ ...thread, updated_at: at(-1) }))
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getByText('Updated priorities')).toBeInTheDocument()
    expect(api.readBotDocument).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(api.readBotDocument).toHaveBeenCalledTimes(2)
  })

  it('loads all schedule pages and requests target thread metadata', async () => {
    const { api } = setup()
    vi.mocked(api.controlGet).mockImplementation(async (request) => ({ resource: request.resource, data: request.resource === 'automations' ? [request.cursor ? { ...schedule, id: 'page2' } : schedule] : { automations: [] }, next_cursor: request.resource === 'automations' && !request.cursor ? 'next' : null }))
    const result = await readBotSidebar(api, bot.id, bot.name)
    expect(result.schedules.map((row) => row.id)).toEqual(['daily', 'page2'])
    expect(api.controlGet).toHaveBeenCalledWith(expect.objectContaining({ resource: 'automations', fields: expect.arrayContaining(['target.thread']), cursor: 'next' }))
  })
})
