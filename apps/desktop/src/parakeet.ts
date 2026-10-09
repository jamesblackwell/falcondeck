import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { isTauriDesktop } from "./api";

export type ParakeetStatus = {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  busy: boolean;
  progress: number | null;
  phase: string;
  error: string | null;
};

export function useParakeetStatus() {
  const [status, setStatus] = useState<ParakeetStatus | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    const refresh = () => {
      void invoke<ParakeetStatus>("parakeet_status").then((value) => {
        if (!disposed) setStatus(value);
      }).catch((reason: unknown) => {
        if (!disposed) setError(String(reason));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const prepare = useCallback(async () => {
    setPreparing(true);
    setError(null);
    try {
      setStatus(await invoke<ParakeetStatus>("prepare_parakeet"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPreparing(false);
    }
  }, []);
  return { status, preparing, error: error ?? status?.error, prepare };
}
