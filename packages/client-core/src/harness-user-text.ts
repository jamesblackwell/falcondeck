import type { ConversationItem, ServiceLevel } from "./types";

/** Harness-injected XML envelopes that ride the user role. */
const HARNESS_BLOCK_TAGS = [
  "environment_context",
  "recommended_plugins",
  "user_instructions",
  "system-reminder",
  "command-name",
  "command-message",
  "local-command-stdout",
  "INSTRUCTIONS",
  "task-notification",
  "user_info",
  "local-command-caveat",
] as const;

const QUERY_TAG = "user_query";

const HIDDEN_PREFIXES = [
  "Caveat: The messages below were generated",
  "# AGENTS.md instructions for",
  "The following is the Codex agent history",
  "[Request interrupted",
] as const;

/** Agent-facing wrappers FalconDeck prepends when a selected skill has no
 * native provider command. Keep in sync with the daemon projector. */
const SKILL_PATH_PREFIX = "Use the FalconDeck skill defined at ";
const SKILL_PATH_SUFFIX =
  ". Follow it as the governing skill for this request.";
const SKILL_NAME_PREFIX = "Apply the FalconDeck skill named '";
const SKILL_NAME_SUFFIX = "' to this request.";

const BACKGROUND_TASK_RE =
  /Background task "[^"]+" completed \(exit code: (-?\d+)\)\./i;
const COMMAND_LINE_RE = /Command:\s*([^\n]+)/i;
const MAX_COMMAND_CHARS = 160;

const SHUTDOWN_RESUME_REMINDER_PREFIX = "FalconDeck resume:";
const SHUTDOWN_RESUME_RECEIPT = "Resumed after FalconDeck closed";

function falcondeckResumeReceipt(inner: string): ProjectedUserText | null {
  return inner.trim().startsWith(SHUTDOWN_RESUME_REMINDER_PREFIX)
    ? { kind: "service", level: "info", message: SHUTDOWN_RESUME_RECEIPT }
    : null;
}

export type ProjectedUserText =
  | { kind: "prompt"; text: string }
  | { kind: "service"; level: ServiceLevel; message: string }
  | { kind: "hidden" }
  | { kind: "incomplete" };

function tagOpen(tag: string): string {
  return `<${tag}>`;
}

function tagClose(tag: string): string {
  return `</${tag}>`;
}

function hasIncompleteTag(text: string, tag: string): boolean {
  const open = tagOpen(tag);
  const close = tagClose(tag);
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) return true;
    cursor = end + close.length;
  }
  const dangling = `<${tag}`;
  const danglingAt = text.lastIndexOf(dangling);
  return danglingAt !== -1 && text.indexOf(">", danglingAt) === -1;
}

function extractTaggedInner(text: string, tag: string): string | null {
  const open = tagOpen(tag);
  const close = tagClose(tag);
  const start = text.indexOf(open);
  if (start === -1) return null;
  const innerStart = start + open.length;
  const end = text.indexOf(close, innerStart);
  if (end === -1) return null;
  return text.slice(innerStart, end).trim();
}

function* taggedInners(text: string, tag: string): Generator<string> {
  const open = tagOpen(tag);
  const close = tagClose(tag);
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start === -1) return;
    const innerStart = start + open.length;
    const end = text.indexOf(close, innerStart);
    if (end === -1) return;
    const inner = text.slice(innerStart, end).trim();
    if (inner) yield inner;
    cursor = end + close.length;
  }
}

function stripTaggedBlocks(text: string, tags: readonly string[]): string {
  let output = text;
  for (const tag of tags) {
    const open = tagOpen(tag);
    const close = tagClose(tag);
    let next = "";
    let cursor = 0;
    while (cursor < output.length) {
      const start = output.indexOf(open, cursor);
      if (start === -1) {
        next += output.slice(cursor);
        break;
      }
      next += output.slice(cursor, start);
      const end = output.indexOf(close, start + open.length);
      if (end === -1) {
        next += output.slice(start);
        break;
      }
      cursor = end + close.length;
    }
    output = next;
  }
  return output;
}

function truncateCommand(command: string): string {
  if (command.length <= MAX_COMMAND_CHARS) return command;
  return `${Array.from(command).slice(0, MAX_COMMAND_CHARS - 1).join("")}…`;
}

function backgroundTaskReceipt(
  body: string,
): Extract<ProjectedUserText, { kind: "service" }> | null {
  const match = BACKGROUND_TASK_RE.exec(body);
  if (!match) return null;
  const exit = Number(match[1]);
  const failed = exit !== 0;
  let command = COMMAND_LINE_RE.exec(body)?.[1]?.trim() ?? "";
  let duration = "";
  const split = command.split(/\s*\|\s*Duration:\s*/);
  if (split.length > 1) {
    command = split[0].trim();
    duration = split[1].trim();
  }
  if (command) command = truncateCommand(command);
  const parts = [
    failed
      ? `Background command failed (exit ${exit})`
      : "Background command finished",
    command || null,
    duration || null,
  ].filter((part): part is string => Boolean(part));
  return {
    kind: "service",
    level: failed ? "warning" : "info",
    message: parts.join(" · "),
  };
}

