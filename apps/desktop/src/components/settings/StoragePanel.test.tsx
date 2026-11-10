import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageReport } from '@falcondeck/client-core';
import { StoragePanel } from './StoragePanel';
const api = vi.hoisted(() => ({ report: vi.fn(), cleanup: vi.fn(), variant: vi.fn(), snapshots: vi.fn(), updatePreferences: vi.fn() }));
vi.mock('@falcondeck/client-core', async importOriginal => ({ ...await importOriginal<object>(), storageClient: () => api }));
const report: StorageReport = {
  generated_at: 1_794_215_998, free_bytes: 12 * 2 ** 30,
  categories: { total: 100 * 2 ** 30, variants: 70 * 2 ** 30, codex_databases: 13 * 2 ** 30 },
  projects: { '/project': 70 * 2 ** 30 },
  preferences: { scheduled: true, clear_caches: true, reclaim_checkouts: true, warnings: true },
  candidates: [{ path: '/artifacts/old', category: 'artifacts', bytes: 1, blocked: null }], runs: [],
  variants: [
    { workspace_id: 'w', thread_id: 'clean', title: 'Clean task', project: '/project', path: '/variants/clean', bytes: 20 * 2 ** 30, cache_bytes: 2 ** 30, idle_days: 20, archived: false, status: 'clean', cache_blocked: null, snapshot_blocked: 'Clean', blocked: null },
    { workspace_id: 'w', thread_id: 'dirty', title: 'Dirty task', project: '/project', path: '/variants/dirty', bytes: 10 * 2 ** 30, cache_bytes: 2 ** 30, idle_days: 40, archived: false, status: 'dirty', cache_blocked: null, snapshot_blocked: null, blocked: 'Uncommitted changes' },
    { workspace_id: 'w', thread_id: 'busy', title: 'Running task', project: '/project', path: '/variants/busy', bytes: 2 ** 30, cache_bytes: 1, idle_days: 0, archived: false, status: 'running', cache_blocked: 'Running', snapshot_blocked: 'Running', blocked: 'Running or queued task' },
  ],
};
beforeEach(() => { vi.clearAllMocks(); api.report.mockResolvedValue(report); api.cleanup.mockResolvedValue({ entries: ['No eligible files.'] }); api.variant.mockResolvedValue({ entries: ['Removed'] }); api.snapshots.mockResolvedValue({ entries: ['Snapshotted'] }); api.updatePreferences.mockImplementation(async p => p); });
describe('Storage settings', () => {
  it('shows categories, projects, task ages and aged candidates', async () => {
    render(<StoragePanel baseUrl="http://daemon" />);
    expect(await screen.findByText('Codex databases (report only)')).toBeInTheDocument();
    expect(screen.getByText('100.00 GiB')).toBeInTheDocument();
    expect(screen.getByText('/artifacts/old')).toBeInTheDocument();
    expect(screen.getByText(/20 days idle/)).toBeInTheDocument();
  });
  it('offers dirty tasks safe cache cleanup and protects running tasks', async () => {
    const open = vi.fn(); render(<StoragePanel baseUrl="http://daemon" onOpenThread={open} />);
    const dirty = (await screen.findAllByText('Dirty task'))[0].closest('[data-settings-anchor]')!;
    expect(within(dirty as HTMLElement).getByRole('button', {name: 'Clear caches'})).toBeInTheDocument(); expect(within(dirty as HTMLElement).queryByRole('button', {name: 'Reclaim'})).not.toBeInTheDocument();
    fireEvent.click(within(dirty as HTMLElement).getByRole('button', { name: 'Open task' }));
    expect(open).toHaveBeenCalledWith('w', 'dirty');
    const busy = screen.getByText('Running task').closest('[data-settings-anchor]')!;
    expect(within(busy as HTMLElement).getAllByRole('button')).toHaveLength(1);
  });
  it('requires confirmation for cleanup and per-row cache removal', async () => {
    render(<StoragePanel baseUrl="http://daemon" />); await screen.findByText('Clean task');
    fireEvent.click(screen.getByRole('button', { name: 'Clean up now' })); expect(api.cleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(api.cleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear caches' })[0]); expect(api.variant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.variant).toHaveBeenCalledWith(report.variants[0], 'clear_caches'));
  });
  it('requires explicit selection and confirmation for bulk dirty snapshots', async () => {
    render(<StoragePanel baseUrl="http://daemon" />); await screen.findByText('Clean task');
    const action=screen.getByRole('button',{name:'Snapshot and reclaim selected (0)'});
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:'Select Dirty task for snapshot'}));
    fireEvent.click(screen.getByRole('button',{name:'Snapshot and reclaim selected (1)'}));
    expect(api.snapshots).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
    await waitFor(()=>expect(api.snapshots).toHaveBeenCalledWith([{workspace_id:'w',thread_id:'dirty'}]));
  });
  it('keeps artifacts and experiments candidate-only', async () => {
    render(<StoragePanel baseUrl="http://daemon" />); await screen.findByText('Clean task');
    expect(screen.queryByRole('switch',{name:/Delete artifacts/})).not.toBeInTheDocument();
    expect(screen.queryByRole('switch',{name:/Delete experiments/})).not.toBeInTheDocument();
    expect(screen.getByText('Candidates for manual review only. Artifacts and experiments are never automatically deleted.')).toBeInTheDocument();
  });
  it('confirms the one-click eligible snapshot action with count and size', async()=>{
    render(<StoragePanel baseUrl="http://daemon" />);await screen.findByText('Clean task');
    fireEvent.click(screen.getByRole('button',{name:'Snapshot and reclaim eligible (1 · 10.00 GiB)'}));
    expect(api.snapshots).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
    await waitFor(()=>expect(api.snapshots).toHaveBeenCalledWith([{workspace_id:'w',thread_id:'dirty'}]));
  });
  it('attributes free space to volumes and groups vendor-only deletions',async()=>{
    api.report.mockResolvedValue({...report,volumes:[{id:'internal',path:'/internal',free_bytes:40*2**30},{id:'ssd',path:'/Volumes/SSD',free_bytes:2*2**30}],variants:report.variants.map(v=>({...v,vendor_deletions_only:v.thread_id==='dirty'}))});
    render(<StoragePanel baseUrl="http://daemon" />);await screen.findByText('/Volumes/SSD');
    expect(screen.getByText('2.00 GiB available')).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:'Tracked vendor deletions'})).toBeInTheDocument();
    expect(screen.getByText(/1 checkouts · 10\.00 GiB/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox',{name:'Select Dirty task for snapshot'})).toBeInTheDocument();
  });
  it('batches confirmed eligible snapshots and retains completed batch results on failure', async()=>{
    const variants = Array.from({length:101},(_,i)=>({...report.variants[1],thread_id:`dirty-${i}`,title:`Dirty ${i}`,path:`/variants/dirty-${i}`}));
    api.report.mockResolvedValue({...report,variants});
    api.snapshots.mockResolvedValueOnce({entries:['First 100 quarantined']}).mockRejectedValueOnce(new Error('Last batch failed'));
    render(<StoragePanel baseUrl="http://daemon" />);
    await screen.findByRole('button',{name:/Snapshot and reclaim eligible \(101/});
    fireEvent.click(screen.getByRole('button',{name:/Snapshot and reclaim eligible \(101/}));
    expect(api.snapshots).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
    await waitFor(()=>expect(api.snapshots).toHaveBeenCalledTimes(2));
    expect(api.snapshots.mock.calls.map(c=>c[0].length)).toEqual([100,1]);
    expect(screen.getByText('First 100 quarantined')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Last batch failed');
  });
  it('shows private retained files without promising a purge deadline', async () => {
    api.report.mockResolvedValue({...report,quarantines:[{project:'/project',original:'/variants/old',path:'/variants/old.private',bytes:4096,release_after:1,phase:'private_preserved'}]});
    render(<StoragePanel baseUrl="http://daemon" />);
    expect(await screen.findByText('Private files kept for restore · /variants/old.private')).toBeInTheDocument();
    expect(screen.queryByText(/earliest purge/)).not.toBeInTheDocument();
  });
  it('shows inventory failures without enabling deletion', async () => {
    api.report.mockRejectedValue(new Error('Cannot inspect checkout'));
    render(<StoragePanel baseUrl="http://daemon" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot inspect checkout');
    expect(screen.queryByRole('button', { name: 'Reclaim' })).not.toBeInTheDocument();
  });
});
