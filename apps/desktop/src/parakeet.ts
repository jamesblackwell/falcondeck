import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [setupError, setSetupError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    mounted.current = true;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      const started = generation.current;
      let busy = false;
      try {
        const value = await invoke<ParakeetStatus>("parakeet_status");
        if (!disposed && started === generation.current) {
          setStatus(value);
          setPollError(null);
          busy = value.busy;
        }
      } catch (reason) {
        if (!disposed && started === generation.current) setPollError(String(reason));
      }
      // Only one poll can be in flight. Idle settings need fewer IPC calls.
      if (!disposed) timer = window.setTimeout(() => void refresh(), busy || preparingRef.current ? 1000 : 5000);
    };
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      window.clearTimeout(timer);
    };
  }, []);

  const prepare = useCallback(async (force = false) => {
    if (!isTauriDesktop()) {
      setSetupError("Parakeet is available in the FalconDeck Mac app.");
      return;
    }
    if (preparingRef.current) return;
    preparingRef.current = true;
    generation.current += 1;
    setPreparing(true);
    setSetupError(null);
    try {
      const value = await invoke<ParakeetStatus>("prepare_parakeet", { force });
      if (mounted.current) {
        setStatus(value);
        setPollError(null);
      }
    } catch (reason) {
      if (mounted.current) setSetupError(String(reason));
    } finally {
      // Ignore any poll that started before the terminal setup response.
      generation.current += 1;
      preparingRef.current = false;
      if (mounted.current) setPreparing(false);
    }
  }, []);
  return { status, preparing, error: setupError ?? pollError ?? status?.error, prepare };
}
