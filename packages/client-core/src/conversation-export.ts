import { assistantMessageCopyText } from "./agent-directive";
import { projectHarnessUserItems } from "./harness-user-text";
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
import { unwrapShellCommand } from "./tool-label";
import type { ConversationCitation, ConversationItem } from "./types";
import { webSearchActionLabel } from "./web-search";

export type ConversationMarkdownMode = "export" | "handoff";

export type ConversationMarkdownOptions = {
  title?: string | null;
  /** True when older authoritative history has not been loaded by the client. */
  partial?: boolean;
  /**
   * `export` is the human download/share snapshot and keeps timestamps.
   * `handoff` drops timestamps and other repeated chrome the destination
   * model does not need. Content stays verbatim.
   */
  mode?: ConversationMarkdownMode;
  /** Workspace path used to strip repeated `cd` prefixes and make paths relative. */
  workspacePath?: string | null;
};

type MarkdownContext = {
  mode: ConversationMarkdownMode;
  workspaceRoot: string | null;
};

const DEFAULT_HANDOFF_STATUS = new Set([
  "Complete",
  "Completed",
  "Sent",
  "Recorded",
  "Updated",
]);

/** Keep handoff context useful without letting large refactors dominate it. */
const MAX_HANDOFF_FILE_SUMMARY = 100;

function oneLine(value: string | null | undefined, fallback: string): string {
  return value?.trim().replace(/[\r\n]+/g, " ") || fallback;
}

function normalizeWorkspaceRoot(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/, "");
  return trimmed || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Most common command cwd / `cd` prefix, used when the caller has no workspace path. */
function inferWorkspaceRoot(
  items: readonly ConversationItem[],
): string | null {
  const counts = new Map<string, number>();
  const consider = (value: string | null | undefined) => {
    const path = normalizeWorkspaceRoot(value);
    if (!path || !path.startsWith("/")) return;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  };
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    if (item.detail?.kind === "command_execution") consider(item.detail.cwd);
    const match = unwrapShellCommand(item.title).match(
      /^cd\s+['"]?(\/[^'"\s;&]+)['"]?/,
    );
    if (match) consider(match[1]);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [path, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && (best == null || path.length > best.length))
    ) {
      best = path;
      bestCount = count;
    }
  }
  return best;
}

function stripWorkspaceFromText(value: string, root: string): string {
  const escaped = escapeRegExp(root);
  const cdPrefix = new RegExp(
    `^cd\\s+(?:['"]${escaped}['"]|${escaped})\\s*(?:&&|;|\\n)\\s*`,
  );
  const cdOnly = new RegExp(`^cd\\s+(?:['"]${escaped}['"]|${escaped})$`);
  let next = value.replace(cdPrefix, "");
  if (cdOnly.test(next)) next = "cd .";
  if (next.startsWith(`${root}/`)) next = next.slice(root.length + 1);
  else if (next === root) next = ".";
  next = next.replaceAll(`${root}/`, "");
  return next.trim() || value;
}

function compactHandoffTitle(title: string, workspaceRoot: string | null): string {
  const unwrapped = unwrapShellCommand(title.trim());
  if (!workspaceRoot) return unwrapped;
  return stripWorkspaceFromText(unwrapped, workspaceRoot);
}

