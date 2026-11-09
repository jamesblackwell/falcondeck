import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageReport } from '@falcondeck/client-core';
import { StoragePanel } from './StoragePanel';
const api = vi.hoisted(() => ({ report: vi.fn(), cleanup: vi.fn(), variant: vi.fn(), updatePreferences: vi.fn() }));
vi.mock('@falcondeck/client-core', async importOriginal => ({ ...await importOriginal<object>(), storageClient: () => api }));
const report: StorageReport = {
  generated_at: 1_794_215_998, free_bytes: 12 * 2 ** 30,
  categories: { total: 100 * 2 ** 30, variants: 70 * 2 ** 30, codex_databases: 13 * 2 ** 30 },
  projects: { '/project': 70 * 2 ** 30 },
  preferences: { scheduled: true, clear_caches: true, reclaim_checkouts: true, delete_old_artifacts: false, delete_old_experiments: false, warnings: true },
  candidates: [{ path: '/artifacts/old', category: 'artifacts', bytes: 1, blocked: null }], runs: [],
  variants: [
    { workspace_id: 'w', thread_id: 'clean', title: 'Clean task', project: '/project', path: '/variants/clean', bytes: 20 * 2 ** 30, cache_bytes: 2 ** 30, idle_days: 20, archived: false, status: 'clean', blocked: null },
    { workspace_id: 'w', thread_id: 'dirty', title: 'Dirty task', project: '/project', path: '/variants/dirty', bytes: 10 * 2 ** 30, cache_bytes: 2 ** 30, idle_days: 40, archived: false, status: 'dirty', blocked: 'Uncommitted changes' },
    { workspace_id: 'w', thread_id: 'busy', title: 'Running task', project: '/project', path: '/variants/busy', bytes: 2 ** 30, cache_bytes: 1, idle_days: 0, archived: false, status: 'running', blocked: 'Running or queued task' },
  ],
};
beforeEach(() => { vi.clearAllMocks(); api.report.mockResolvedValue(report); api.cleanup.mockResolvedValue({ entries: ['No eligible files.'] }); api.variant.mockResolvedValue({ entries: ['Removed'] }); api.updatePreferences.mockImplementation(async p => p); });
describe('Storage settings', () => {
  it('shows categories, projects, task ages and aged candidates', async () => {
    render(<StoragePanel baseUrl="http://daemon" />);
    expect(await screen.findByText('Codex databases (report only)')).toBeInTheDocument();
    expect(screen.getByText('100.00 GiB')).toBeInTheDocument();
    expect(screen.getByText('/artifacts/old')).toBeInTheDocument();
    expect(screen.getByText(/20 days idle/)).toBeInTheDocument();
  });
  it('offers dirty and running tasks only an open action', async () => {
    const open = vi.fn(); render(<StoragePanel baseUrl="http://daemon" onOpenThread={open} />);
    const dirty = (await screen.findByText('Dirty task')).closest('[data-settings-anchor]')!;
    expect(within(dirty as HTMLElement).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(dirty as HTMLElement).getByRole('button', { name: 'Open task' }));
    expect(open).toHaveBeenCalledWith('w', 'dirty');
    const busy = screen.getByText('Running task').closest('[data-settings-anchor]')!;
    expect(within(busy as HTMLElement).getAllByRole('button')).toHaveLength(1);
  });
  it('requires confirmation for cleanup and per-row cache removal', async () => {
    render(<StoragePanel baseUrl="http://daemon" />); await screen.findByText('Clean task');
    fireEvent.click(screen.getByRole('button', { name: 'Clean up now' })); expect(api.cleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(api.cleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear caches' })); expect(api.variant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.variant).toHaveBeenCalledWith(report.variants[0], 'clear_caches'));
  });
  it('requires confirmation before enabling aged artifact deletion', async () => {
    render(<StoragePanel baseUrl="http://daemon" />); await screen.findByText('Clean task');
    fireEvent.click(screen.getByRole('switch', { name: 'Delete artifacts unmodified for 30 days' }));
    expect(api.updatePreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ ...report.preferences, delete_old_artifacts: true }));
  });
  it('shows inventory failures without enabling deletion', async () => {
    api.report.mockRejectedValue(new Error('Cannot inspect checkout'));
    render(<StoragePanel baseUrl="http://daemon" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot inspect checkout');
    expect(screen.queryByRole('button', { name: 'Reclaim' })).not.toBeInTheDocument();
  });
});
