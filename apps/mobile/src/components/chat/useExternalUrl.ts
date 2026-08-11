import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";

/** Keeps a failed native handoff attached to the exact URL that failed. */
export function useExternalUrl(url: string) {
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingRef = useRef<{
    url: string;
    epoch: number;
    promise: Promise<void>;
  } | null>(null);
  const [state, setState] = useState<{
    url: string;
    epoch: number;
    status: "idle" | "opening" | "failed";
  }>({ url, epoch: 0, status: "idle" });

  // A virtualized row can be recycled for a different target. Advancing the
  // epoch during that render prevents an old async completion from owning the
  // same URL if the row later cycles back to it.
  if (state.url !== url) {
    setState({ url, epoch: state.epoch + 1, status: "idle" });
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      pendingRef.current = null;
    };
  }, []);

  const open = useCallback(() => {
    if (!url) return Promise.resolve();

    const epoch = state.epoch;
    const pending = pendingRef.current;
    if (pending && pending.url === url && pending.epoch === epoch) {
      return pending.promise;
    }

    const attempt = ++attemptRef.current;
    setState({ url, epoch, status: "opening" });

    let launched: Promise<void>;
    try {
      launched = Linking.openURL(url);
    } catch {
      launched = Promise.reject(new Error("Native URL handoff failed"));
    }

    const operation = Promise.resolve(launched)
      .then(
        () => {
          if (mountedRef.current && attemptRef.current === attempt) {
            setState((current) =>
              current.url === url && current.epoch === epoch
                ? { ...current, status: "idle" }
                : current,
            );
          }
        },
        () => {
          if (mountedRef.current && attemptRef.current === attempt) {
            setState((current) =>
              current.url === url && current.epoch === epoch
                ? { ...current, status: "failed" }
                : current,
            );
          }
        },
      )
      .finally(() => {
        if (pendingRef.current?.promise === operation) {
          pendingRef.current = null;
        }
      });

    pendingRef.current = {
      url,
      epoch,
      promise: operation,
    };
    return operation;
  }, [state.epoch, url]);

  return {
    failed: state.status === "failed",
    opening: state.status === "opening",
    open,
  };
}
