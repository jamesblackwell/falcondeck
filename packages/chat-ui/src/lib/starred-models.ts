import { parseStarredModelIds } from "@falcondeck/client-core";

export const STARRED_MODELS_STORAGE_KEY = "falcondeck.starred-models.v1";

export function readStoredStarredModelIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parseStarredModelIds(
      window.localStorage.getItem(STARRED_MODELS_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function writeStoredStarredModelIds(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STARRED_MODELS_STORAGE_KEY,
      JSON.stringify(ids),
    );
  } catch {
    // Quota, private mode, or disabled storage; in-memory starring still works.
  }
}
