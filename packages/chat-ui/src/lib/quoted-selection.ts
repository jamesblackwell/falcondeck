export type QuotedSelection = {
  id: string;
  text: string;
};

export function normalizeQuotedSelection(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^\n+|\n+$/g, "");
}

export function quotedSelectionMarkdown(text: string) {
  const normalized = normalizeQuotedSelection(text);
  if (!normalized.trim()) return "";
  return normalized
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/** Serializes visual composer selections into ordinary text for every agent. */
export function composePromptWithQuotedSelections(
  draft: string,
  selections: readonly QuotedSelection[],
) {
  const quoted = selections
    .map((selection) => quotedSelectionMarkdown(selection.text))
    .filter(Boolean)
    .join("\n\n");
  if (!quoted) return draft;
  if (!draft.trim()) return quoted;
  return `${quoted}\n\n${draft}`;
}
