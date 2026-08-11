import { assistantMessageCopyText } from "./agent-directive";
import {
  citationDisplayLabel,
  citationExcerptPreview,
  citationExternalUrl,
  citationLocatorLabel,
} from "./citation";
import {
  contentLifecycle,
  contentLifecycleLabel,
  fileChangeLifecycle,
  interactiveRequestEvidencePresentation,
  interactiveRequestReceiptPresentation,
  providerOutputKindLabel,
  toolLifecycle,
  toolLifecycleLabel,
} from "./conversation";
import { formatInspectableValue } from "./inspectable-value";
import { planStepPresentation } from "./plan";
import { formatDurationMs, isSafeExternalUrl } from "./provider-output";
import { safeArtifactFilename } from "./artifact-presentation";
import { serviceMessagePresentation } from "./service-message";
import type { ConversationCitation, ConversationItem } from "./types";
import { webSearchActionLabel } from "./web-search";

export type ConversationMarkdownOptions = {
  title?: string | null;
  /** True when older authoritative history has not been loaded by the client. */
  partial?: boolean;
};

function oneLine(value: string | null | undefined, fallback: string): string {
  return value?.trim().replace(/[\r\n]+/g, " ") || fallback;
}

function statusLine(label: string, createdAt: string): string {
  const timestamp = oneLine(createdAt, "Unknown time");
  return `*${label} · ${timestamp}*`;
}

function markdownLinkLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}

function codeFence(content: string, language: string | null = null): string {
  const runs = content.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  const safeLanguage =
    language && /^[a-z0-9_+-]+$/i.test(language) ? language : "";
  return `${fence}${safeLanguage}\n${content}\n${fence}`;
}

function artifactLanguage(filename: string, mimeType: string | null): string {
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime.includes("json") || filename.toLowerCase().endsWith(".json"))
    return "json";
  if (mime.includes("markdown") || /\.md(?:own)?$/i.test(filename))
    return "markdown";
  if (mime.includes("typescript") || /\.[cm]?tsx?$/i.test(filename))
    return "typescript";
  if (mime.includes("javascript") || /\.[cm]?jsx?$/i.test(filename))
    return "javascript";
  if (mime.includes("python") || filename.toLowerCase().endsWith(".py"))
    return "python";
  if (mime.includes("html") || filename.toLowerCase().endsWith(".html"))
    return "html";
  return "text";
}

function citationLines(citations: readonly ConversationCitation[]): string[] {
  if (citations.length === 0) return [];
  return [
    "### Sources",
    ...citations.map((citation, index) => {
      const label = citationDisplayLabel(citation, index).text;
      // citationExternalUrl already rejects non-HTTP(S), credentials, and
      // malformed URLs. Canonicalizing then using an autolink also keeps
      // parentheses and provider-authored whitespace out of link syntax.
      const url = citationExternalUrl(citation);
      const locator = citationLocatorLabel(citation.locator);
      const excerpt = citationExcerptPreview(citation)?.text;
      const reference = url
        ? `${markdownLinkLabel(label)} — <${new URL(url).href}>`
        : label;
      return `- ${reference}${locator ? ` — ${locator}` : ""}${excerpt ? `\n  > ${excerpt.replace(/\n/g, "\n  > ")}` : ""}`;
    }),
  ];
}

