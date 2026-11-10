/** Local daemon storage management. Native agent databases are report-only. */
export type StoragePreferences = {
  scheduled: boolean; clear_caches: boolean; reclaim_checkouts: boolean;
  warnings: boolean;
};
export type StorageVolume = { id: string; path: string; free_bytes: number | null };
export type StorageVariant = {
  workspace_id: string; thread_id: string; title: string; project: string; path: string;
  bytes: number; cache_bytes: number; idle_days: number; archived: boolean;
  status: 'clean' | 'dirty' | 'running'; blocked: string | null; cache_blocked: string | null; snapshot_blocked: string | null; vendor_deletions_only?: boolean;
};
export type StorageRun = { id?: string; started_at: number; finished_at: number | null; entries: string[] };
export type StorageReport = {
  generated_at: number; free_bytes: number | null; volumes?: StorageVolume[]; categories: Record<string, number>;
  projects: Record<string, number>; variants: StorageVariant[];
  candidates: { category: string; path: string; bytes: number; blocked: string | null }[];
  quarantines?: {project:string;original:string;path:string;bytes:number;release_after:number;phase:string}[];
  preferences: StoragePreferences; runs: StorageRun[];
};
export type StorageHealth = { free_bytes: number | null; volumes?: StorageVolume[] };
export function storageLevel(bytes: number | null): 'unknown' | 'normal' | 'low' | 'critical' {
  return bytes === null ? 'unknown' : bytes < 15 * 2 ** 30 ? 'critical' : bytes < 30 * 2 ** 30 ? 'low' : 'normal';
}
export function storageClient(baseUrl: string) {
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error((await response.text()) || `Storage request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  return {
    report: () => request<StorageReport>('storage'),
    health: () => request<StorageHealth>('health'),
    preferences: () => request<StoragePreferences>('storage/preferences'),
    updatePreferences: (p: StoragePreferences) => request<StoragePreferences>('storage/preferences', 'PATCH', p),
    snapshots: (targets: {workspace_id:string;thread_id:string}[]) => request<StorageRun>('storage/snapshots','POST',{targets,confirmed:true}),
    cleanup: () => request<StorageRun>('storage/cleanup', 'POST', { confirmed: true }),
    variant: (v: StorageVariant, action: 'clear_caches' | 'reclaim' | 'snapshot_reclaim') => request<StorageRun>('storage/variant', 'POST', { workspace_id: v.workspace_id, thread_id: v.thread_id, action, confirmed: true }),
  };
}
