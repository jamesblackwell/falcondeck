/** A parsed manual context-compaction command from the composer. */
export type CompactThreadCommand = {
  /** Optional provider-specific guidance about what the summary should preserve. */
  instructions: string | null;
};

/**
 * Parses the harness-native `/compact` control command.
 *
 * It must own the complete trimmed composer value: a mention inside ordinary
 * prose remains a model prompt, while optional trailing text becomes
 * compaction guidance for harnesses that support it.
 */
export function parseCompactThreadCommand(
  value: string,
): CompactThreadCommand | null {
  const match = value.trim().match(/^\/compact(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const instructions = match[1]?.trim() ?? "";
  return { instructions: instructions || null };
}
