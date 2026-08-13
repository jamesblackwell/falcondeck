import type { ReactNode } from "react";

export type MainViewRegistry = Readonly<Record<string, ReactNode>>;

/** Resolves a full-main-area view without coupling callers to its implementation. */
export function resolveMainView(
  registry: MainViewRegistry,
  activeViewId: string | null,
): ReactNode | null {
  if (!activeViewId || !Object.hasOwn(registry, activeViewId)) return null;
  return registry[activeViewId] ?? null;
}
