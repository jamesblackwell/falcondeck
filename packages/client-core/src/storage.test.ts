import { describe, expect, it, vi } from 'vitest';
import { storageClient, storageLevel } from './storage';
describe('storage thresholds and API', () => {
  it('uses strict 30 and 15 GiB boundaries', () => {
    expect(storageLevel(null)).toBe('unknown'); expect(storageLevel(30 * 2 ** 30)).toBe('normal');
    expect(storageLevel(30 * 2 ** 30 - 1)).toBe('low'); expect(storageLevel(15 * 2 ** 30)).toBe('low');
    expect(storageLevel(15 * 2 ** 30 - 1)).toBe('critical');
  });
  it('confirms policy cleanup explicitly over the local API', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) }); vi.stubGlobal('fetch', fetch);
    try { await storageClient('http://daemon').cleanup(); expect(fetch).toHaveBeenCalledWith('http://daemon/api/storage/cleanup', expect.objectContaining({ method: 'POST', body: '{"confirmed":true}' })); } finally { vi.unstubAllGlobals(); }
  });
  it('sends only explicitly selected snapshot targets with confirmation',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({entries:[]})});vi.stubGlobal('fetch',fetch);
    try {await storageClient('http://daemon').snapshots([{workspace_id:'w',thread_id:'t'}]);expect(fetch).toHaveBeenCalledWith('http://daemon/api/storage/snapshots',expect.objectContaining({method:'POST',body:JSON.stringify({targets:[{workspace_id:'w',thread_id:'t'}],confirmed:true})}));}finally{vi.unstubAllGlobals();}
  });

});
