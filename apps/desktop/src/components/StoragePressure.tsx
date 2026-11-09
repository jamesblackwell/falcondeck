import { useEffect, useMemo, useRef, useState } from 'react';
import { storageClient, storageLevel } from '@falcondeck/client-core';
import { Button } from '@falcondeck/ui';
import { sendDesktopAttentionNotification } from '../desktop-notifications';

export function StoragePressure({ baseUrl, onOpenStorage, onToast }: {
  baseUrl: string | null; onOpenStorage: () => void;
  onToast: (toast: { variant: 'warning'; title: string; description: string; action: { label: string; onClick: () => void } }) => void;
}) {
  const api = useMemo(() => baseUrl ? storageClient(baseUrl) : null, [baseUrl]);
  const [critical, setCritical] = useState<number | null>(null);
  const warned = useRef(false);
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!api) return;
      try {
        const [h, p] = await Promise.all([api.health(), api.preferences()]);
        if (!active) return;
        if (!p.warnings) { setCritical(null); return; }
        const level = storageLevel(h.free_bytes);
        if (level === 'normal') warned.current = false;
        if (level === 'unknown') return;
        const description = `${((h.free_bytes ?? 0) / 2 ** 30).toFixed(1)} GiB available. Review retained workspaces in Settings → Storage.`;
        if ((level === 'low' || level === 'critical') && !warned.current) {
          warned.current = true;
          onToast({ variant: 'warning', title: 'Storage is running low', description, action: { label: 'Free up space', onClick: onOpenStorage } });
        }
        setCritical(level === 'critical' ? h.free_bytes : null);
        if (level === 'critical') {
          // Daily claim survives webview/daemon restarts and allows at most one
          // local notification attempt a day. It never calls a relay or device.
          const day = new Date().toLocaleDateString('en-CA');
          const key = 'falcondeck:storage-critical-day';
          if (localStorage.getItem(key) !== day) {
            localStorage.setItem(key, day);
            void sendDesktopAttentionNotification({ title: 'Critically low disk space', body: description });
          }
        }
      } catch { /* Retain the last warning while a health check is unavailable. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 180_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, onOpenStorage, onToast]);
  return critical === null ? null : <div role="alert" className="fixed inset-x-6 top-12 z-50 flex items-center justify-between gap-4 rounded-lg border border-danger bg-surface-2 p-3 text-sm"><span>Critically low disk space: {(critical / 2 ** 30).toFixed(1)} GiB available.</span><Button size="sm" onClick={onOpenStorage}>Free up space</Button></div>;
}