function itemMarkdown(item: ConversationItem): string {
  switch (item.kind) {
    case "user_message": {
      const body = item.text.trim() || "_Image-only message_";
      const attachments = item.attachments.map(
        (attachment, index) =>
          `- Attachment: ${oneLine(attachment.name, `Image ${index + 1}`)}${attachment.mime_type ? ` (${oneLine(attachment.mime_type, "image")})` : ""}`,
      );
      return [
        "## You",
        statusLine("Sent", item.created_at),
        body,
        ...attachments,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "assistant_message": {
      const lifecycle = contentLifecycle(item);
      const phase =
        item.phase === "commentary" ? "Progress update" : "Assistant";
      const body = assistantMessageCopyText(
        item.text,
        lifecycle === "pending" || lifecycle === "streaming",
      );
      const memory = item.memory_citation
        ? [
            "### Memory sources",
            ...item.memory_citation.entries.map(
              (entry) =>
                `- ${oneLine(entry.path, "Memory source")}:${entry.line_start}-${entry.line_end}${entry.note.trim() ? ` — ${entry.note.trim().replace(/\n/g, " ")}` : ""}`,
            ),
            ...item.memory_citation.thread_ids.map(
              (threadId) => `- Related thread: ${oneLine(threadId, "unknown")}`,
            ),
          ]
        : [];
      return [
        `## ${phase}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at),
        body || "_No response text was produced._",
        ...citationLines(item.citations ?? []),
        ...memory,
      ].join("\n\n");
    }
    case "reasoning": {
      const lifecycle = contentLifecycle(item);
      const duration =
        item.duration_ms != null
          ? ` · ${formatDurationMs(item.duration_ms)}`
          : "";
      return [
        `## Reasoning — ${oneLine(item.summary, "Thought")}`,
        statusLine(
          `${contentLifecycleLabel(lifecycle)}${duration}`,
          item.created_at,
        ),
        item.content.trim() || "_No reasoning text was retained._",
      ].join("\n\n");
    }
    case "code_review": {
      const lifecycle = contentLifecycle(item);
      return [
        `## Code review${item.subject?.trim() ? ` — ${oneLine(item.subject, "changes")}` : ""}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at),
        item.content.trim() || "_No review findings were produced._",
      ].join("\n\n");
    }
    case "context_compaction": {
      const lifecycle = item.lifecycle ?? "succeeded";
      return [
        "## Context compaction",
        statusLine(toolLifecycleLabel(lifecycle), item.created_at),
        "Earlier conversation was summarized for continuity.",
      ].join("\n\n");
    }
    case "artifact": {
      const lifecycle = contentLifecycle(item);
      const artifact = item.artifact;
      const metadata = [
        providerOutputKindLabel(artifact.artifact_kind),
        artifact.mime_type,
        artifact.version ? `Version ${artifact.version}` : null,
      ].filter(Boolean);
      const reference =
        artifact.url?.trim() && isSafeExternalUrl(artifact.url)
          ? `Reference: <${artifact.url.trim()}>`
          : null;
      return [
        `## Artifact — ${oneLine(artifact.title, "Untitled artifact")}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at),
        metadata.length ? metadata.join(" · ") : null,
        artifact.content
          ? codeFence(
              artifact.content,
              artifactLanguage(artifact.title, artifact.mime_type),
            )
          : "_No inline artifact content was supplied._",
        reference,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "unsupported": {
      const lifecycle = contentLifecycle(item);
      return [
        `## Unsupported output — ${providerOutputKindLabel(item.output_kind)}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at),
        item.reason.trim() || "This provider output is not supported.",
        codeFence(formatInspectableValue(item.payload).text, "json"),
      ].join("\n\n");
    }
    case "image": {
      const lifecycle = contentLifecycle(item);
      const title = oneLine(item.title || item.image.name, "Generated image");
      const reference = isSafeExternalUrl(item.image.url)
        ? `Original: <${item.image.url.trim()}>`
        : null;
      return [
        `## Image — ${title}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at),
        item.image.alt_text?.trim() || "_No image description was supplied._",
        reference,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "web_search": {
      const lifecycle = contentLifecycle(item);
      const active = lifecycle === "pending" || lifecycle === "streaming";
      const search = item.search;
      return [
        `## ${webSearchActionLabel(search.action_kind, active)}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at),
        search.query.trim() || "_No search query was supplied._",
        ...search.queries.map((query) => `- Related query: ${query}`),
        search.pattern ? `Find: ${codeFence(search.pattern)}` : null,
        search.url && isSafeExternalUrl(search.url)
          ? `Source page: <${search.url.trim()}>`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "file_change": {
      const lifecycle = fileChangeLifecycle(item);
      const changes = item.changes.flatMap((change) => [
        `### ${oneLine(change.path, "Unknown file")} — ${providerOutputKindLabel(change.change_kind)}`,
        change.move_path
          ? `Moved to: ${oneLine(change.move_path, "Unknown file")}`
          : null,
        change.diff
          ? codeFence(change.diff, "diff")
          : "_No inline diff was supplied._",
      ]);
      return [
        "## File changes",
        statusLine(toolLifecycleLabel(lifecycle), item.created_at),
        ...changes,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "tool_call": {
      const lifecycle = toolLifecycle(item);
      return [
        `## Tool — ${oneLine(item.title, "Tool call")}`,
        statusLine(toolLifecycleLabel(lifecycle), item.created_at),
        item.exit_code != null ? `Exit code: ${item.exit_code}` : null,
        item.output
          ? codeFence(item.output, "text")
          : "_No tool output was supplied._",
        item.detail
          ? `### Tool details\n\n${codeFence(formatInspectableValue(item.detail).text, "json")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "plan":
      return [
        "## Plan",
        statusLine("Updated", item.created_at),
        item.plan.explanation?.trim() || null,
        ...item.plan.steps.map(
          (step) =>
            `- [${planStepPresentation(step.status).state === "completed" ? "x" : " "}] ${step.step} — ${planStepPresentation(step.status).label}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "diff":
      return [
        "## Diff",
        statusLine("Recorded", item.created_at),
        codeFence(item.diff, "diff"),
      ].join("\n\n");
    case "service": {
      const presentation = serviceMessagePresentation(item.level, item.message);
      return [
        `## Service — ${providerOutputKindLabel(item.level)}`,
        statusLine("Recorded", item.created_at),
        presentation.message.trim() || "_No diagnostic message was supplied._",
      ].join("\n\n");
    }
    case "realtime":
      return [
        `## Realtime — ${oneLine(item.title, item.item_type)}`,
        statusLine("Recorded", item.created_at),
        item.summary?.trim() || null,
        codeFence(formatInspectableValue(item.payload).text, "json"),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "interactive_request": {
      const receipt = interactiveRequestReceiptPresentation(
        item.request,
        item.resolution,
      );
      const evidence = interactiveRequestEvidencePresentation(item.request);
      return [
        `## ${item.resolved ? receipt.label : `Pending: ${oneLine(item.request.title, "Request")}`}`,
        statusLine(
          item.resolved ? "Resolved" : "Waiting for response",
          item.created_at,
        ),
        evidence.command ? codeFence(evidence.command, "text") : null,
        evidence.path
          ? `Path: ${oneLine(evidence.path, "Unknown path")}`
          : null,
        evidence.detail,
        ...evidence.questions.map(
          (question) => `- Question: ${oneLine(question.question, "Question")}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
}

export function conversationExportFilename(title?: string | null): string {
  const safe = safeArtifactFilename(title?.trim() || "FalconDeck conversation");
  if (/\.md$/i.test(safe)) return safe;
  return `${Array.from(safe).slice(0, 117).join("")}.md`;
}

/** Builds a deterministic, provider-ordered transcript without response secrets. */
export function conversationItemsToMarkdown(
  items: readonly ConversationItem[],
  options: ConversationMarkdownOptions = {},
): string {
  const title = oneLine(options.title, "FalconDeck conversation");
  const partial = options.partial
    ? "> Earlier authoritative history is not currently loaded and is not included in this export."
    : null;
  const preamble = [`# ${title}`, partial].filter(Boolean).join("\n\n");
  const transcript = items.map(itemMarkdown).join("\n\n---\n\n");
  return [preamble, transcript].filter(Boolean).join("\n\n").concat("\n");
}
