import { useCallback, useEffect, useMemo, useState } from 'react';
import { storageClient, type StoragePreferences, type StorageReport } from '@falcondeck/client-core';
import { Button, SettingsPage, SettingsPageHeader, SettingsSection, SettingList, SettingRow, SwitchRow } from '@falcondeck/ui';

export const gib = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`;
const labels: Record<string, string> = { variants: 'Variants (including caches)', variant_caches: 'Variant build caches', variant_checkout_contents: 'Variant checkout contents', artifacts: 'Artifacts', experiments: 'Experiments', codex_databases: 'Codex databases (report only)', logs: 'Logs', quarantined: 'Quarantined (included in variants)', other: 'Other workspace data', total: 'Total' };
const switches: [keyof StoragePreferences, string][] = [
  ['scheduled', 'Daily cleanup'], ['clear_caches', 'Clear caches after 3 idle days'],
  ['reclaim_checkouts', 'Reclaim clean checkouts after 24 idle hours'],
 ['warnings', 'Low-disk warnings'],
];
export function StoragePanel({ baseUrl, onOpenThread }: { baseUrl: string | null; onOpenThread?: (workspace: string, thread: string) => void }) {
  const api = useMemo(() => baseUrl ? storageClient(baseUrl) : null, [baseUrl]);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ description: string; run: () => Promise<unknown> } | null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const refresh = useCallback(async () => { if (!api) return; setBusy(true); setError(null); try { setReport(await api.report()); setSelected(new Set()); } catch (e) { setError(String(e)); } finally { setBusy(false); } }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const snapshotTargets = async (targets: StorageReport['variants']) => {
    const entries: string[] = [];
    for (let i = 0; i < targets.length; i += 100) {
      const r = await api!.snapshots(targets.slice(i, i + 100).map(v => ({ workspace_id: v.workspace_id, thread_id: v.thread_id })));
      entries.push(...r.entries);
      setResult(entries.join('\n'));
    }
  };
  const change = async (key: keyof StoragePreferences, value: boolean) => {
    if (!api || !report) return;
    const save = async () => { const p = await api.updatePreferences({ ...report.preferences, [key]: value }); setReport(r => r ? { ...r, preferences: p } : r); };
    { setBusy(true); try { await save(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  };
  return <SettingsPage>
    <SettingsPageHeader title="Storage" description="Review disk use and clean up retained task workspaces." />
    <div className="flex gap-2"><Button disabled={busy || !api} onClick={() => void refresh()}>Refresh</Button><Button disabled={busy || !api || !report} onClick={() => setConfirm({ description: 'Run the scheduled cleanup policy now? Eligible caches and checkouts will be removed. Branches and task history stay available.', run: async () => { const r = await api!.cleanup(); setResult(r.entries.join('\n') || 'No eligible files to remove.'); } })}>Clean up now</Button></div>
    {!api && <p>Connect to the local daemon to inspect storage.</p>}
    {busy && <p role="status">Checking storage…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <pre className="whitespace-pre-wrap text-sm" role="status">{result}</pre>}
    {confirm && <div role="group" aria-label="Confirm storage cleanup" className="rounded-lg border border-border p-4">
      <p>{confirm.description}</p><div className="mt-3 flex gap-2"><Button disabled={busy} onClick={() => { setBusy(true); void confirm.run().then(async () => { setConfirm(null); await refresh(); }).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>Confirm</Button><Button disabled={busy} variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></div>
    </div>}
    {report && <>
      <SettingsSection title="Volumes"><SettingList>{(report.volumes ?? []).map(v=><SettingRow key={v.id} title={v.path} description={v.id} control={<span>{v.free_bytes===null?'Unavailable':`${gib(v.free_bytes)} available`}</span>}/>)}</SettingList></SettingsSection>
      <SettingsSection title="Disk usage"><p>App data volume: {report.free_bytes === null ? 'Available space unknown' : `${gib(report.free_bytes)} available`}. Measured {new Date(report.generated_at * 1000).toLocaleString()}.</p><p className="text-sm text-fg-muted">Allocated size can count APFS shared extents more than once; recovered free space may be smaller.</p><SettingList>{Object.entries(report.categories).map(([name, bytes]) => <SettingRow key={name} title={labels[name] ?? name} control={<span>{gib(bytes)}</span>} />)}</SettingList></SettingsSection>
      <SettingsSection title="Projects"><SettingList>{Object.entries(report.projects).map(([name, bytes]) => <SettingRow key={name} title={name} control={<span>{gib(bytes)}</span>} />)}</SettingList></SettingsSection>
      <SettingsSection title="Cleanup policy"><SettingList>{switches.map(([key, label]) => <SwitchRow key={key} title={label} checked={report.preferences[key]} disabled={busy} onCheckedChange={v => void change(key, v)} />)}</SettingList></SettingsSection>
      <SettingsSection title="Largest variants"><SettingList>{report.variants.map(v => <SettingRow key={`${v.workspace_id}/${v.thread_id}`} title={v.title || v.thread_id} description={`${v.project} · ${v.idle_days} days idle · ${v.status}${v.archived ? ' · archived' : ''} · ${gib(v.bytes)} (${gib(v.cache_bytes)} cache candidates)${v.blocked ? ` · ${v.blocked}` : ''}`} control={
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!onOpenThread} onClick={() => onOpenThread?.(v.workspace_id, v.thread_id)}>Open task</Button>{v.status !== 'running' && !v.cache_blocked && <Button size="sm" disabled={busy || !v.cache_bytes} onClick={() => setConfirm({ description: `Clear proven rebuildable cache files for “${v.title}”? Unverified files stay recoverable; dependencies need reinstalling.`, run: async () => { const r = await api!.variant(v, 'clear_caches'); setResult(r.entries.join('\n')); } })}>Clear caches</Button>}{v.status === 'clean' && !v.blocked && <Button size="sm" disabled={busy} onClick={() => setConfirm({ description: `Reclaim the checkout for “${v.title}”? Its task, branch and sparse recipe will be kept for restore.`, run: async () => { const r = await api!.variant(v, 'reclaim'); setResult(r.entries.join('\n')); } })}>Reclaim</Button>}</div>} />)}</SettingList></SettingsSection>
      <SettingsSection title="Snapshot and reclaim dirty variants">
        <p>Manual only. Checkouts must be idle for more than 7 days. A verified Git snapshot preserves staged and working changes. Unique ignored files are kept privately, outside Git. Quarantine retains the original checkout for 24 hours before removal.</p>
        <Button disabled={busy || !report.variants.some(v=>v.status==='dirty' && !v.snapshot_blocked)} onClick={()=>{
          const targets=report.variants.filter(v=>v.status==='dirty' && !v.snapshot_blocked);
          setConfirm({description:`Snapshot and reclaim ${targets.length} eligible dirty checkouts (${gib(targets.reduce((s,v)=>s+v.bytes,0))})? Original checkouts remain recoverable during the 24-hour quarantine.`,run:async()=>{await snapshotTargets(targets);}});
        }}>Snapshot and reclaim eligible ({report.variants.filter(v=>v.status==='dirty' && !v.snapshot_blocked).length} · {gib(report.variants.filter(v=>v.status==='dirty' && !v.snapshot_blocked).reduce((s,v)=>s+v.bytes,0))})</Button>
        <Button disabled={busy || selected.size===0} onClick={() => {
          const targets=report.variants.filter(v=>selected.has(v.path));
          setConfirm({description:`Snapshot and reclaim ${targets.length} dirty checkouts (${gib(targets.reduce((s,v)=>s+v.bytes,0))})? Each verified snapshot and original index are kept; removal follows a 24-hour quarantine.`,run:async()=>{await snapshotTargets(targets);}});
        }}>Snapshot and reclaim selected ({selected.size})</Button>
        <SettingList>{report.variants.filter(v=>v.status==='dirty' && v.idle_days>=7 && !v.vendor_deletions_only).map(v=><SettingRow key={v.path} title={v.title || v.thread_id} description={`${gib(v.bytes)} · ${v.idle_days} days idle${v.snapshot_blocked ? ` · ${v.snapshot_blocked}` : ''}`} control={<input type="checkbox" className="fd-focus" aria-label={`Select ${v.title || v.thread_id} for snapshot`} disabled={busy || !!v.snapshot_blocked} checked={selected.has(v.path)} onChange={e=>setSelected(previous=>{const next=new Set(previous);if(e.target.checked)next.add(v.path);else next.delete(v.path);return next;})} />}/>)}</SettingList>
      </SettingsSection>
      <SettingsSection title="Tracked vendor deletions">
        <p>{report.variants.filter(v=>v.vendor_deletions_only).length} checkouts · {gib(report.variants.filter(v=>v.vendor_deletions_only).reduce((s,v)=>s+v.bytes,0))}. These remain dirty and require manual snapshot and reclaim.</p>
        <SettingList>{report.variants.filter(v=>v.status==='dirty' && v.vendor_deletions_only).map(v=><SettingRow key={v.path} title={v.title || v.thread_id} description={`${gib(v.bytes)} · ${v.idle_days} days idle${v.snapshot_blocked ? ` · ${v.snapshot_blocked}` : ''}`} control={<input type="checkbox" className="fd-focus" aria-label={`Select ${v.title || v.thread_id} for snapshot`} disabled={busy || !!v.snapshot_blocked} checked={selected.has(v.path)} onChange={e=>setSelected(previous=>{const next=new Set(previous);if(e.target.checked)next.add(v.path);else next.delete(v.path);return next;})} />}/>)}</SettingList>
      </SettingsSection>
      <SettingsSection title="Recoverable quarantine"><p>Original files remain here for at least 24 hours. Private ignored files are kept for restore and are never automatically deleted. Opening the owning task restores its checkout.</p><SettingList>{(report.quarantines??[]).map(q=><SettingRow key={q.path} title={q.original} description={q.phase === 'private_preserved' ? `Private files kept for restore · ${q.path}` : `${q.phase} · ${q.path} · earliest purge ${new Date(q.release_after*1000).toLocaleString()}`} control={<span>{gib(q.bytes)}</span>}/>)}</SettingList></SettingsSection>
      <SettingsSection title="30-day candidates"><p>Candidates for manual review only. Artifacts and experiments are never automatically deleted.</p><SettingList>{report.candidates.map(c => <SettingRow key={c.path} title={c.path} description={`${c.category}${c.blocked ? ` · ${c.blocked}` : ''}`} control={<span>{gib(c.bytes)}</span>} />)}</SettingList>{!report.candidates.length && <p>No aged artifacts or experiments.</p>}</SettingsSection>
      <SettingsSection title="Recent cleanup runs">{report.runs.slice().reverse().map((r, i) => <details key={i}><summary>{new Date(r.started_at * 1000).toLocaleString()} · {r.finished_at ? 'Finished' : 'Interrupted or running'}</summary><pre className="whitespace-pre-wrap text-sm">{r.entries.join('\n') || 'No eligible files.'}</pre></details>)}</SettingsSection>
    </>}
  </SettingsPage>;
}