function startsWithHiddenPrefix(text: string): boolean {
  return HIDDEN_PREFIXES.some((prefix) => text.startsWith(prefix));
}

type SkillPreambleStrip =
  | { kind: "unchanged" }
  | { kind: "incomplete" }
  | { kind: "stripped"; text: string };

function stripFalcondeckSkillPreambles(text: string): SkillPreambleStrip {
  let rest = text.trimStart();
  let strippedAny = false;
  while (true) {
    if (rest.startsWith(SKILL_PATH_PREFIX)) {
      const afterPrefix = rest.slice(SKILL_PATH_PREFIX.length);
      const suffixAt = afterPrefix.indexOf(SKILL_PATH_SUFFIX);
      if (suffixAt === -1) return { kind: "incomplete" };
      rest = afterPrefix
        .slice(suffixAt + SKILL_PATH_SUFFIX.length)
        .trimStart();
      strippedAny = true;
      continue;
    }
    if (rest.startsWith(SKILL_NAME_PREFIX)) {
      const afterPrefix = rest.slice(SKILL_NAME_PREFIX.length);
      const suffixAt = afterPrefix.indexOf(SKILL_NAME_SUFFIX);
      if (suffixAt === -1) return { kind: "incomplete" };
      rest = afterPrefix
        .slice(suffixAt + SKILL_NAME_SUFFIX.length)
        .trimStart();
      strippedAny = true;
      continue;
    }
    break;
  }
  return strippedAny
    ? { kind: "stripped", text: rest.trimEnd() }
    : { kind: "unchanged" };
}

/**
 * Turns harness-injected user-role text into what the transcript should
 * show: the typed prompt, a quiet background-task receipt, or nothing.
 */
export function projectHarnessUserText(text: string): ProjectedUserText {
  let source = text.trim();
  if (!source) return { kind: "hidden" };

  const strippedSkills = stripFalcondeckSkillPreambles(source);
  if (strippedSkills.kind === "incomplete") return { kind: "incomplete" };
  if (strippedSkills.kind === "stripped") {
    if (!strippedSkills.text) return { kind: "hidden" };
    source = strippedSkills.text;
  }

  const tags = [...HARNESS_BLOCK_TAGS, QUERY_TAG];
  if (tags.some((tag) => hasIncompleteTag(source, tag))) {
    return { kind: "incomplete" };
  }

  const query = extractTaggedInner(source, QUERY_TAG);
  if (query !== null) {
    return query && !startsWithHiddenPrefix(query)
      ? { kind: "prompt", text: query }
      : { kind: "hidden" };
  }

  if (!source.includes("<") && !startsWithHiddenPrefix(source)) {
    return { kind: "prompt", text: source };
  }

  const remainder = stripTaggedBlocks(source, HARNESS_BLOCK_TAGS).trim();
  if (remainder) {
    return startsWithHiddenPrefix(remainder)
      ? { kind: "hidden" }
      : { kind: "prompt", text: remainder };
  }

  for (const inner of taggedInners(source, "system-reminder")) {
    const resume = falcondeckResumeReceipt(inner);
    if (resume) return resume;
    const receipt = backgroundTaskReceipt(inner);
    if (receipt) return receipt;
  }
  return backgroundTaskReceipt(source) ?? { kind: "hidden" };
}

function previousUserPrompt(
  items: readonly ConversationItem[],
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user_message") return item.text;
    if (
      item?.kind === "service" ||
      item?.kind === "reasoning" ||
      item?.kind === "tool_call"
    ) {
      continue;
    }
    return null;
  }
  return null;
}

function isSkillPreambleEchoOf(previous: string, raw: string): boolean {
  const stripped = stripFalcondeckSkillPreambles(raw);
  if (stripped.kind !== "stripped") return false;
  const typed = previous.trim();
  return stripped.text === typed || stripped.text === "";
}

/** Rewrites or drops user-role items so renderers never see harness XML. */
export function projectHarnessUserItems(
  items: readonly ConversationItem[],
): ConversationItem[] {
  let copied = false;
  const next: ConversationItem[] = [];
  for (const item of items) {
    if (item.kind !== "user_message") {
      next.push(item);
      continue;
    }
    const previous = previousUserPrompt(next);
    if (
      previous !== null &&
      item.attachments.length === 0 &&
      isSkillPreambleEchoOf(previous, item.text)
    ) {
      copied = true;
      continue;
    }
    const projected = projectHarnessUserText(item.text);
    if (projected.kind === "prompt" && projected.text === item.text) {
      next.push(item);
      continue;
    }
    copied = true;
    if (projected.kind === "prompt") {
      next.push({ ...item, text: projected.text });
      continue;
    }
    if (projected.kind === "service") {
      next.push({
        kind: "service",
        id: item.id,
        level: projected.level,
        message: projected.message,
        created_at: item.created_at,
      });
      continue;
    }
    if (item.attachments.length > 0) {
      next.push({ ...item, text: "" });
    }
  }
  return copied ? next : (items as ConversationItem[]);
}
