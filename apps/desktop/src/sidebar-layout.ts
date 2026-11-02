import { useCallback, useState } from "react";

export type SidebarLayoutMode = "classic" | "bots";

const STORAGE_KEY = "falcondeck.sidebar-layout";

export function readSidebarLayout(): SidebarLayoutMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "bots" ? "bots" : "classic";
  } catch {
    return "classic";
  }
}

export function writeSidebarLayout(mode: SidebarLayoutMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private-mode storage failures keep the in-memory choice for the session.
  }
}

/** Per-device sidebar layout; Classic stays the default. */
export function useSidebarLayout(): [
  SidebarLayoutMode,
  (mode: SidebarLayoutMode) => void,
] {
  const [mode, setMode] = useState<SidebarLayoutMode>(readSidebarLayout);
  const update = useCallback((next: SidebarLayoutMode) => {
    writeSidebarLayout(next);
    setMode(next);
  }, []);
  return [mode, update];
}
