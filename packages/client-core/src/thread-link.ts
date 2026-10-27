import type { ThreadSummary } from "./types";

/** A task's title is display text; its stable FalconDeck ID is the destination. */
export function parseThreadLink(value: string | null | undefined): string | null {
  const prefix = "falcondeck://thread/";
  if (!value?.toLowerCase().startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(value.slice(prefix.length));
    return id && !/[^a-z0-9._:-]/i.test(id) && id !== "." && id !== ".." ? id : null;
  } catch {
    return null;
  }
}

/** Resolve against the source daemon's summaries, including other projects. */
export function resolveThreadLinkTarget<T extends Pick<ThreadSummary, "id" | "workspace_id">>(
  threadId: string,
  threads: readonly T[],
): T | null {
  return threads.find((thread) => thread.id === threadId) ?? null;
}
