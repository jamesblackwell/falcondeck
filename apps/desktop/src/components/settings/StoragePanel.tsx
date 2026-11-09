import { useCallback, useEffect, useMemo, useState } from 'react';
import { storageClient, type StoragePreferences, type StorageReport } from '@falcondeck/client-core';
import { Button, SettingsPage, SettingsPageHeader, SettingsSection, SettingList, SettingRow, SwitchRow } from '@falcondeck/ui';

export const gib = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`;
const labels: Record<string, string> = { variants: 'Variants (including caches)', variant_caches: 'Variant build caches', variant_checkout_contents: 'Variant checkout contents', artifacts: 'Artifacts', experiments: 'Experiments', codex_databases: 'Codex databases (report only)', logs: 'Logs', other: 'Other workspace data', total: 'Total' };
const switches: [keyof StoragePreferences, string][] = [
  ['scheduled', 'Daily cleanup'], ['clear_caches', 'Clear caches after 3 idle days'],
  ['reclaim_checkouts', 'Reclaim clean archived or 14-day idle checkouts'],
  ['delete_old_artifacts', 'Delete artifacts unmodified for 30 days'],
  ['delete_old_experiments', 'Delete experiments unmodified for 30 days'], ['warnings', 'Low-disk warnings'],
];
export function StoragePanel({ baseUrl, onOpenThread }: { baseUrl: string | null; onOpenThread?: (workspace: string, thread: string) => void }) {
  const api = useMemo(() => baseUrl ? storageClient(baseUrl) : null, [baseUrl]);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ description: string; run: () => Promise<unknown> } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const refresh = useCallback(async () => { if (!api) return; setBusy(true); setError(null); try { setReport(await api.report()); } catch (e) { setError(String(e)); } finally { setBusy(false); } }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const change = async (key: keyof StoragePreferences, value: boolean) => {
    if (!api || !report) return;
    const save = async () => { const p = await api.updatePreferences({ ...report.preferences, [key]: value }); setReport(r => r ? { ...r, preferences: p } : r); };
    if (value && (key === 'delete_old_artifacts' || key === 'delete_old_experiments')) setConfirm({ description: 'Enable automatic deletion of these 30-day-old candidates? Files are permanently removed.', run: save });
    else { setBusy(true); try { await save(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
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
      <SettingsSection title="Disk usage"><p>{report.free_bytes === null ? 'Available space unknown' : `${gib(report.free_bytes)} available`}. Measured {new Date(report.generated_at * 1000).toLocaleString()}.</p><p className="text-sm text-fg-muted">Allocated size can count APFS shared extents more than once; recovered free space may be smaller.</p><SettingList>{Object.entries(report.categories).map(([name, bytes]) => <SettingRow key={name} title={labels[name] ?? name} control={<span>{gib(bytes)}</span>} />)}</SettingList></SettingsSection>
      <SettingsSection title="Projects"><SettingList>{Object.entries(report.projects).map(([name, bytes]) => <SettingRow key={name} title={name} control={<span>{gib(bytes)}</span>} />)}</SettingList></SettingsSection>
      <SettingsSection title="Cleanup policy"><SettingList>{switches.map(([key, label]) => <SwitchRow key={key} title={label} checked={report.preferences[key]} disabled={busy} onCheckedChange={v => void change(key, v)} />)}</SettingList></SettingsSection>
      <SettingsSection title="Largest variants"><SettingList>{report.variants.map(v => <SettingRow key={`${v.workspace_id}/${v.thread_id}`} title={v.title || v.thread_id} description={`${v.project} · ${v.idle_days} days idle · ${v.status}${v.archived ? ' · archived' : ''} · ${gib(v.bytes)} (${gib(v.cache_bytes)} caches)${v.blocked ? ` · ${v.blocked}` : ''}`} control={
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!onOpenThread} onClick={() => onOpenThread?.(v.workspace_id, v.thread_id)}>Open task</Button>{v.status === 'clean' && !v.blocked && <><Button size="sm" disabled={busy || !v.cache_bytes} onClick={() => setConfirm({ description: `Clear ignored build caches for “${v.title}”? They will need rebuilding.`, run: async () => { const r = await api!.variant(v, 'clear_caches'); setResult(r.entries.join('\n')); } })}>Clear caches</Button><Button size="sm" disabled={busy} onClick={() => setConfirm({ description: `Reclaim the checkout for “${v.title}”? Its task, branch and sparse recipe will be kept for restore.`, run: async () => { const r = await api!.variant(v, 'reclaim'); setResult(r.entries.join('\n')); } })}>Reclaim</Button></>}</div>} />)}</SettingList></SettingsSection>
      <SettingsSection title="30-day candidates"><p>Automatic deletion is off by default. Git repositories are retained for manual review.</p><SettingList>{report.candidates.map(c => <SettingRow key={c.path} title={c.path} description={`${c.category}${c.blocked ? ` · ${c.blocked}` : ''}`} control={<span>{gib(c.bytes)}</span>} />)}</SettingList>{!report.candidates.length && <p>No aged artifacts or experiments.</p>}</SettingsSection>
      <SettingsSection title="Recent cleanup runs">{report.runs.slice().reverse().map((r, i) => <details key={i}><summary>{new Date(r.started_at * 1000).toLocaleString()} · {r.finished_at ? 'Finished' : 'Interrupted or running'}</summary><pre className="whitespace-pre-wrap text-sm">{r.entries.join('\n') || 'No eligible files.'}</pre></details>)}</SettingsSection>
    </>}
  </SettingsPage>;
}
