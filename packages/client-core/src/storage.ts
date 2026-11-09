/** Local daemon storage management. Native agent databases are report-only. */
export type StoragePreferences = {
  scheduled: boolean; clear_caches: boolean; reclaim_checkouts: boolean;
  delete_old_artifacts: boolean; delete_old_experiments: boolean; warnings: boolean;
};
export type StorageVariant = {
  workspace_id: string; thread_id: string; title: string; project: string; path: string;
  bytes: number; cache_bytes: number; idle_days: number; archived: boolean;
  status: 'clean' | 'dirty' | 'running'; blocked: string | null;
};
export type StorageRun = { id?: string; started_at: number; finished_at: number | null; entries: string[] };
export type StorageReport = {
  generated_at: number; free_bytes: number | null; categories: Record<string, number>;
  projects: Record<string, number>; variants: StorageVariant[];
  candidates: { category: string; path: string; bytes: number; blocked: string | null }[];
  preferences: StoragePreferences; runs: StorageRun[];
};
export type StorageHealth = { free_bytes: number | null };
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
    cleanup: () => request<StorageRun>('storage/cleanup', 'POST', { confirmed: true }),
    variant: (v: StorageVariant, action: 'clear_caches' | 'reclaim') => request<StorageRun>('storage/variant', 'POST', { workspace_id: v.workspace_id, thread_id: v.thread_id, action, confirmed: true }),
  };
}
