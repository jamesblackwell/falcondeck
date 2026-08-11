import { safeExternalUrl } from "./provider-output";
import type {
  ConversationCitation,
  ConversationCitationLocator,
} from "./types";

export const CITATION_PAGE_SIZE = 20;
export const CITATION_LABEL_MAX_CHARS = 240;
export const CITATION_EXCERPT_MAX_CHARS = 2_000;
export const MEMORY_CITATION_PATH_MAX_CHARS = 512;
export const MEMORY_CITATION_NOTE_MAX_CHARS = 2_000;

export type CitationTextPreview = {
  text: string;
  limited: boolean;
};

/** Bounds untrusted provider display text without mutating retained evidence. */
export function citationTextPreview(
  value: string,
  maxChars: number,
): CitationTextPreview {
  const normalized = value.trim();
  if (normalized.length <= maxChars)
    return { text: normalized, limited: false };
  let end = maxChars;
  const finalCodeUnit = normalized.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return { text: `${normalized.slice(0, end)}…`, limited: true };
}

export function citationDisplayLabel(
  citation: ConversationCitation,
  index: number,
) {
  const href = citationExternalUrl(citation);
  const candidate =
    citation.title?.trim() ||
    citation.source?.trim() ||
    href ||
    `Source ${index + 1}`;
  return citationTextPreview(candidate, CITATION_LABEL_MAX_CHARS);
}

export function citationExcerptPreview(citation: ConversationCitation) {
  const excerpt = citation.cited_text?.trim();
  return excerpt
    ? citationTextPreview(excerpt, CITATION_EXCERPT_MAX_CHARS)
    : null;
}

function locatorIdentity(locator: ConversationCitationLocator): string {
  switch (locator.kind) {
    case "web_search":
      return `web:${locator.encrypted_index}`;
    case "search_result":
      return `search:${locator.search_result_index}:${locator.start_block_index}:${locator.end_block_index}`;
    case "char":
      return `char:${locator.document_index}:${locator.start_char_index}:${locator.end_char_index}:${locator.file_id ?? ""}`;
    case "page":
      return `page:${locator.document_index}:${locator.start_page_number}:${locator.end_page_number}:${locator.file_id ?? ""}`;
    case "content_block":
      return `block:${locator.document_index}:${locator.start_block_index}:${locator.end_block_index}:${locator.file_id ?? ""}`;
  }
}

/** Stable semantic identity for replay deduplication and renderer keys. */
export function citationIdentity(citation: ConversationCitation): string {
  const id = citation.id?.trim();
  if (id) return `id:${id}`;
  if (citation.locator)
    return `${citation.kind}:${locatorIdentity(citation.locator)}`;
  const reference = citation.url?.trim() || citation.source?.trim();
  if (reference) return `${citation.kind}\u001fref:${reference}`;
  return [
    citation.kind,
    citation.title?.trim() ?? "",
    citation.cited_text?.trim() ?? "",
  ].join("\u001f");
}

function identityHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Compact stable React keys, including deterministic duplicate occurrences. */
export function citationRenderKeys(
  citations: readonly ConversationCitation[],
): string[] {
  const occurrences = new Map<string, number>();
  return citations.map((citation) => {
    const identity = citationIdentity(citation);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `citation:${identityHash(identity)}:${occurrence}`;
  });
}

/** HTTP(S) location for a citation. Search-result `source` may itself be a URL. */
export function citationExternalUrl(
  citation: ConversationCitation,
): string | null {
  for (const candidate of [citation.url, citation.source]) {
    const value = safeExternalUrl(candidate);
    if (value) return value;
  }
  return null;
}

function exclusiveZeroBasedRange(
  start: number,
  end: number,
  singular: string,
  plural: string,
): string | null {
  if (end <= start) return null;
  const first = start + 1;
  return end === first ? `${singular} ${first}` : `${plural} ${first}–${end}`;
}

/** Human-readable provider location without exposing opaque web-search tokens. */
export function citationLocatorLabel(
  locator: ConversationCitationLocator | null | undefined,
) {
  if (!locator || locator.kind === "web_search") return null;
  switch (locator.kind) {
    case "search_result": {
      const range = exclusiveZeroBasedRange(
        locator.start_block_index,
        locator.end_block_index,
        "block",
        "blocks",
      );
      return [`Result ${locator.search_result_index + 1}`, range]
        .filter(Boolean)
        .join(" · ");
    }
    case "char": {
      const range = exclusiveZeroBasedRange(
        locator.start_char_index,
        locator.end_char_index,
        "character",
        "characters",
      );
      return [`Document ${locator.document_index + 1}`, range]
        .filter(Boolean)
        .join(" · ");
    }
    case "page": {
      const range =
        locator.end_page_number > locator.start_page_number
          ? `Pages ${locator.start_page_number}–${locator.end_page_number}`
          : `Page ${locator.start_page_number}`;
      return `Document ${locator.document_index + 1} · ${range}`;
    }
    case "content_block": {
      const range = exclusiveZeroBasedRange(
        locator.start_block_index,
        locator.end_block_index,
        "block",
        "blocks",
      );
      return [`Document ${locator.document_index + 1}`, range]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

/** Deduplicates replayed citation deltas while retaining the latest metadata. */
export function dedupeCitations(citations: readonly ConversationCitation[]) {
  const indices = new Map<string, number>();
  const result: ConversationCitation[] = [];
  for (const citation of citations) {
    const identity = citationIdentity(citation);
    const existingIndex = indices.get(identity);
    if (existingIndex == null) {
      indices.set(identity, result.length);
      result.push(citation);
    } else {
      result[existingIndex] = { ...result[existingIndex], ...citation };
    }
  }
  return result;
}
