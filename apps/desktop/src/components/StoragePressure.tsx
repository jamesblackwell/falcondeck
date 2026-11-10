import { useEffect, useMemo, useRef, useState } from 'react';
import { storageClient, storageLevel } from '@falcondeck/client-core';
import { Button } from '@falcondeck/ui';
import { sendDesktopAttentionNotification } from '../desktop-notifications';
type Volume = { id: string; path: string; free_bytes: number | null };
export function StoragePressure({ baseUrl, onOpenStorage, onToast }: {
  baseUrl: string | null; onOpenStorage: () => void;
  onToast: (toast: { variant: 'warning'; title: string; description: string; action: { label: string; onClick: () => void } }) => void;
}) {
  const api = useMemo(() => baseUrl ? storageClient(baseUrl) : null, [baseUrl]);
  const [critical, setCritical] = useState<Volume[]>([]);
  const warned = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!api) return;
      try {
        const [h, p] = await Promise.all([api.health(), api.preferences()]);
        if (!active) return;
        if (!p.warnings) { setCritical([]); return; }
        const volumes: Volume[] = h.volumes?.length ? h.volumes : [{ id: 'data', path: 'daemon data', free_bytes: h.free_bytes }];
        for (const v of volumes) {
          const level = storageLevel(v.free_bytes);
          if (level === 'normal') warned.current.delete(v.id);
          if ((level === 'low' || level === 'critical') && !warned.current.has(v.id)) {
            warned.current.add(v.id);
            onToast({ variant: 'warning', title: 'Storage is running low', description: `${((v.free_bytes ?? 0) / 2 ** 30).toFixed(1)} GiB available on ${v.path}.`, action: { label: 'Free up space', onClick: onOpenStorage } });
          }
        }
        const next = volumes.filter(v => storageLevel(v.free_bytes) === 'critical');
        setCritical(previous => [...next, ...previous.filter(old => volumes.some(v => (v.id === old.id || v.path === old.path) && v.free_bytes === null))]);
        if (next.length) {
          // A single daily native claim includes every currently critical volume.
          const day = new Date().toLocaleDateString('en-CA');
          const key = 'falcondeck:storage-critical-day';
          if (localStorage.getItem(key) !== day) {
            localStorage.setItem(key, day);
            void sendDesktopAttentionNotification({ title: 'Critically low disk space', body: next.map(v => `${((v.free_bytes ?? 0) / 2 ** 30).toFixed(1)} GiB available on ${v.path}`).join('\n') });
          }
        }
      } catch { /* Keep the last warning until a successful measurement. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 180_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, onOpenStorage, onToast]);
  return critical.length === 0 ? null : <div role="alert" className="fixed inset-x-6 top-12 z-50 flex items-center justify-between gap-4 rounded-lg border border-danger bg-surface-2 p-3 text-sm"><span>Critically low disk space: {critical.map(v => `${((v.free_bytes ?? 0) / 2 ** 30).toFixed(1)} GiB available on ${v.path}`).join('; ')}.</span><Button size="sm" onClick={onOpenStorage}>Free up space</Button></div>;
}
