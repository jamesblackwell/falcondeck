const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Converts a provider-authored artifact title into a portable leaf filename.
 * The readable title remains untouched in the transcript; only file handoffs
 * and browser download hints use this value.
 */
export function safeArtifactFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1)?.trim() || "artifact";
  let safe = basename
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[. ]+$/g, "");

  safe = Array.from(safe).slice(0, 120).join("");
  if (!safe || safe === "." || safe === "..") return "artifact";
  return WINDOWS_DEVICE_NAME_PATTERN.test(safe) ? `_${safe}` : safe;
}

/**
 * Accepts a bare RFC-style media type and rejects parameters or control data.
 * Callers choose the appropriate fallback for their handoff surface.
 */
export function safeArtifactMimeType(
  mimeType: string | null | undefined,
): string | null {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  return MIME_TYPE_PATTERN.test(normalized) ? normalized : null;
}