function statusLine(
  label: string,
  createdAt: string,
  ctx: MarkdownContext,
): string | null {
  if (ctx.mode === "handoff") {
    return DEFAULT_HANDOFF_STATUS.has(label) ? null : `*${label}*`;
  }
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

function relativize(value: string, ctx: MarkdownContext): string {
  if (ctx.mode !== "handoff" || !ctx.workspaceRoot) return value;
  return stripWorkspaceFromText(value, ctx.workspaceRoot);
}

function shouldIncludeToolDetails(
  item: Extract<ConversationItem, { kind: "tool_call" }>,
  ctx: MarkdownContext,
): boolean {
  if (!item.detail) return false;
  if (ctx.mode !== "handoff") return true;
  // Command execution is already the title plus output; the JSON is cwd,
  // duration, process id, and a duplicated command.
  return item.detail.kind !== "command_execution";
}

function handoffFileSummary(
  items: readonly ConversationItem[],
  ctx: MarkdownContext,
): string | null {
  const seen = new Set<string>();
  const newestFirst: string[] = [];

  // Prefer the files touched most recently when a long session exceeds the
  // cap. Walking backwards also collapses repeated edits to the same path.
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (item.kind !== "file_change") continue;
    for (
      let changeIndex = item.changes.length - 1;
      changeIndex >= 0;
      changeIndex -= 1
    ) {
      const change = item.changes[changeIndex];
      // Reverse path order here so reversing the completed list below keeps a
      // move's source before its destination.
      for (const value of [change.move_path, change.path]) {
        const path = value ? oneLine(relativize(value, ctx), "") : "";
        if (!path || seen.has(path)) continue;
        seen.add(path);
        newestFirst.push(path);
      }
    }
  }

  if (newestFirst.length === 0) return null;
  const visible = newestFirst
    .slice(0, MAX_HANDOFF_FILE_SUMMARY)
    .reverse();
  const note =
    seen.size > visible.length
      ? `_Showing the ${visible.length} most recently edited of ${seen.size} unique files._`
      : null;
  return [
    "## Files edited in this session",
    note,
    visible.map((path) => `- ${path}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function itemMarkdown(item: ConversationItem, ctx: MarkdownContext): string {
  switch (item.kind) {
    case "user_message": {
      const body = item.text.trim() || "_Image-only message_";
      const attachments = item.attachments.map(
        (attachment, index) =>
          `- Attachment: ${oneLine(attachment.name, `Image ${index + 1}`)}${attachment.mime_type ? ` (${oneLine(attachment.mime_type, "image")})` : ""}`,
      );
      return [
        ctx.mode === "handoff" ? "## User" : "## You",
        statusLine("Sent", item.created_at, ctx),
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
                `- ${oneLine(relativize(entry.path, ctx), "Memory source")}:${entry.line_start}-${entry.line_end}${entry.note.trim() ? ` — ${entry.note.trim().replace(/\n/g, " ")}` : ""}`,
            ),
            ...item.memory_citation.thread_ids.map(
              (threadId) => `- Related thread: ${oneLine(threadId, "unknown")}`,
            ),
          ]
        : [];
      return [
        `## ${phase}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at, ctx),
        body || "_No response text was produced._",
        ...citationLines(item.citations ?? []),
        ...memory,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "reasoning": {
      const lifecycle = contentLifecycle(item);
      const duration =
        ctx.mode === "export" && item.duration_ms != null
          ? ` · ${formatDurationMs(item.duration_ms)}`
          : "";
      return [
        `## Reasoning — ${oneLine(item.summary, "Thought")}`,
        statusLine(
          `${contentLifecycleLabel(lifecycle)}${duration}`,
          item.created_at,
          ctx,
        ),
        item.content.trim() || null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "code_review": {
      const lifecycle = contentLifecycle(item);
      return [
        `## Code review${item.subject?.trim() ? ` — ${oneLine(item.subject, "changes")}` : ""}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at, ctx),
        item.content.trim() || "_No review findings were produced._",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "context_compaction": {
      const lifecycle = item.lifecycle ?? "succeeded";
      return [
        "## Context compaction",
        statusLine(toolLifecycleLabel(lifecycle), item.created_at, ctx),
        "Earlier conversation was summarized for continuity.",
      ]
        .filter(Boolean)
        .join("\n\n");
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
        statusLine(contentLifecycleLabel(lifecycle), item.created_at, ctx),
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
        statusLine(contentLifecycleLabel(lifecycle), item.created_at, ctx),
        item.reason.trim() || "This provider output is not supported.",
        codeFence(formatInspectableValue(item.payload).text, "json"),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "image": {
      const lifecycle = contentLifecycle(item);
      const title = oneLine(item.title || item.image.name, "Generated image");
      const reference = isSafeExternalUrl(item.image.url)
        ? `Original: <${item.image.url.trim()}>`
        : null;
      return [
        `## Image — ${title}`,
        statusLine(contentLifecycleLabel(lifecycle), item.created_at, ctx),
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
        statusLine(contentLifecycleLabel(lifecycle), item.created_at, ctx),
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
        `### ${oneLine(relativize(change.path, ctx), "Unknown file")} — ${providerOutputKindLabel(change.change_kind)}`,
        change.move_path
          ? `Moved to: ${oneLine(relativize(change.move_path, ctx), "Unknown file")}`
          : null,
        change.diff
          ? codeFence(change.diff, "diff")
          : "_No inline diff was supplied._",
      ]);
      return [
        "## File changes",
        statusLine(toolLifecycleLabel(lifecycle), item.created_at, ctx),
        ...changes,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "tool_call": {
      const lifecycle = toolLifecycle(item);
      const title =
        ctx.mode === "handoff"
          ? compactHandoffTitle(item.title, ctx.workspaceRoot)
          : item.title;
      const keepDetails = shouldIncludeToolDetails(item, ctx);
      const keepExit =
        item.exit_code != null &&
        (ctx.mode === "export" || item.exit_code !== 0);
      return [
        `## Tool — ${oneLine(title, "Tool call")}`,
        statusLine(toolLifecycleLabel(lifecycle), item.created_at, ctx),
        keepExit ? `Exit code: ${item.exit_code}` : null,
        item.output
          ? codeFence(item.output, "text")
          : ctx.mode === "handoff"
            ? null
            : "_No tool output was supplied._",
        keepDetails
          ? `### Tool details\n\n${codeFence(formatInspectableValue(item.detail).text, "json")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "plan":
      return [
        "## Plan",
        statusLine("Updated", item.created_at, ctx),
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
        statusLine("Recorded", item.created_at, ctx),
        codeFence(item.diff, "diff"),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "service": {
      const presentation = serviceMessagePresentation(item.level, item.message);
      return [
        `## Service — ${providerOutputKindLabel(item.level)}`,
        statusLine("Recorded", item.created_at, ctx),
        presentation.message.trim() || "_No diagnostic message was supplied._",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "realtime":
      return [
        `## Realtime — ${oneLine(item.title, item.item_type)}`,
        statusLine("Recorded", item.created_at, ctx),
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
          ctx,
        ),
        evidence.command ? codeFence(evidence.command, "text") : null,
        evidence.path
          ? `Path: ${oneLine(relativize(evidence.path, ctx), "Unknown path")}`
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
  const mode = options.mode ?? "export";
  const ctx: MarkdownContext = {
    mode,
    workspaceRoot:
      mode === "handoff"
        ? (normalizeWorkspaceRoot(options.workspacePath) ??
          inferWorkspaceRoot(items))
        : null,
  };
  const partial = options.partial
    ? "> Earlier authoritative history is not currently loaded and is not included in this export."
    : null;
  const preamble = [`# ${title}`, partial].filter(Boolean).join("\n\n");
  const fileSummary =
    mode === "handoff" ? handoffFileSummary(items, ctx) : null;
  const transcript = projectHarnessUserItems(items)
    .filter(
      (item) =>
        item.kind !== "reasoning" ||
        Boolean(item.content.trim() || item.summary?.trim()),
    )
    .map((item) => itemMarkdown(item, ctx))
    .join("\n\n---\n\n");
  return [preamble, fileSummary, transcript]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}
