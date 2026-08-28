import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Ban,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CheckCircle2,
  Circle,
  CircleX,
  Clock3,
  Download,
  ExternalLink,
  FileDiff,
  FileText,
  GitCommitHorizontal,
  ImageIcon,
  Info,
  PauseCircle,
  Radio,
  Search,
  Split,
  Square,
  Upload,
  Volume2,
} from "lucide-react";
import * as Collapsible from "@radix-ui/react-collapsible";

import {
  CITATION_PAGE_SIZE,
  MEMORY_CITATION_NOTE_MAX_CHARS,
  MEMORY_CITATION_PATH_MAX_CHARS,
  citationDisplayLabel,
  citationExternalUrl,
  citationExcerptPreview,
  citationLocatorLabel,
  citationRenderKeys,
  citationTextPreview,
  assistantMessageCopyText,
  assistantFailureDetail,
  codeReviewPresentation,
  contentLifecycle,
  contentLifecycleLabel,
  contextCompactionPresentation,
  fileChangeLifecycle,
  formatArtifactSize,
  formatDurationMs,
  formatInspectableValue,
  formatReceivedAgo,
  formatWorkDuration,
  guardianReviewPresentation,
  interactiveRequestEvidencePresentation,
  interactiveRequestReceiptPresentation,
  inspectMcpResult,
  inspectableValueSummary,
  isSafeExternalUrl,
  isSafeMediaUrl,
  providerOutputKindLabel,
  parseMcpResult,
  projectHarnessUserText,
  serviceMessagePresentation,
  safeExternalUrl,
  safeArtifactFilename,
  safeArtifactMimeType,
  summarizeParsedMcpArtifacts,
  describeToolCall,
  notableToolAction,
  toolCallLabel,
  toolLifecycle,
  toolLifecycleLabel,
  webSearchActionLabel,
  type ConversationItem,
  type ConversationCitation,
  type ConversationLiveActivityGroup,
  type ConversationMemoryCitation,
  type ImageInput,
  type ThinkingDisplay,
  type ToolActivitySummary,
  type ToolTestSummary,
  type WorkSessionEntry,
} from "@falcondeck/client-core";
import { ActivityDiamond, CopyButton, cn } from "@falcondeck/ui";

import { FileDiffLink, useOpenFileDiff } from "../lib/file-diff-context";
import { extractFilePath, fileBaseName } from "../lib/tool-file-path";
import { WebLinkAnchor } from "../lib/web-link-context";
import { CodeBlock } from "./code-block";
import { DiffBlock } from "./diff-block";
import { useParsedDiff } from "./diff-lines";
import { MessageMarkdown } from "./message-markdown";
import { PlanStepList } from "./plan-steps";
import {
  attachmentLabel,
  canRenderAttachmentImage,
} from "./attachment-preview";
import type { ReadAloudController } from "../lib/read-aloud";

function UserAttachment({
  attachment,
  onPreview,
}: {
  attachment: ImageInput;
  onPreview: (attachment: ImageInput, trigger: HTMLButtonElement) => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = attachment.url.trim();
  const label = attachmentLabel(attachment);
  const renderable = canRenderAttachmentImage(url) && failedUrl !== url;

  return renderable ? (
    <button
      type="button"
      onClick={(event) => onPreview(attachment, event.currentTarget)}
      aria-label={`Preview ${label}`}
      title={label}
      className="fd-focus group/attachment h-20 w-20 overflow-hidden rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2"
    >
      <img
        src={url}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(url)}
        className="h-full w-full object-cover transition-transform group-hover/attachment:scale-[1.03]"
      />
    </button>
  ) : (
    <div
      role="img"
      aria-label={`${label}, image unavailable`}
      className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 p-2 text-center text-fg-muted"
      title={label}
    >
      <CircleX aria-hidden="true" className="h-4 w-4 text-danger" />
      <span className="line-clamp-2 break-all text-[length:var(--fd-text-2xs)]">
        {label}
      </span>
    </div>
  );
}

function ImagePreviewDialog({
  url,
  label,
  onClose,
}: {
  url: string;
  label: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Preview ${label}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto max-h-[92vh] max-w-[92vw] overflow-visible border-0 bg-transparent p-0 text-fg-primary backdrop:bg-black/75"
    >
      <div className="relative overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close image preview"
          className="fd-focus absolute right-3 top-3 z-10 rounded-full bg-black/75 px-3 py-2 text-[length:var(--fd-text-sm)] font-medium text-white"
        >
          Close
        </button>
        {failed ? (
          <div
            role="img"
            aria-label={`${label}, image unavailable`}
            className="flex h-72 w-[min(88vw,36rem)] flex-col items-center justify-center gap-3 bg-surface-0 text-fg-muted"
          >
            <CircleX aria-hidden="true" className="h-8 w-8 text-danger" />
            <span className="text-[length:var(--fd-text-sm)]">
              Image unavailable
            </span>
          </div>
        ) : (
          <img
            src={url}
            alt={label}
            onError={() => setFailed(true)}
            className="max-h-[82vh] max-w-[88vw] bg-surface-0 object-contain"
          />
        )}
        <p className="max-w-[88vw] truncate px-4 py-3 text-[length:var(--fd-text-sm)] text-fg-secondary">
          {label}
        </p>
      </div>
    </dialog>
  );
}

/** Six-ish body lines; a sent message taller than this clamps behind a fade
    so a pasted wall of text (handoffs especially) reads as one glanceable
    bubble instead of pages of scrollback. */
const COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX = 160;

/** Copy/read-aloud chrome stays visible on touch. A fine pointer hides it
    until this item is hovered or focused. Tailwind's `group-hover` variant
    is wrapped in `(hover: hover)`, which some desktop WebViews report as
    false even with a mouse, so reveal uses `group-[:hover]` instead. */
function hoverRevealActions(group: "message" | "review") {
  return [
    "transition-opacity",
    "[@media(pointer:fine)]:opacity-0",
    `group-[:hover]/${group}:opacity-100`,
    `group-focus-within/${group}:opacity-100`,
  ].join(" ");
}

function UserMessage({
  item,
  collapseLongMessages = true,
}: {
  item: Extract<ConversationItem, { kind: "user_message" }>;
  collapseLongMessages?: boolean;
}) {
  const projected = projectHarnessUserText(item.text);
  const text = projected.kind === "prompt" ? projected.text : "";
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(
    null,
  );
  const previewAttachment = previewAttachmentId
    ? (item.attachments.find(
        (attachment) => attachment.id === previewAttachmentId,
      ) ?? null)
    : null;
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const handlePreview = useCallback(
    (attachment: ImageInput, trigger: HTMLButtonElement) => {
      previewTriggerRef.current = trigger;
      setPreviewAttachmentId(attachment.id);
    },
    [],
  );
  const handlePreviewClose = useCallback(
    () => setPreviewAttachmentId(null),
    [],
  );
  const hasText = text.trim().length > 0;
  const collapsible = collapseLongMessages && hasText;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (previewAttachmentId && !previewAttachment) {
      previewTriggerRef.current = null;
      setPreviewAttachmentId(null);
    }
  }, [previewAttachment, previewAttachmentId]);

  useEffect(() => {
    if (!previewAttachmentId) previewTriggerRef.current?.focus();
  }, [previewAttachmentId]);

  // The text keeps its natural height inside the clamped wrapper, so
  // scrollHeight is the unclamped size even while collapsed. Re-measure on
  // resize: the bubble is width-fit, and reflow moves messages across the cap.
  useEffect(() => {
    const node = textRef.current;
    if (!collapsible || !node) return;
    const measure = () =>
      setOverflowing(
        node.scrollHeight > COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX + 1,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [collapsible, text]);

  const collapsed = collapsible && overflowing && !expanded;

  if (projected.kind === "service") {
    return (
      <ServiceMessage
        item={{
          kind: "service",
          id: item.id,
          level: projected.level,
          message: projected.message,
          created_at: item.created_at,
        }}
      />
    );
  }
  if (
    (projected.kind === "hidden" || projected.kind === "incomplete") &&
    item.attachments.length === 0
  ) {
    return null;
  }

  return (
    <div className="group/message relative ml-auto w-fit min-w-0 max-w-2xl rounded-[var(--fd-radius-xl)] bg-surface-3 px-5 py-4">
      <div
        className={cn("relative", collapsed && "overflow-hidden")}
        style={
          collapsed
            ? { maxHeight: COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX }
            : undefined
        }
      >
        <div
          ref={textRef}
          data-message-selectable-content
          className="fd-type-body max-w-none break-words text-fg-primary"
        >
          <MessageMarkdown
            text={text}
            defer={false}
            interpretDirectives={false}
            highlightCommands
          />
        </div>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Show the full message"
            className="fd-focus absolute inset-x-0 bottom-0 flex h-14 items-end justify-center bg-gradient-to-t from-surface-3 to-transparent"
          >
            <span className="flex items-center gap-1 text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary transition-colors group-hover/message:text-fg-secondary">
              Show more
              <ChevronDown aria-hidden="true" className="h-3 w-3" />
            </span>
          </button>
        ) : null}
      </div>
      {collapsible && overflowing && expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse the message"
          className="fd-focus mt-2 flex items-center gap-1 rounded-[var(--fd-radius-sm)] text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary transition-colors hover:text-fg-secondary"
        >
          Show less
          <ChevronUp aria-hidden="true" className="h-3 w-3" />
        </button>
      ) : null}
      {item.attachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.attachments.map((attachment) => (
            <UserAttachment
              key={attachment.id}
              attachment={attachment}
              onPreview={handlePreview}
            />
          ))}
        </div>
      ) : null}
      {hasText ? (
        <div
          className={cn(
            "absolute -top-3 right-2 z-10 flex justify-end rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-3 shadow-sm",
            hoverRevealActions("message"),
            "[@media(pointer:coarse)]:static [@media(pointer:coarse)]:mt-1 [@media(pointer:coarse)]:min-h-6 [@media(pointer:coarse)]:border-0 [@media(pointer:coarse)]:shadow-none",
          )}
        >
          <CopyButton text={text} label="Copy message" />
        </div>
      ) : null}
      {previewAttachment ? (
        <ImagePreviewDialog
          key={`${previewAttachment.id}:${previewAttachment.url}`}
          url={previewAttachment.url}
          label={attachmentLabel(previewAttachment)}
          onClose={handlePreviewClose}
        />
      ) : null}
    </div>
  );
}

function ShowMoreSources({
  remaining,
  sourceKind,
  onShowMore,
}: {
  remaining: number;
  sourceKind: "cited" | "memory";
  onShowMore: () => void;
}) {
  if (remaining <= 0) return null;
  const nextCount = Math.min(CITATION_PAGE_SIZE, remaining);
  return (
    <li className="pt-1">
      <button
        type="button"
        className="fd-focus rounded-[var(--fd-radius-sm)] px-2 py-1 font-medium text-accent hover:bg-accent/10"
        aria-label={`Show ${nextCount} more ${sourceKind} source${nextCount === 1 ? "" : "s"}`}
        onClick={onShowMore}
      >
        Show {nextCount} more
      </button>
    </li>
  );
}

function CitationSources({ citations }: { citations: ConversationCitation[] }) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CITATION_PAGE_SIZE);
  const visibleCitations = expanded ? citations.slice(0, visibleCount) : [];
  const citationKeys = citationRenderKeys(visibleCitations);
  const remaining = Math.max(0, citations.length - visibleCitations.length);
  return (
    <details
      open={expanded}
      className="mt-2 max-w-2xl rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-3 py-2 text-[length:var(--fd-text-xs)]"
    >
      <summary
        className="fd-focus flex cursor-pointer list-none items-center gap-2 text-fg-muted marker:hidden"
        onClick={(event) => {
          event.preventDefault();
          setExpanded((value) => !value);
        }}
      >
        <BookOpen aria-hidden="true" className="h-3.5 w-3.5" />
        <span>
          {citations.length} cited source{citations.length === 1 ? "" : "s"}
        </span>
      </summary>
      {expanded ? (
        <ol className="mt-2 space-y-2 border-t border-border-subtle pt-2">
          {visibleCitations.map((citation, index) => {
            const href = citationExternalUrl(citation);
            const label = citationDisplayLabel(citation, index);
            const locatorLabel = citationLocatorLabel(citation.locator);
            const excerpt = citationExcerptPreview(citation);
            return (
              <li key={citationKeys[index]} className="flex min-w-0 gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-surface-4 px-1 font-mono text-[length:var(--fd-text-2xs)] text-fg-muted"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  {href ? (
                    <a
                      className="fd-focus inline-flex max-w-full items-center gap-1.5 font-medium text-accent hover:underline"
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`Open cited source: ${label.text}`}
                    >
                      <span className="truncate">{label.text}</span>
                      <ExternalLink
                        aria-hidden="true"
                        className="h-3 w-3 shrink-0"
                      />
                    </a>
                  ) : (
                    <p className="break-words font-medium text-fg-secondary">
                      {label.text}
                    </p>
                  )}
                  {label.limited ? (
                    <p className="sr-only">
                      Source label shortened for display.
                    </p>
                  ) : null}
                  {locatorLabel ? (
                    <p className="mt-0.5 font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
                      {locatorLabel}
                    </p>
                  ) : null}
                  {excerpt ? (
                    <>
                      <blockquote className="mt-1 border-l-2 border-border-subtle pl-2 text-fg-muted">
                        {excerpt.text}
                      </blockquote>
                      {excerpt.limited ? (
                        <p className="mt-1 text-fg-muted">
                          Excerpt limited for performance.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
          <ShowMoreSources
            remaining={remaining}
            sourceKind="cited"
            onShowMore={() =>
              setVisibleCount((count) => count + CITATION_PAGE_SIZE)
            }
          />
        </ol>
      ) : null}
    </details>
  );
}

function MemoryCitationSources({
  citation,
}: {
  citation: ConversationMemoryCitation;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CITATION_PAGE_SIZE);
  const visibleEntries = expanded
    ? citation.entries.slice(0, visibleCount)
    : [];
  const remaining = Math.max(
    0,
    citation.entries.length - visibleEntries.length,
  );
  return (
    <details
      open={expanded}
      className="mt-2 max-w-2xl rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-3 py-2 text-[length:var(--fd-text-xs)]"
    >
      <summary
        className="fd-focus flex cursor-pointer list-none items-center gap-2 text-fg-muted marker:hidden"
        onClick={(event) => {
          event.preventDefault();
          setExpanded((value) => !value);
        }}
      >
        <BookOpen aria-hidden="true" className="h-3.5 w-3.5" />
        <span>
          {citation.entries.length} memory source
          {citation.entries.length === 1 ? "" : "s"}
        </span>
        {citation.thread_ids.length > 0 ? (
          <span className="ml-auto text-fg-muted">
            {citation.thread_ids.length} thread
            {citation.thread_ids.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </summary>
      {expanded ? (
        <ul className="mt-2 space-y-2 border-t border-border-subtle pt-2">
          {visibleEntries.map((entry, index) => {
            const path = citationTextPreview(
              entry.path,
              MEMORY_CITATION_PATH_MAX_CHARS,
            );
            const note = citationTextPreview(
              entry.note,
              MEMORY_CITATION_NOTE_MAX_CHARS,
            );
            return (
              <li
                key={`${entry.path}-${entry.line_start}-${entry.line_end}-${index}`}
                className="min-w-0"
              >
                <div className="flex min-w-0 items-center gap-1.5 font-mono text-fg-secondary">
                  <FileText
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-fg-faint"
                  />
                  <span className="truncate">{path.text}</span>
                  <span className="shrink-0 text-fg-muted">
                    :{entry.line_start}
                    {entry.line_end !== entry.line_start
                      ? `–${entry.line_end}`
                      : ""}
                  </span>
                </div>
                {note.text ? (
                  <p className="mt-1 break-words pl-5 text-fg-muted">
                    {note.text}
                  </p>
                ) : null}
                {path.limited || note.limited ? (
                  <p className="mt-1 pl-5 text-fg-muted">
                    Source details limited for performance.
                  </p>
                ) : null}
              </li>
            );
          })}
          <ShowMoreSources
            remaining={remaining}
            sourceKind="memory"
            onShowMore={() =>
              setVisibleCount((count) => count + CITATION_PAGE_SIZE)
            }
          />
        </ul>
      ) : null}
    </details>
  );
}

function MessageReceivedAt({ createdAt }: { createdAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const label = formatReceivedAgo(createdAt, nowMs);
  if (!label) return null;
  const receivedAt = Date.parse(createdAt);
  const absolute = Number.isFinite(receivedAt)
    ? new Date(receivedAt).toLocaleString()
    : createdAt;
  return (
    <time
      dateTime={createdAt}
      title={absolute}
      className="fd-type-meta tabular-nums text-fg-muted"
    >
      {label}
    </time>
  );
}

/** Transcript cut for a stopped turn. Interruption is expected, not a warning. */
function InterruptedResponseRule() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Response interrupted"
      className="flex items-center gap-3 py-2"
    >
      <span
        aria-hidden="true"
        className="h-px min-w-8 flex-1 bg-[linear-gradient(90deg,transparent,var(--fd-border-2)_22%,var(--fd-border-2))]"
      />
      <span
        aria-hidden="true"
        className="fd-type-eyebrow fd-type-eyebrow--sm shrink-0 text-fg-muted"
      >
        Interrupted
      </span>
      <span
        aria-hidden="true"
        className="h-px min-w-8 flex-1 bg-[linear-gradient(90deg,var(--fd-border-2),var(--fd-border-2)_78%,transparent)]"
      />
    </div>
  );
}

function AssistantMessage({
  item,
  showReceivedAt = false,
  readAloud,
}: {
  item: Extract<ConversationItem, { kind: "assistant_message" }>;
  showReceivedAt?: boolean;
  readAloud?: ReadAloudController;
}) {
  const lifecycle = contentLifecycle(item);
  const isCommentary = item.phase === "commentary";
  const memoryCitationEntries = item.memory_citation?.entries ?? [];
  const citations = item.citations ?? [];
  const failureDetail =
    lifecycle === "error" ? assistantFailureDetail(item) : null;
  const canReadAloud =
    lifecycle === "complete" && item.text.trim().length > 0 && readAloud;
  const hasText = Boolean(item.text.trim());
  const receivedAt =
    showReceivedAt && lifecycle !== "pending" && lifecycle !== "streaming" ? (
      <MessageReceivedAt createdAt={item.created_at} />
    ) : null;
  return (
    <article
      aria-label={`${isCommentary ? "Assistant progress update" : "Assistant message"}, ${lifecycle}`}
      aria-busy={lifecycle === "pending" || lifecycle === "streaming"}
      className={cn(
        "group/message min-w-0 px-1",
        isCommentary &&
          "border-l-2 border-border-subtle pl-3 text-fg-secondary",
      )}
    >
      {isCommentary ? (
        <p className="fd-type-microlabel mb-1 text-fg-muted">
          Progress update
        </p>
      ) : null}
      {lifecycle === "pending" && !item.text ? (
        <p
          role="status"
          className="text-[length:var(--fd-text-sm)] text-fg-muted"
        >
          Preparing response…
        </p>
      ) : null}
      <div
        data-message-selectable-content
        className={cn(
          "fd-type-body max-w-none break-words",
          isCommentary ? "text-fg-secondary" : "text-fg-primary",
        )}
      >
        <MessageMarkdown
          text={item.text}
          streaming={lifecycle === "pending" || lifecycle === "streaming"}
        />
      </div>
      {citations.length > 0 ? <CitationSources citations={citations} /> : null}
      {memoryCitationEntries.length > 0 && item.memory_citation ? (
        <MemoryCitationSources citation={item.memory_citation} />
      ) : null}
      {hasText || receivedAt || lifecycle === "error" ? (
        <div className="mt-1 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          {hasText || receivedAt ? (
            <span
              className={cn(
                "inline-flex items-center gap-2",
                hoverRevealActions("message"),
              )}
            >
              {hasText ? (
                <span className="inline-flex items-center gap-0.5">
                  <CopyButton
                    text={assistantMessageCopyText(
                      item.text,
                      lifecycle === "pending" || lifecycle === "streaming",
                    )}
                    label="Copy response"
                  />
                  {canReadAloud ? (
                    <button
                      type="button"
                      onClick={() =>
                        readAloud.activeMessageId === item.id
                          ? readAloud.stop()
                          : readAloud.awaitingGestureMessageId === item.id
                            ? readAloud.resume()
                            : readAloud.play(item.id, item.text)
                      }
                      disabled={readAloud.loadingMessageId != null}
                      aria-label={
                        readAloud.activeMessageId === item.id
                          ? "Stop reading response"
                          : readAloud.awaitingGestureMessageId === item.id
                            ? "Play response"
                            : "Read response aloud"
                      }
                      title={
                        readAloud.activeMessageId === item.id
                          ? "Stop reading"
                          : readAloud.awaitingGestureMessageId === item.id
                            ? "Play"
                            : "Read aloud"
                      }
                      className="fd-focus inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:cursor-wait disabled:opacity-50"
                    >
                      {readAloud.loadingMessageId === item.id ? (
                        <ActivityDiamond size="xs" tone="current" />
                      ) : readAloud.activeMessageId === item.id ? (
                        <Square aria-hidden="true" className="h-3 w-3" />
                      ) : (
                        <Volume2 aria-hidden="true" className="h-3 w-3" />
                      )}
                    </button>
                  ) : null}
                </span>
              ) : null}
              {receivedAt}
            </span>
          ) : null}
          {lifecycle === "error" ? (
            <span
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              className="inline-flex flex-wrap items-center gap-x-1 gap-y-1 text-[length:var(--fd-text-xs)] text-danger"
            >
              <CircleX aria-hidden="true" className="h-3.5 w-3.5" />
              Response failed
              {failureDetail ? (
                <span className="basis-full break-words pl-5 text-[length:var(--fd-text-sm)]">
                  {" "}
                  {failureDetail}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {lifecycle === "interrupted" ? <InterruptedResponseRule /> : null}
    </article>
  );
}

function ImageMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "image" }>;
}) {
  const lifecycle = contentLifecycle(item);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const url = item.image.url.trim();
  const safeUrl = isSafeMediaUrl(url, "image");
  const failed = url.length > 0 && failedUrl === url;
  const active = lifecycle === "pending" || lifecycle === "streaming";
  const alt =
    item.image.alt_text?.trim() ||
    item.title?.trim() ||
    item.image.name?.trim() ||
    "Agent image";
  const originalUrl = safeExternalUrl(url);
  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    window.requestAnimationFrame(() => previewTriggerRef.current?.focus());
  }, []);
  const renderedImage =
    safeUrl && !failed ? (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(url)}
        className="max-h-[32rem] w-full object-contain"
      />
    ) : null;

  return (
    <>
      <figure
        aria-label={`${alt}, ${lifecycle}`}
        aria-busy={active}
        className="min-w-0 max-w-2xl overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2"
      >
        <div
          className={cn(
            "flex items-center justify-center bg-surface-1",
            renderedImage || active ? "min-h-48" : "min-h-24",
          )}
        >
          {renderedImage ? (
            <button
              ref={previewTriggerRef}
              type="button"
              onClick={() => setPreviewOpen(true)}
              aria-label={`Preview ${alt}`}
              className="fd-focus block w-full cursor-zoom-in"
            >
              {renderedImage}
            </button>
          ) : active ? (
            <span
              role="status"
              className="inline-flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted"
            >
              <ActivityDiamond size="md" />
              Generating image…
            </span>
          ) : (
            <span
              role={lifecycle === "error" ? "alert" : "status"}
              aria-live={lifecycle === "error" ? "assertive" : "polite"}
              aria-atomic="true"
              className="inline-flex items-center gap-2 text-[length:var(--fd-text-sm)] text-danger"
            >
              <CircleX aria-hidden="true" className="h-4 w-4" />
              Image unavailable
            </span>
          )}
        </div>
        <figcaption className="flex min-h-10 items-center gap-2 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <ImageIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {item.title?.trim() || item.image.name?.trim() || "Image"}
          </span>
          {lifecycle === "interrupted" ? (
            <span className="text-warning">Interrupted</span>
          ) : null}
          {lifecycle === "error" && url && !failed ? (
            <span className="text-danger">Failed</span>
          ) : null}
          {originalUrl && renderedImage ? (
            <a
              href={originalUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open original image"
              className="fd-focus inline-flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
            >
              Open original
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          ) : null}
        </figcaption>
      </figure>
      {previewOpen && renderedImage ? (
        <ImagePreviewDialog url={url} label={alt} onClose={closePreview} />
      ) : null}
    </>
  );
}

function webSearchHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function WebSearchMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "web_search" }>;
}) {
  const lifecycle = contentLifecycle(item);
  const active = lifecycle === "pending" || lifecycle === "streaming";
  const safeUrl = safeExternalUrl(item.search.url);
  const query =
    item.search.query.trim() ||
    item.search.queries[0]?.trim() ||
    "Web research";
  const actionLabel = webSearchActionLabel(item.search.action_kind, active);

  return (
    <article
      aria-label={`${actionLabel}: ${query}, ${lifecycle}`}
      aria-busy={active}
      className="min-w-0 max-w-2xl rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {active ? (
          <ActivityDiamond size="md" className="mt-0.5" />
        ) : (
          <Search
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="fd-type-microlabel text-fg-muted">
            {actionLabel}
          </p>
          <p className="mt-0.5 break-words text-[length:var(--fd-text-sm)] text-fg-primary">
            {query}
          </p>
          {item.search.pattern ? (
            <p className="mt-1 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
              Find: {item.search.pattern}
            </p>
          ) : null}
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open source page on ${webSearchHostname(safeUrl)}`}
              className="fd-focus mt-1.5 inline-flex max-w-full items-center gap-1 text-[length:var(--fd-text-xs)] text-accent hover:underline"
            >
              <span className="truncate">{webSearchHostname(safeUrl)}</span>
              <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
            </a>
          ) : null}
          {item.search.queries.length > 1 ? (
            <details className="group/queries mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
              <summary className="fd-focus w-fit cursor-pointer select-none hover:text-fg-secondary">
                {item.search.queries.length} related queries
              </summary>
              <ul className="mt-1 space-y-1 pl-4">
                {item.search.queries.map((relatedQuery, index) => (
                  <li
                    key={`${item.search.id}-query-${index}`}
                    className="break-words"
                  >
                    {relatedQuery}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        {lifecycle === "interrupted" ? (
          <span
            role="status"
            className="shrink-0 text-[length:var(--fd-text-xs)] text-warning"
          >
            Interrupted
          </span>
        ) : lifecycle === "error" ? (
          <span
            role="alert"
            className="shrink-0 text-[length:var(--fd-text-xs)] text-danger"
          >
            Failed
          </span>
        ) : null}
      </div>
    </article>
  );
}

type ExpansionMode = "default" | "expanded" | "collapsed";

function ToolStatusIcon({
  item,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  item: Extract<ConversationItem, { kind: "tool_call" }>;
  className?: string;
}) {
  const lifecycle = toolLifecycle(item);
  switch (lifecycle) {
    case "running":
      return <ActivityDiamond className={className} />;
    case "succeeded":
      return (
        <CheckCircle2
          aria-hidden="true"
          className={cn(className, "text-success")}
        />
      );
    case "failed":
      return (
        <CircleX aria-hidden="true" className={cn(className, "text-danger")} />
      );
    case "denied":
      return (
        <Ban aria-hidden="true" className={cn(className, "text-danger")} />
      );
    case "interrupted":
      return (
        <PauseCircle
          aria-hidden="true"
          className={cn(className, "text-warning")}
        />
      );
    case "awaiting_approval":
      return (
        <Clock3 aria-hidden="true" className={cn(className, "text-warning")} />
      );
    case "queued":
      return (
        <Clock3 aria-hidden="true" className={cn(className, "text-fg-faint")} />
      );
    default:
      return (
        <Circle aria-hidden="true" className={cn(className, "text-fg-faint")} />
      );
  }
}

function ToolCallCompactRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: "tool_call" }>;
}) {
  const lifecycleLabel = toolLifecycleLabel(toolLifecycle(item));
  const label = toolCallLabel(item);
  const notable = notableToolAction(item);
  const notableStyle = notable ? NOTABLE_TOOL_STYLE[notable.kind] : null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1",
        notableStyle ? notableStyle.tone : "text-fg-muted",
      )}
      aria-label={`${label}, ${lifecycleLabel}`}
      aria-live="polite"
    >
      <ToolStatusIcon item={item} className="h-3.5 w-3.5 shrink-0" />
      {notableStyle ? (
        <notableStyle.Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      ) : null}
      <span
        className="flex-1 truncate font-mono text-[length:var(--fd-text-xs)]"
        title={item.title}
      >
        {label}
      </span>
    </div>
  );
}

function useExpansionState(
  defaultOpen: boolean,
  expansionMode: ExpansionMode,
  seed: string,
) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (expansionMode === "expanded") {
      setOpen(true);
      return;
    }
    if (expansionMode === "collapsed") {
      setOpen(false);
      return;
    }
    setOpen(defaultOpen);
  }, [defaultOpen, expansionMode, seed]);

  return [open, setOpen] as const;
}

/**
 * Work that changes something, and so earns a bordered card. Everything else —
 * reads, searches, fetches — stays a quiet one-line row.
 */
const CARD_ACTIVITY_KINDS = new Set(["edit", "diff", "command", "test"]);

const NOTABLE_TOOL_STYLE = {
  commit: {
    Icon: GitCommitHorizontal,
    tone: "text-accent",
    border: "border-accent/35",
    surface: "bg-accent/5",
  },
  push: {
    Icon: Upload,
    tone: "text-info",
    border: "border-info/35",
    surface: "bg-info/5",
  },
  breakout: {
    Icon: Split,
    tone: "text-accent",
    border: "border-accent/35",
    surface: "bg-accent/5",
  },
} as const;

function ToolCallMessage({
  item,
  defaultOpen = false,
  expansionMode = "default",
  suppressReadOnlyDetail = false,
}: {
  item: Extract<ConversationItem, { kind: "tool_call" }>;
  defaultOpen?: boolean;
  expansionMode?: ExpansionMode;
  suppressReadOnlyDetail?: boolean;
}) {
  const [open, setOpen] = useExpansionState(
    defaultOpen,
    expansionMode,
    item.id,
  );
  const openFileDiff = useOpenFileDiff();
  const hasOutput = Boolean(item.output);
  const commandDetail =
    item.detail?.kind === "command_execution" ? item.detail : null;
  const mcpDetail = item.detail?.kind === "mcp" ? item.detail : null;
  const dynamicDetail = item.detail?.kind === "dynamic" ? item.detail : null;
  const collabDetail =
    item.detail?.kind === "collab_agent" ? item.detail : null;
  const subagentDetail =
    item.detail?.kind === "subagent_activity" ? item.detail : null;
  const hookDetail = item.detail?.kind === "hook" ? item.detail : null;
  const guardianDetail =
    item.detail?.kind === "guardian_review" ? item.detail : null;
  const guardianPresentation = guardianDetail
    ? guardianReviewPresentation(guardianDetail)
    : null;
  const testSummary = item.display.test_summary ?? null;
  const mcpResultInspection = useMemo(
    () =>
      inspectMcpResult(mcpDetail?.result, item.display.provider_output_summary),
    [mcpDetail?.result, item.display.provider_output_summary],
  );
  const mcpArtifactSummary = mcpResultInspection.artifacts;
  const showGenericOutput =
    hasOutput &&
    !dynamicDetail?.content_items.some((content) => content.kind === "text") &&
    !mcpResultInspection.has_text_content;
  const hasStructuredDetail = Boolean(
    mcpDetail ||
    dynamicDetail ||
    collabDetail ||
    subagentDetail ||
    hookDetail ||
    guardianDetail ||
    testSummary ||
    (commandDetail &&
      (commandDetail.cwd ||
        commandDetail.actions.length > 0 ||
        commandDetail.duration_ms != null ||
        commandDetail.process_id ||
        commandDetail.source)),
  );
  const detailAvailable =
    (hasOutput || hasStructuredDetail) && !suppressReadOnlyDetail;
  const lifecycle = toolLifecycle(item);
  const lifecycleLabel = toolLifecycleLabel(lifecycle);
  const testBadgeLabel = testSummary ? testSummaryHeadline(testSummary) : null;

  const activityKind = item.display.activity_kind;
  const notable = notableToolAction(item);
  const notableStyle = notable ? NOTABLE_TOOL_STYLE[notable.kind] : null;
  const touchesFile = activityKind === "edit" || activityKind === "diff";
  // The header shows the file's name, so links and highlighting work from the
  // full path the label shortened away. Both come from one pass over the
  // title, keyed on it so a streaming tool's output deltas cost nothing.
  const { label, filePath, labelNamesFile } = useMemo(() => {
    const described = describeToolCall(item);
    const wantsPath = touchesFile || activityKind === "read";
    return {
      label: described.label,
      filePath: wantsPath ? (described.path ?? extractFilePath(item.title)) : null,
      labelNamesFile: described.namesPath,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the title, detail
    // and head of the output are all describeToolCall reads.
  }, [activityKind, item.title, item.output, item.detail, touchesFile]);
  // Output highlighting is only safe when the file names the language: a shell
  // command's output has nothing to do with the path that appears in it.
  const outputFilePath =
    activityKind === "read" || touchesFile ? filePath : null;

  // You cannot hide what you are being asked to approve, so a pending
  // confirmation is forced open and its toggle is disabled. The normalized
  // lifecycle already folds the explicit awaiting statuses and an
  // approval-flavoured call that is still in flight.
  const awaitingConfirmation = lifecycle === "awaiting_approval";
  const asCard =
    awaitingConfirmation ||
    CARD_ACTIVITY_KINDS.has(activityKind) ||
    mcpArtifactSummary.total > 0 ||
    Boolean(notable);
  const effectiveOpen = awaitingConfirmation ? true : open;

  const detail = detailAvailable ? (
    <div className="space-y-2">
      {testSummary ? <TestRunSummary summary={testSummary} /> : null}
      {commandDetail && hasStructuredDetail ? (
        <div className="space-y-1 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {commandDetail.cwd ? (
              <span
                className="min-w-0 truncate font-mono"
                title={commandDetail.cwd}
              >
                cwd: {commandDetail.cwd}
              </span>
            ) : null}
            {commandDetail.duration_ms != null ? (
              <span className="tabular-nums">
                {Math.max(1, Math.round(commandDetail.duration_ms))} ms
              </span>
            ) : null}
            {commandDetail.source && commandDetail.source !== "agent" ? (
              <span>{commandDetail.source}</span>
            ) : null}
          </div>
          {commandDetail.actions.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {commandDetail.actions.map((action, index) => (
                <span
                  key={`${action.action_kind}-${action.command}-${index}`}
                  className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-fg-secondary"
                  title={action.command}
                >
                  {action.action_kind
                    .replace(/([a-z])([A-Z])/g, "$1 $2")
                    .replace(/_/g, " ")}
                  {action.path ? ` · ${fileBaseName(action.path)}` : ""}
                  {action.query ? ` · ${action.query}` : ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {mcpDetail ? (
        <div className="space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>{mcpDetail.app_context?.app_name || mcpDetail.server}</span>
            <span className="font-mono">{mcpDetail.tool}</span>
            {mcpDetail.duration_ms != null ? (
              <span>{Math.max(1, Math.round(mcpDetail.duration_ms))} ms</span>
            ) : null}
          </div>
          {mcpDetail.error ? (
            <p role="alert" className="text-danger">
              {mcpDetail.error}
            </p>
          ) : null}
          <McpResultContent value={mcpDetail.result} tool={mcpDetail.tool} />
          <StructuredJsonDisclosure
            label="Arguments"
            value={mcpDetail.arguments}
            resetKey={item.id}
          />
        </div>
      ) : null}
      {dynamicDetail ? (
        <div className="space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {dynamicDetail.namespace ? (
              <span>{dynamicDetail.namespace}</span>
            ) : null}
            <span className="font-mono">{dynamicDetail.tool}</span>
            {dynamicDetail.duration_ms != null ? (
              <span>
                {Math.max(1, Math.round(dynamicDetail.duration_ms))} ms
              </span>
            ) : null}
          </div>
          {dynamicDetail.content_items.map((content, index) =>
            content.kind === "text" ? (
              <CodeBlock
                key={`text-${index}`}
                code={content.text}
                language={null}
                previewLines={12}
              />
            ) : (
              <ProviderToolImage
                key={`image-${index}`}
                url={content.url}
                label={`${dynamicDetail.tool} output ${index + 1}`}
              />
            ),
          )}
          <StructuredJsonDisclosure
            label="Arguments"
            value={dynamicDetail.arguments}
            resetKey={item.id}
          />
        </div>
      ) : null}
      {collabDetail ? (
        <div className="space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <div className="flex flex-wrap gap-1.5">
            {collabDetail.model ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-fg-secondary">
                {collabDetail.model}
              </span>
            ) : null}
            {collabDetail.reasoning_effort ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-fg-secondary">
                {collabDetail.reasoning_effort} effort
              </span>
            ) : null}
            <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-fg-secondary">
              {collabDetail.receiver_thread_ids.length}{" "}
              {collabDetail.receiver_thread_ids.length === 1
                ? "agent"
                : "agents"}
            </span>
          </div>
          {collabDetail.prompt ? (
            <CodeBlock code={collabDetail.prompt} language={null} />
          ) : null}
          {Object.entries(collabDetail.agent_states).length > 0 ? (
            <ul className="space-y-1" aria-label="Sub-agent states">
              {Object.entries(collabDetail.agent_states).map(
                ([threadId, state]) => (
                  <li
                    key={threadId}
                    className="flex min-w-0 items-start gap-2 rounded-[var(--fd-radius-sm)] bg-surface-1 px-2 py-1.5"
                  >
                    <span className="shrink-0 font-medium text-fg-secondary">
                      {agentStatusLabel(state.status)}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      {state.message || compactThreadId(threadId)}
                    </span>
                    {state.message ? (
                      <span
                        className="shrink-0 font-mono text-[length:var(--fd-text-2xs)] text-fg-muted"
                        title={threadId}
                      >
                        {compactThreadId(threadId)}
                      </span>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          ) : collabDetail.receiver_thread_ids.length > 0 ? (
            <p className="break-all font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
              {collabDetail.receiver_thread_ids.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {subagentDetail ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <span className="font-medium text-fg-secondary">
            {agentStatusLabel(subagentDetail.activity)}
          </span>
          <span>{subagentDetail.agent_path}</span>
          <span
            className="font-mono text-[length:var(--fd-text-2xs)] text-fg-muted"
            title={subagentDetail.agent_thread_id}
          >
            {compactThreadId(subagentDetail.agent_thread_id)}
          </span>
        </div>
      ) : null}
      {hookDetail ? (
        <div className="space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
              {hookDetail.handler_type}
            </span>
            <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
              {hookDetail.execution_mode}
            </span>
            <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
              {hookDetail.scope}
            </span>
            {hookDetail.duration_ms != null ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
                {Math.max(1, Math.round(hookDetail.duration_ms))} ms
              </span>
            ) : null}
          </div>
          <p className="break-all font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
            {hookDetail.source_path}
          </p>
          {hookDetail.status_message ? (
            <p className="text-fg-secondary">{hookDetail.status_message}</p>
          ) : null}
          {hookDetail.entries.map((entry, index) => {
            const urgent =
              entry.entry_kind === "warning" ||
              entry.entry_kind === "error" ||
              entry.entry_kind === "stop";
            return (
              <div
                key={`${entry.entry_kind}-${index}`}
                role={urgent ? "alert" : undefined}
                className={cn(
                  "rounded-[var(--fd-radius-sm)] border border-border-subtle bg-surface-1 px-2 py-1.5",
                  entry.entry_kind === "warning" &&
                    "border-warning/30 text-warning",
                  (entry.entry_kind === "error" ||
                    entry.entry_kind === "stop") &&
                    "border-danger/30 text-danger",
                )}
              >
                <p className="mb-0.5 font-medium">
                  {agentStatusLabel(entry.entry_kind)}
                </p>
                <p className="whitespace-pre-wrap text-fg-secondary">
                  {entry.text}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
      {guardianDetail ? (
        <div
          role={
            guardianPresentation?.urgent
              ? "alert"
              : guardianPresentation?.active
                ? "status"
                : undefined
          }
          className={cn(
            "space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted",
            guardianPresentation?.urgent && "border-danger/30",
            guardianDetail.risk_level === "high" && "border-warning/30",
          )}
        >
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
              {guardianPresentation?.statusLabel}
            </span>
            <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
              Action: {guardianPresentation?.actionKindLabel}
            </span>
            {guardianDetail.risk_level ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
                {agentStatusLabel(guardianDetail.risk_level)} risk
              </span>
            ) : null}
            {guardianDetail.user_authorization ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
                {agentStatusLabel(guardianDetail.user_authorization)}{" "}
                authorization
              </span>
            ) : null}
            {guardianDetail.duration_ms != null ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
                {Math.max(1, Math.round(guardianDetail.duration_ms))} ms
              </span>
            ) : null}
            {guardianPresentation?.decisionSourceLabel ? (
              <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5">
                Decision: {guardianPresentation.decisionSourceLabel}
              </span>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap break-words font-mono text-fg-secondary">
            {guardianDetail.action}
          </p>
          {guardianDetail.cwd ? (
            <p className="break-all font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
              cwd: {guardianDetail.cwd}
            </p>
          ) : null}
          {guardianDetail.target_item_id ? (
            <p className="break-all font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
              target: {guardianDetail.target_item_id}
            </p>
          ) : null}
          {guardianDetail.rationale ? (
            <div className="rounded-[var(--fd-radius-sm)] bg-surface-1 px-2 py-1.5">
              <p className="mb-0.5 font-medium text-fg-secondary">
                Review rationale
              </p>
              <p className="whitespace-pre-wrap">{guardianDetail.rationale}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {showGenericOutput ? (
        <CodeBlock
          code={item.output ?? ""}
          language={null}
          filePath={outputFilePath}
        />
      ) : null}
    </div>
  ) : suppressReadOnlyDetail && (hasOutput || hasStructuredDetail) ? (
    <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
      Read-only tool details hidden by preference.
    </p>
  ) : null;

  const fileLink =
    openFileDiff && touchesFile && filePath ? (
      // Sibling of the trigger, not a child: a nested button would be invalid
      // markup and would swallow the toggle.
      <span className="flex shrink-0 items-center gap-1 text-fg-muted">
        <FileDiff aria-hidden="true" className="h-3 w-3" />
        <FileDiffLink
          filePath={filePath}
          // The header already names the file, so repeating it here would spend
          // the row on the same word twice.
          label={labelNamesFile ? "Diff" : fileBaseName(filePath)}
          className="max-w-40 truncate font-mono text-[length:var(--fd-text-2xs)] text-fg-tertiary"
        />
      </span>
    ) : null;

  const headerContent = (
    <>
      <ToolStatusIcon item={item} />
      {notableStyle ? (
        <notableStyle.Icon
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 shrink-0", notableStyle.tone)}
        />
      ) : null}
      <span
        className={cn(
          "flex-1 truncate font-mono text-[length:var(--fd-text-xs)]",
          notableStyle && notableStyle.tone,
          (lifecycle === "failed" || lifecycle === "denied") && "text-danger",
        )}
        // The shortened label keeps the row readable; the hover keeps the
        // whole path recoverable.
        title={item.title}
      >
        {label}
      </span>
      {awaitingConfirmation ? (
        <span className="shrink-0 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-warning">
          Awaiting approval
        </span>
      ) : (
        <>
          {testSummary ? (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[length:var(--fd-text-2xs)] font-medium tabular-nums",
                (testSummary.failed ?? 0) > 0
                  ? "bg-danger/10 text-danger"
                  : "bg-success/10 text-success",
              )}
            >
              {testSummaryHeadline(testSummary)}
            </span>
          ) : null}
          {mcpArtifactSummary.total > 0 ? (
            <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[length:var(--fd-text-2xs)] font-medium text-accent">
              {mcpArtifactSummary.total} artifact
              {mcpArtifactSummary.total === 1 ? "" : "s"}
            </span>
          ) : null}
          {detailAvailable ? (
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3 w-3 shrink-0 transition-[transform,opacity] duration-[var(--fd-duration-fast)]",
                open && "rotate-90",
                !asCard &&
                  !open &&
                  "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
              )}
            />
          ) : null}
        </>
      )}
    </>
  );

  return (
    <Collapsible.Root
      open={effectiveOpen}
      onOpenChange={awaitingConfirmation ? undefined : setOpen}
    >
      <div
        // The tier is the contract these cards are built around, so it is
        // stated once here rather than inferred from styling.
        data-tool-tier={
          awaitingConfirmation ? "confirm" : asCard ? "card" : "row"
        }
        data-tool-action={notable?.kind}
        className={cn(
          "group",
          asCard &&
            "overflow-hidden rounded-[var(--fd-radius-lg)] border bg-surface-1",
          asCard &&
            (awaitingConfirmation
              ? "border-warning/40"
              : notableStyle
                ? cn(notableStyle.border, notableStyle.surface)
                : "border-border-subtle"),
        )}
      >
        <div
          className={cn(
            "flex w-full items-center gap-1 pr-2 transition-colors duration-[var(--fd-duration-fast)]",
            asCard
              ? "bg-surface-2/40"
              : "rounded-[var(--fd-radius-md)] hover:bg-surface-2",
          )}
        >
          {detailAvailable ? (
            <Collapsible.Trigger asChild disabled={awaitingConfirmation}>
              <button
                type="button"
                aria-live="polite"
                aria-expanded={effectiveOpen}
                aria-label={`Toggle ${label} details, ${lifecycleLabel}${testBadgeLabel ? `, ${testBadgeLabel}` : ""}`}
                disabled={awaitingConfirmation}
                className={cn(
                  "fd-focus flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-fg-muted",
                  awaitingConfirmation && "cursor-default",
                )}
              >
                {headerContent}
              </button>
            </Collapsible.Trigger>
          ) : (
            <div
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-fg-muted"
              aria-label={`${label}, ${lifecycleLabel}${testBadgeLabel ? `, ${testBadgeLabel}` : ""}`}
              aria-live="polite"
            >
              {headerContent}
            </div>
          )}
          {fileLink}
        </div>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
          {detail ? (
            <div className={asCard ? "px-2 pt-1 pb-2" : "mt-1 ml-6"}>
              {detail}
            </div>
          ) : null}
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function testSummaryHeadline(summary: ToolTestSummary) {
  if ((summary.failed ?? 0) > 0) return `${summary.failed} failed`;
  if (summary.passed != null) return `${summary.passed} passed`;
  if (summary.total != null)
    return `${summary.total} test${summary.total === 1 ? "" : "s"}`;
  return summary.framework
    ? agentStatusLabel(summary.framework)
    : "Test results";
}

function TestRunSummary({ summary }: { summary: ToolTestSummary }) {
  const facts = [
    summary.passed != null ? `${summary.passed} passed` : null,
    summary.failed != null ? `${summary.failed} failed` : null,
    summary.skipped != null ? `${summary.skipped} skipped` : null,
    summary.suites_passed != null
      ? `${summary.suites_passed} suite${summary.suites_passed === 1 ? "" : "s"} passed`
      : null,
    summary.suites_failed != null
      ? `${summary.suites_failed} suite${summary.suites_failed === 1 ? "" : "s"} failed`
      : null,
    summary.suites_passed == null &&
    summary.suites_failed == null &&
    summary.suites_total != null
      ? `${summary.suites_total} suite${summary.suites_total === 1 ? "" : "s"}`
      : null,
    summary.duration_ms != null ? formatDurationMs(summary.duration_ms) : null,
  ].filter((fact): fact is string => fact != null);
  const label = [
    "Test results",
    summary.framework ? agentStatusLabel(summary.framework) : null,
    ...facts,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <section
      aria-label={label}
      className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2/50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--fd-text-xs)]">
        <span className="font-medium text-fg-secondary">Test results</span>
        {summary.framework ? (
          <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-fg-secondary">
            {agentStatusLabel(summary.framework)}
          </span>
        ) : null}
        {facts.map((fact) => (
          <span
            key={fact}
            className={cn(
              "rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 tabular-nums text-fg-secondary",
              fact.endsWith("failed") &&
                (summary.failed ?? 0) > 0 &&
                "bg-danger/10 text-danger",
            )}
          >
            {fact}
          </span>
        ))}
      </div>
    </section>
  );
}

function compactThreadId(threadId: string) {
  return threadId.length > 14 ? `…${threadId.slice(-10)}` : threadId;
}

function agentStatusLabel(status: string) {
  return status
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function McpResultContent({ value, tool }: { value: unknown; tool: string }) {
  const result = parseMcpResult(value);
  const artifactSummary = summarizeParsedMcpArtifacts(result);
  return (
    <div className="space-y-2">
      {artifactSummary.total > 0 ? (
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2">
          <p className="font-medium text-fg-secondary">Provider artifacts</p>
          <span className="text-fg-muted">
            {artifactSummary.total} item{artifactSummary.total === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
      {result.content.map((content, index) => {
        if (content.kind === "text") {
          return (
            <CodeBlock
              key={`text-${index}`}
              code={content.text}
              language={null}
              previewLines={12}
            />
          );
        }
        if (content.kind === "image") {
          return (
            <ProviderToolImage
              key={`image-${index}`}
              url={content.url}
              label={content.alt_text || `${tool} output ${index + 1}`}
              fallbackValue={content}
            />
          );
        }
        if (content.kind === "audio") {
          return isSafeMediaUrl(content.url, "audio") ? (
            <audio
              key={`audio-${index}`}
              controls
              preload="metadata"
              className="w-full"
              aria-label={`${tool} audio output ${index + 1}`}
            >
              <source src={content.url} type={content.mime_type} />
            </audio>
          ) : (
            <StructuredJson
              key={`audio-${index}`}
              label={`Audio output ${index + 1}`}
              value={content}
            />
          );
        }
        if (content.kind === "resource_link") {
          const size = formatArtifactSize(content.size);
          return (
            <article
              key={`link-${index}`}
              aria-label={`Provider reference: ${content.title || content.name}`}
              className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-3"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-fg-secondary">
                    {content.title || content.name}
                  </p>
                  <p className="fd-type-microlabel mt-0.5 text-fg-muted">
                    Reference
                    {content.mime_type ? ` · ${content.mime_type}` : ""}
                    {size ? ` · ${size}` : ""}
                  </p>
                </div>
                {isSafeExternalUrl(content.uri) ? (
                  <a
                    className="fd-focus inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 font-medium text-accent hover:bg-accent/10"
                    href={content.uri}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open ${content.title || content.name}`}
                  >
                    Open
                    <ExternalLink aria-hidden="true" className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              {content.description ? (
                <p className="mt-1 text-fg-tertiary">{content.description}</p>
              ) : null}
              <p className="mt-1 break-all font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
                {content.uri}
              </p>
            </article>
          );
        }
        if (content.kind === "resource") {
          const filename = resourceFilename(content.uri, index);
          const size = formatArtifactSize(content.byte_size);
          const downloadFilename = safeArtifactFilename(filename);
          const downloadUrl =
            content.blob_url ??
            (content.text != null
              ? `data:${safeArtifactMimeType(content.mime_type) ?? "text/plain"};charset=utf-8,${encodeURIComponent(content.text)}`
              : null);
          return (
            <article
              key={`resource-${index}`}
              aria-label={`Embedded artifact: ${filename}`}
              className="space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-3"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate font-medium text-fg-secondary"
                    title={filename}
                  >
                    {filename}
                  </p>
                  <p className="fd-type-microlabel mt-0.5 text-fg-muted">
                    Embedded artifact
                    {content.mime_type ? ` · ${content.mime_type}` : ""}
                    {size ? ` · ${size}` : ""}
                  </p>
                </div>
                {downloadUrl ? (
                  <a
                    className="fd-focus inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 font-medium text-accent hover:bg-accent/10"
                    href={downloadUrl}
                    download={downloadFilename}
                    aria-label={`Download ${filename}`}
                  >
                    Download
                    <Download aria-hidden="true" className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              <p className="break-all font-mono text-[length:var(--fd-text-2xs)] text-fg-muted">
                {content.uri}
              </p>
              {content.text != null ? (
                <ArtifactTextPreview
                  filename={filename}
                  mimeType={content.mime_type}
                  text={content.text}
                />
              ) : null}
              {content.text == null && !downloadUrl ? (
                <p className="text-fg-muted">
                  The provider supplied resource metadata without readable
                  content.
                </p>
              ) : null}
              {content.metadata != null ? (
                <StructuredJson
                  label="Resource metadata"
                  value={content.metadata}
                />
              ) : null}
            </article>
          );
        }
        return (
          <StructuredJson
            key={`unknown-${index}`}
            label={`Provider output ${index + 1}`}
            value={content.value}
          />
        );
      })}
      {result.structured_content != null ? (
        <StructuredJson
          label="Structured result"
          value={result.structured_content}
        />
      ) : null}
      {result.extra != null ? (
        <StructuredJson label="Result metadata" value={result.extra} />
      ) : null}
      {result.metadata != null ? (
        <StructuredJson label="Provider metadata" value={result.metadata} />
      ) : null}
    </div>
  );
}

function ProviderToolImage({
  url,
  label,
  fallbackValue = { url },
}: {
  url: string;
  label: string;
  fallbackValue?: unknown;
}) {
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  if (!isSafeMediaUrl(url, "image")) {
    return (
      <StructuredJson label={`${label} · unavailable`} value={fallbackValue} />
    );
  }
  if (failed) {
    return (
      <div
        role="status"
        aria-label={`${label}, unavailable`}
        className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted"
      >
        Image unavailable
      </div>
    );
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPreviewOpen(true)}
        aria-label={`Preview ${label}`}
        className="fd-focus group/provider-image block max-w-full cursor-zoom-in overflow-hidden rounded-[var(--fd-radius-md)] bg-surface-1"
      >
        <img
          src={url}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => {
            setFailed(true);
            setPreviewOpen(false);
          }}
          className="max-h-80 max-w-full object-contain transition-transform group-hover/provider-image:scale-[1.01]"
        />
      </button>
      {previewOpen ? (
        <ImagePreviewDialog url={url} label={label} onClose={closePreview} />
      ) : null}
    </>
  );
}

function ArtifactTextPreview({
  filename,
  mimeType,
  text,
}: {
  filename: string;
  mimeType: string | null;
  text: string;
}) {
  const normalizedMime = mimeType?.toLowerCase() ?? "";
  if (
    normalizedMime.includes("json") ||
    filename.toLowerCase().endsWith(".json")
  ) {
    try {
      return <StructuredJson label="Preview" value={JSON.parse(text)} />;
    } catch {
      // Preserve malformed provider text as source below.
    }
  }
  if (
    normalizedMime === "text/markdown" ||
    normalizedMime === "text/x-markdown" ||
    /\.md(?:own)?$/i.test(filename)
  ) {
    return (
      <div className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-3 text-[length:var(--fd-text-sm)]">
        <MessageMarkdown text={text} interpretDirectives={false} />
      </div>
    );
  }
  return (
    <CodeBlock
      code={text}
      language={artifactLanguage(filename, normalizedMime)}
      filePath={filename}
    />
  );
}

function artifactLanguage(filename: string, mimeType: string): string | null {
  if (mimeType.includes("json") || filename.toLowerCase().endsWith(".json"))
    return "json";
  if (mimeType.includes("csv") || filename.toLowerCase().endsWith(".csv"))
    return "csv";
  if (mimeType.includes("html") || filename.toLowerCase().endsWith(".html"))
    return "html";
  if (mimeType.includes("xml") || filename.toLowerCase().endsWith(".xml"))
    return "xml";
  if (mimeType.includes("javascript") || /\.[cm]?js$/i.test(filename))
    return "javascript";
  if (mimeType.includes("typescript") || /\.[cm]?tsx?$/i.test(filename))
    return "typescript";
  if (mimeType.includes("python") || filename.toLowerCase().endsWith(".py"))
    return "python";
  return null;
}

function resourceFilename(uri: string, index: number) {
  const raw = uri.split(/[?#]/, 1)[0]?.replace(/\/$/, "").split("/").at(-1);
  if (!raw) return `resource-${index + 1}`;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function StructuredJson({ label, value }: { label: string; value: unknown }) {
  const inspection = useMemo(() => formatInspectableValue(value), [value]);
  return (
    <div className="space-y-1">
      <p className="font-medium text-fg-tertiary">{label}</p>
      <CodeBlock
        code={inspection.text}
        language="json"
        previewLines={12}
        highlight={false}
      />
      {inspection.truncated ? (
        <p className="fd-type-readout text-fg-muted">
          Display limited for performance and safety.
        </p>
      ) : null}
    </div>
  );
}

function StructuredJsonDisclosure({
  label,
  value,
  resetKey,
}: {
  label: string;
  value: unknown;
  resetKey: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => inspectableValueSummary(value), [value]);

  useEffect(() => setOpen(false), [resetKey]);

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="rounded-[var(--fd-radius-sm)] bg-surface-2"
    >
      <Collapsible.Trigger
        className="fd-focus flex min-h-9 w-full items-center gap-2 rounded-[var(--fd-radius-sm)] px-2 py-1.5 text-left hover:bg-surface-3"
        aria-label={`${open ? "Hide" : "Show"} ${label.toLowerCase()}, ${summary}`}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium text-fg-tertiary">{label}</span>
        <span className="ml-auto text-fg-muted">{summary}</span>
      </Collapsible.Trigger>
      {open ? (
        <Collapsible.Content className="px-2 pb-2 pt-1">
          <StructuredJson label={`${label} detail`} value={value} />
        </Collapsible.Content>
      ) : null}
    </Collapsible.Root>
  );
}

/** Height of the `preview` excerpt before the fade takes over. */
const REASONING_PREVIEW_MAX_HEIGHT_PX = 88;

/** Shared geometry for the transcript's live status rows: the standalone
    "Thinking…"/"Sending…" indicator, a streaming thought's header, and a
    running work session's header. All three say the same thing about the same
    turn and trade places as the turn moves, so any drift in gap, diamond size,
    or padding reads as the row twitching. Keep them on one class. */
export const AGENT_STATUS_ROW_CLASS =
  "flex max-w-full items-center gap-1.5 py-1 text-[length:var(--fd-text-sm)] text-fg-muted";

function ReasoningMessage({
  item,
  thinkingDisplay = "auto",
  streaming = false,
}: {
  item: Extract<ConversationItem, { kind: "reasoning" }>;
  thinkingDisplay?: ThinkingDisplay;
  streaming?: boolean;
}) {
  const lifecycle = contentLifecycle(item);
  const activelyStreaming =
    streaming || lifecycle === "pending" || lifecycle === "streaming";
  // `null` means "still following the preference". A click pins the state so
  // that a thought the reader opened does not slam shut the moment it stops
  // streaming — Zed's rule, and the reason `auto` cannot be plain derived state.
  const [override, setOverride] = useState<boolean | null>(null);

  useEffect(() => {
    setOverride(null);
  }, [item.id, thinkingDisplay]);

  const open =
    override ??
    (thinkingDisplay === "always_expanded"
      ? true
      : thinkingDisplay === "auto"
        ? activelyStreaming
        : false);
  // Preview keeps the excerpt on screen when closed; the other modes hide the
  // body entirely, so only preview renders content in the closed state.
  const showPreview = thinkingDisplay === "preview" && !open;
  const summary = item.summary?.trim();
  const label = activelyStreaming
    ? "Thinking…"
    : lifecycle === "interrupted"
      ? "Thought interrupted"
      : lifecycle === "error"
        ? "Thought failed"
        : summary || "Thought";
  const durationLabel =
    !activelyStreaming && item.duration_ms != null
      ? formatDurationMs(item.duration_ms)
      : null;
  const hasBody = item.content.trim().length > 0;
  const headerContent = (
    <>
      {activelyStreaming ? (
        <ActivityDiamond />
      ) : lifecycle === "interrupted" ? (
        <PauseCircle
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-warning"
        />
      ) : lifecycle === "error" ? (
        <CircleX
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-danger"
        />
      ) : null}
      <span className="min-w-0 truncate font-medium">{label}</span>
      {durationLabel ? (
        <span
          aria-hidden={hasBody || undefined}
          className="fd-type-meta shrink-0 text-fg-muted"
        >
          · {durationLabel}
        </span>
      ) : null}
      {hasBody ? (
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      ) : null}
    </>
  );
  const headerClassName = cn(
    AGENT_STATUS_ROW_CLASS,
    "rounded-[var(--fd-radius-sm)] text-left",
  );
  const ariaLive =
    lifecycle === "error"
      ? "assertive"
      : lifecycle === "interrupted"
        ? "polite"
        : undefined;
  const ariaLabel = durationLabel ? `${label}, ${durationLabel}` : label;

  return (
    <div className="min-w-0">
      {hasBody ? (
        <button
          type="button"
          onClick={() => setOverride(!open)}
          aria-expanded={open}
          aria-live={ariaLive}
          aria-atomic={ariaLive ? "true" : undefined}
          aria-label={ariaLabel}
          className={cn(
            "fd-focus transition-colors hover:text-fg-secondary",
            headerClassName,
          )}
        >
          {headerContent}
        </button>
      ) : (
        <div
          aria-live={ariaLive}
          aria-atomic={ariaLive ? "true" : undefined}
          className={headerClassName}
        >
          {headerContent}
        </div>
      )}
      {hasBody && (open || showPreview) ? (
        <div
          // The rule hangs from the thought's text rather than the whole
          // block: a header-only row (the live "Thinking…" state) then sits on
          // the same column as the standalone indicator it hands off to,
          // instead of jumping right and growing a rule for a beat.
          className={cn(
            "relative mt-1 border-l-2 border-border-subtle pl-3",
            showPreview && "overflow-hidden",
          )}
          style={
            showPreview
              ? { maxHeight: REASONING_PREVIEW_MAX_HEIGHT_PX }
              : undefined
          }
        >
          <div className="max-w-none break-words text-[length:var(--fd-text-sm)] text-fg-tertiary">
            <MessageMarkdown
              text={item.content}
              streaming={activelyStreaming}
              interpretDirectives={false}
            />
          </div>
          {showPreview ? (
            <button
              type="button"
              onClick={() => setOverride(true)}
              aria-label="Show the full thought"
              className="fd-focus absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-1 to-transparent"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlanMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "plan" }>;
}) {
  return (
    <section
      className="px-1"
      aria-label={`Plan, ${item.plan.steps.length} steps`}
    >
      <h3 className="text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary">
        Plan
      </h3>
      {item.plan.explanation ? (
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
          {item.plan.explanation}
        </p>
      ) : null}
      <PlanStepList steps={item.plan.steps} className="mt-2" />
    </section>
  );
}

function DiffMessage({
  item,
  defaultOpen = false,
  expansionMode = "default",
}: {
  item: Extract<ConversationItem, { kind: "diff" }>;
  defaultOpen?: boolean;
  expansionMode?: ExpansionMode;
}) {
  const [open, setOpen] = useExpansionState(
    defaultOpen,
    expansionMode,
    item.id,
  );
  const parsed = useParsedDiff(item.diff);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <span className="flex-1 text-[length:var(--fd-text-xs)] font-medium text-fg-tertiary">
            Patch
          </span>
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-fg-muted transition-transform duration-[var(--fd-duration-fast)]",
              open && "rotate-90",
            )}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {parsed.status === "unparsed" ? (
          <CodeBlock code={item.diff} language="diff" />
        ) : (
          <DiffBlock diff={item.diff} parsed={parsed} title="Patch" />
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function FileChangeDiff({
  change,
}: {
  change: Extract<ConversationItem, { kind: "file_change" }>["changes"][number];
}) {
  const parsed = useParsedDiff(change.diff);
  if (!change.diff.trim()) return null;
  return parsed.status === "unparsed" ? (
    <CodeBlock
      code={change.diff}
      language="diff"
      filePath={change.move_path ?? change.path}
    />
  ) : (
    <DiffBlock
      diff={change.diff}
      parsed={parsed}
      title={change.move_path ?? change.path}
      filePath={change.move_path ?? change.path}
    />
  );
}

function fileChangeKindLabel(
  change: Extract<ConversationItem, { kind: "file_change" }>["changes"][number],
) {
  if (change.move_path) return "Renamed";
  switch (change.change_kind.toLowerCase()) {
    case "add":
      return "Added";
    case "delete":
      return "Deleted";
    case "update":
      return "Updated";
    default:
      return change.change_kind || "Changed";
  }
}

function FileChangeMessage({
  item,
  defaultOpen = false,
  expansionMode = "default",
}: {
  item: Extract<ConversationItem, { kind: "file_change" }>;
  defaultOpen?: boolean;
  expansionMode?: ExpansionMode;
}) {
  const lifecycle = fileChangeLifecycle(item);
  const lifecycleLabel = toolLifecycleLabel(lifecycle);
  const [open, setOpen] = useExpansionState(
    defaultOpen,
    expansionMode,
    item.id,
  );
  const count = item.changes.length;
  const onlyChange = count === 1 ? item.changes[0] : null;
  const label = onlyChange
    ? `${fileChangeKindLabel(onlyChange)} ${fileBaseName(onlyChange.path)}`
    : count > 0
      ? `${count} files changed`
      : lifecycle === "running" || lifecycle === "queued"
        ? "Preparing file changes…"
        : "File change";
  const StatusIcon =
    lifecycle === "failed" || lifecycle === "denied"
      ? CircleX
      : lifecycle === "interrupted"
        ? PauseCircle
        : CheckCircle2;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1">
        <Collapsible.Trigger asChild disabled={count === 0}>
          <button
            type="button"
            disabled={count === 0}
            aria-expanded={count > 0 ? open : undefined}
            aria-label={`${label}, ${lifecycleLabel}`}
            className="fd-focus flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left"
          >
            {lifecycle === "running" || lifecycle === "queued" ? (
              <ActivityDiamond />
            ) : (
              <StatusIcon
                aria-hidden="true"
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  lifecycle === "succeeded" && "text-success",
                  (lifecycle === "failed" || lifecycle === "denied") &&
                    "text-danger",
                  lifecycle === "interrupted" && "text-warning",
                )}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-fg-secondary">
              {label}
            </span>
            <span className="text-[length:var(--fd-text-2xs)] text-fg-muted">
              {lifecycleLabel}
            </span>
            {count > 0 ? (
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "h-3 w-3 shrink-0 text-fg-muted transition-transform duration-[var(--fd-duration-fast)]",
                  open && "rotate-90",
                )}
              />
            ) : null}
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
          <div className="space-y-3 border-t border-border-subtle p-2">
            {item.changes.map((change, index) => (
              <section key={`${change.path}-${index}`} className="space-y-1.5">
                <div className="flex min-w-0 items-center gap-2 px-1 text-[length:var(--fd-text-xs)]">
                  <FileDiff
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-fg-muted"
                  />
                  {change.move_path ? (
                    <>
                      <span className="min-w-0 truncate font-mono text-fg-secondary">
                        {change.path}
                      </span>
                      <span
                        aria-hidden="true"
                        className="shrink-0 text-fg-muted"
                      >
                        →
                      </span>
                      <FileDiffLink
                        filePath={change.move_path}
                        className="min-w-0 truncate font-mono text-fg-secondary"
                      />
                    </>
                  ) : (
                    <FileDiffLink
                      filePath={change.path}
                      className="min-w-0 truncate font-mono text-fg-secondary"
                    />
                  )}
                  <span className="ml-auto shrink-0 uppercase tracking-widest text-fg-muted">
                    {fileChangeKindLabel(change)}
                  </span>
                </div>
                <FileChangeDiff change={change} />
              </section>
            ))}
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function ToolSummaryMessage({
  summary,
  items,
  defaultOpen = false,
  expansionMode = "default",
  suppressReadOnlyDetail = false,
}: {
  summary: ToolActivitySummary;
  items: Extract<ConversationItem, { kind: "tool_call" }>[];
  defaultOpen?: boolean;
  expansionMode?: ExpansionMode;
  suppressReadOnlyDetail?: boolean;
}) {
  const [open, setOpen] = useExpansionState(
    defaultOpen,
    expansionMode,
    items[0]?.id ?? "tool-summary",
  );

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-3 py-2 text-left transition-colors hover:bg-surface-2"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
              {summary.title}
            </p>
            <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
              {summary.subtitle ||
                summary.summary_hint ||
                "Grouped tool activity"}
            </p>
          </div>
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-fg-muted transition-transform duration-[var(--fd-duration-fast)]",
              open && "rotate-90",
            )}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="space-y-1 overflow-hidden pt-2 data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {items.map((item) => (
          <ToolCallMessage
            key={item.id}
            item={item}
            defaultOpen={defaultOpen}
            expansionMode={expansionMode}
            suppressReadOnlyDetail={suppressReadOnlyDetail}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function InteractiveRequestMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "interactive_request" }>;
}) {
  // Unresolved requests live in the pinned approval bar, not the transcript.
  if (!item.resolved) return null;
  // A resolved approval is history: it needs a quiet one-line receipt, not a
  // warning-coloured card with a raw JSON body. The detail stays one click
  // away for anyone auditing what was approved.
  return <ResolvedInteractiveRequestRow item={item} />;
}

function ResolvedInteractiveRequestRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: "interactive_request" }>;
}) {
  const [open, setOpen] = useState(false);
  const request = item.request;
  const receipt = interactiveRequestReceiptPresentation(
    request,
    item.resolution,
  );
  const evidence = interactiveRequestEvidencePresentation(request);
  const evidenceUrl = safeExternalUrl(evidence.path);
  const hasDetail = Boolean(
    evidence.command ||
    evidence.path ||
    evidence.detail ||
    evidence.questions.length,
  );

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild disabled={!hasDetail}>
        <button
          type="button"
          aria-expanded={open}
          disabled={!hasDetail}
          className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-2 disabled:hover:bg-transparent"
        >
          <InteractiveRequestReceiptIcon tone={receipt.tone} />
          <span className="shrink-0 text-[length:var(--fd-text-xs)]">
            {receipt.label}
          </span>
          {evidence.summary ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-tertiary">
              {evidence.summary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {hasDetail ? (
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 transition-transform duration-[var(--fd-duration-fast)]",
                open && "rotate-90",
              )}
            />
          ) : null}
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {hasDetail ? (
          <div className="mt-1 ml-6 space-y-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-3">
            {evidence.command ? (
              <CodeBlock
                code={evidence.command}
                language="command"
                previewLines={4}
              />
            ) : null}
            {evidenceUrl ? (
              <p className="break-all text-[length:var(--fd-text-xs)]">
                <WebLinkAnchor
                  href={evidenceUrl}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {evidenceUrl}
                </WebLinkAnchor>
              </p>
            ) : evidence.path ? (
              <p className="break-all font-mono text-[length:var(--fd-text-xs)] text-fg-tertiary">
                {evidence.path}
              </p>
            ) : null}
            {evidence.detail ? (
              <p className="whitespace-pre-wrap text-[length:var(--fd-text-xs)] text-fg-secondary">
                {evidence.detail}
              </p>
            ) : null}
            {evidence.questions.map((question, questionIndex) => (
              <div
                key={`${question.id}-${questionIndex}`}
                className="space-y-1 text-[length:var(--fd-text-xs)]"
              >
                <p className="font-semibold text-fg-muted">{question.header}</p>
                <p className="whitespace-pre-wrap text-fg-secondary">
                  {question.question}
                </p>
                {question.options?.length ? (
                  <ul className="space-y-1 pl-4 text-fg-tertiary">
                    {question.options.map((option, index) => (
                      <li key={`${question.id}-${index}-${option.label}`}>
                        <span className="font-medium">{option.label}</span>
                        {option.description ? ` — ${option.description}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function InteractiveRequestReceiptIcon({
  tone,
}: {
  tone: ReturnType<typeof interactiveRequestReceiptPresentation>["tone"];
}) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (tone) {
    case "success":
      return (
        <CheckCircle2
          aria-hidden="true"
          className={cn(className, "text-success")}
        />
      );
    case "danger":
      return (
        <Ban aria-hidden="true" className={cn(className, "text-danger")} />
      );
    case "warning":
      return (
        <Clock3 aria-hidden="true" className={cn(className, "text-warning")} />
      );
    case "info":
      return (
        <CheckCircle2
          aria-hidden="true"
          className={cn(className, "text-info")}
        />
      );
    default:
      return (
        <Circle aria-hidden="true" className={cn(className, "text-fg-faint")} />
      );
  }
}

function ServiceMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "service" }>;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = serviceMessagePresentation(item.level, item.message);
  const important = item.level === "warning" || item.level === "error";
  const Icon = item.level === "info" ? Info : AlertTriangle;
  return (
    <div
      role={important ? "alert" : "status"}
      className={cn(
        "mx-auto flex max-w-2xl items-start gap-2 whitespace-pre-wrap text-[length:var(--fd-text-xs)]",
        important
          ? "rounded-[var(--fd-radius-md)] border px-3 py-2 text-left not-italic"
          : "justify-center py-1 text-center italic text-fg-muted",
        item.level === "warning" &&
          "border-warning/35 bg-warning/5 text-warning",
        item.level === "error" && "border-danger/35 bg-danger/5 text-danger",
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span>{presentation.message}</span>
        {presentation.rawDetail ? (
          <details open={detailOpen} className="mt-1 text-fg-secondary">
            <summary
              className="fd-focus cursor-pointer"
              onClick={(event) => {
                event.preventDefault();
                setDetailOpen((open) => !open);
              }}
            >
              Technical details
            </summary>
            {detailOpen ? (
              <div className="mt-2">
                <CodeBlock
                  code={presentation.rawDetail}
                  language="diagnostic"
                  previewLines={8}
                />
              </div>
            ) : null}
          </details>
        ) : null}
      </span>
    </div>
  );
}

function CodeReviewMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "code_review" }>;
}) {
  const lifecycle = contentLifecycle(item);
  const presentation = codeReviewPresentation(lifecycle, item.subject);
  const hasContent = Boolean(item.content.trim());
  const isActive = lifecycle === "pending" || lifecycle === "streaming";
  const iconClassName = "h-4 w-4 shrink-0";
  const icon = isActive ? (
    <ActivityDiamond />
  ) : lifecycle === "error" ? (
    <CircleX aria-hidden="true" className={cn(iconClassName, "text-danger")} />
  ) : lifecycle === "interrupted" ? (
    <PauseCircle
      aria-hidden="true"
      className={cn(iconClassName, "text-warning")}
    />
  ) : (
    <CheckCircle2
      aria-hidden="true"
      className={cn(iconClassName, "text-success")}
    />
  );

  if (!hasContent) {
    return (
      <div
        role={lifecycle === "error" ? "alert" : "status"}
        aria-live={lifecycle === "error" ? "assertive" : "polite"}
        aria-label={`${presentation.label}. ${presentation.detail}`}
        aria-busy={isActive}
        className={cn(
          "mx-auto flex max-w-2xl items-start justify-center gap-2 py-1.5 text-center text-[length:var(--fd-text-xs)] text-fg-muted",
          lifecycle === "error" && "text-danger",
          lifecycle === "interrupted" && "text-warning",
        )}
      >
        <span className="mt-0.5">{icon}</span>
        <span className="min-w-0">
          <span className="block font-medium text-fg-secondary">
            {presentation.label}
          </span>
          <span className="fd-type-readout mt-0.5 block text-fg-muted">
            {presentation.detail}
          </span>
        </span>
      </div>
    );
  }

  return (
    <article
      aria-label={`Code review, ${lifecycle}`}
      aria-busy={isActive}
      className={cn(
        "group/review min-w-0 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 px-4 py-3",
        lifecycle === "error" && "border-danger/40 bg-danger/5",
        lifecycle === "interrupted" && "border-warning/35 bg-warning/5",
      )}
    >
      <header className="mb-3 flex items-start gap-2 border-b border-border-subtle pb-2.5">
        <span className="mt-0.5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
            {presentation.label}
          </span>
          <span className="mt-0.5 block text-[length:var(--fd-text-xs)] text-fg-muted">
            {presentation.detail}
          </span>
        </span>
      </header>
      <div className="max-w-none break-words text-[length:var(--fd-text-md)] text-fg-primary">
        <MessageMarkdown
          text={item.content}
          streaming={isActive}
          interpretDirectives={false}
        />
      </div>
      <div className="mt-2 flex min-h-8 items-center gap-2">
        <span className={hoverRevealActions("review")}>
          <CopyButton text={item.content} label="Copy code review" />
        </span>
        {lifecycle === "error" || lifecycle === "interrupted" ? (
          <span
            role={lifecycle === "error" ? "alert" : "status"}
            className={cn(
              "text-[length:var(--fd-text-xs)]",
              lifecycle === "error" ? "text-danger" : "text-warning",
            )}
          >
            {lifecycle === "error" ? "Review failed" : "Review interrupted"}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function ContextCompactionMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "context_compaction" }>;
}) {
  const lifecycle = item.lifecycle ?? "unknown";
  const presentation = contextCompactionPresentation(lifecycle);
  const iconClassName = "h-3.5 w-3.5 shrink-0";
  const icon =
    lifecycle === "running" || lifecycle === "queued" ? (
      <ActivityDiamond />
    ) : lifecycle === "succeeded" ? (
      <CheckCircle2
        aria-hidden="true"
        className={cn(iconClassName, "text-success")}
      />
    ) : lifecycle === "failed" ? (
      <CircleX
        aria-hidden="true"
        className={cn(iconClassName, "text-danger")}
      />
    ) : lifecycle === "interrupted" || lifecycle === "denied" ? (
      <PauseCircle
        aria-hidden="true"
        className={cn(iconClassName, "text-warning")}
      />
    ) : (
      <BookOpen
        aria-hidden="true"
        className={cn(iconClassName, "text-fg-muted")}
      />
    );

  return (
    <div
      role={lifecycle === "failed" ? "alert" : "status"}
      aria-live={lifecycle === "failed" ? "assertive" : "polite"}
      aria-label={`${presentation.label}. ${presentation.detail}`}
      className={cn(
        "mx-auto flex max-w-2xl items-start justify-center gap-2 py-1.5 text-center text-[length:var(--fd-text-xs)] text-fg-muted",
        lifecycle === "failed" && "text-danger",
        (lifecycle === "interrupted" || lifecycle === "denied") &&
          "text-warning",
      )}
    >
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium text-fg-secondary">
          {presentation.label}
        </span>
        <span className="fd-type-readout mt-0.5 block text-fg-muted">
          {presentation.detail}
        </span>
      </span>
    </div>
  );
}

function RealtimeMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "realtime" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      className="mx-auto w-full max-w-2xl rounded-[var(--fd-radius-md)] border border-accent/25 bg-accent/5 px-3 py-2 text-[length:var(--fd-text-sm)]"
    >
      <summary
        className="fd-focus flex cursor-pointer list-none items-start gap-2 text-fg-primary"
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <Radio
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-accent"
        />
        <span className="min-w-0">
          <span className="block font-medium">{item.title}</span>
          {item.summary ? (
            <span className="mt-0.5 block whitespace-pre-wrap text-fg-secondary">
              {item.summary}
            </span>
          ) : null}
        </span>
      </summary>
      {open ? (
        <div className="mt-2">
          <TechnicalPayloadDetail payload={item.payload} />
        </div>
      ) : null}
    </details>
  );
}

function TechnicalPayloadDetail({ payload }: { payload: unknown }) {
  const inspection = useMemo(() => formatInspectableValue(payload), [payload]);
  return (
    <div>
      <CodeBlock code={inspection.text} language="json" previewLines={8} />
      {inspection.truncated ? (
        <p className="fd-type-meta mt-1 text-fg-muted">
          Display limited for performance and safety.
        </p>
      ) : null}
    </div>
  );
}

function UnsupportedMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "unsupported" }> | unknown;
}) {
  const [open, setOpen] = useState(false);
  const record =
    item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  const kind =
    typeof record?.output_kind === "string"
      ? record.output_kind
      : typeof record?.kind === "string"
        ? record.kind
        : "unknown";
  const lifecycle =
    record?.kind === "unsupported"
      ? contentLifecycle(
          record as Extract<ConversationItem, { kind: "unsupported" }>,
        )
      : "complete";
  const reason =
    typeof record?.reason === "string"
      ? record.reason
      : "This output is not supported.";
  const payload =
    record?.kind === "unsupported" && "payload" in record
      ? record.payload
      : item;
  const label = `Unsupported output: ${providerOutputKindLabel(kind)}`;

  return (
    <details
      open={open}
      role="group"
      aria-label={`${label}. ${contentLifecycleLabel(lifecycle)}. ${reason}`}
      className={cn(
        "rounded-[var(--fd-radius-md)] border px-3 py-2 text-[length:var(--fd-text-sm)]",
        lifecycle === "error"
          ? "border-danger/40 bg-danger/5"
          : "border-warning/30 bg-warning/5",
      )}
    >
      <summary
        className={cn(
          "fd-focus cursor-pointer",
          lifecycle === "error" ? "text-danger" : "text-warning",
        )}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <span
          role={lifecycle === "error" ? "alert" : undefined}
          aria-live={
            lifecycle === "error"
              ? "assertive"
              : lifecycle === "streaming"
                ? "polite"
                : undefined
          }
          aria-atomic={
            lifecycle === "error" || lifecycle === "streaming"
              ? "true"
              : undefined
          }
        >
          {label}
          <span className="fd-type-meta ml-2 text-fg-muted">
            {contentLifecycleLabel(lifecycle)}
          </span>
        </span>
      </summary>
      {open ? (
        <div className="mt-2">
          <p className="mb-2 text-[length:var(--fd-text-xs)] text-fg-secondary">
            {reason}
          </p>
          <TechnicalPayloadDetail payload={payload} />
        </div>
      ) : null}
    </details>
  );
}

function ArtifactMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "artifact" }>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const lifecycle = contentLifecycle(item);
  const active = lifecycle === "pending" || lifecycle === "streaming";
  const artifact = item.artifact;
  const downloadFilename = safeArtifactFilename(artifact.title);
  const safeUrl =
    artifact.url?.trim() && isSafeExternalUrl(artifact.url.trim())
      ? artifact.url.trim()
      : null;
  const downloadUrl = useMemo(() => {
    if (active || !artifact.content) return null;
    const mimeType = safeArtifactMimeType(artifact.mime_type) ?? "text/plain";
    return `data:${mimeType};charset=utf-8,${encodeURIComponent(artifact.content)}`;
  }, [active, artifact.content, artifact.mime_type]);
  const metadata = [
    providerOutputKindLabel(artifact.artifact_kind),
    artifact.mime_type?.trim(),
    artifact.version?.trim() ? `Version ${artifact.version.trim()}` : null,
  ].filter(Boolean);
  return (
    <article
      role="group"
      aria-label={`${artifact.title}. Artifact. ${contentLifecycleLabel(lifecycle)}`}
      aria-busy={active}
      className={cn(
        "max-w-2xl overflow-hidden rounded-[var(--fd-radius-lg)] border bg-surface-2",
        lifecycle === "error" ? "border-danger/40" : "border-border-subtle",
      )}
    >
      <header className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
        <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
          {artifact.title}
        </span>
        <span
          role={lifecycle === "error" ? "alert" : active ? "status" : undefined}
          aria-live={
            lifecycle === "error" ? "assertive" : active ? "polite" : undefined
          }
          aria-atomic={lifecycle === "error" || active ? "true" : undefined}
          className={cn(
            "text-[length:var(--fd-text-xs)]",
            lifecycle === "error"
              ? "text-danger"
              : lifecycle === "interrupted"
                ? "text-warning"
                : "text-fg-muted",
          )}
        >
          {contentLifecycleLabel(lifecycle)}
        </span>
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open artifact: ${artifact.title}`}
            className="fd-focus inline-flex items-center gap-1 text-[length:var(--fd-text-xs)] text-accent hover:underline"
          >
            Open
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {downloadUrl ? (
          <a
            href={downloadUrl}
            download={downloadFilename}
            aria-label={`Download artifact: ${artifact.title}`}
            className="fd-focus inline-flex items-center gap-1 text-[length:var(--fd-text-xs)] text-accent hover:underline"
          >
            Download
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </header>
      <div className="space-y-3 px-3 py-3">
        {metadata.length > 0 ? (
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            {metadata.join(" · ")}
          </p>
        ) : null}
        {artifact.content ? (
          <ArtifactTextPreview
            filename={artifact.title}
            mimeType={artifact.mime_type}
            text={artifact.content}
          />
        ) : active ? (
          <p className="inline-flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted">
            <ActivityDiamond size="sm" />
            Preparing artifact…
          </p>
        ) : (
          <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
            {lifecycle === "error"
              ? "The provider could not finish this artifact."
              : "The provider supplied artifact metadata without an inline preview."}
          </p>
        )}
        {artifact.url && !safeUrl ? (
          <p className="break-all font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
            Reference: {artifact.url}
          </p>
        ) : null}
        <details
          open={detailsOpen}
          className="group rounded-[var(--fd-radius-sm)]"
        >
          <summary
            className="fd-focus flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--fd-radius-sm)] py-0.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-secondary"
            onClick={(event) => {
              event.preventDefault();
              setDetailsOpen((open) => !open);
            }}
          >
            <ChevronRight
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
            />
            Technical details
          </summary>
          {detailsOpen ? (
            <div className="mt-2">
              <TechnicalPayloadDetail payload={artifact.payload} />
            </div>
          ) : null}
        </details>
      </div>
    </article>
  );
}

export const MessageCard = memo(function MessageCard({
  item,
  defaultOpen = false,
  expansionMode = "default",
  suppressReadOnlyDetail = false,
  thinkingDisplay = "auto",
  collapseLongUserMessages = true,
  isStreamingReasoning = false,
  showReceivedAt = false,
  readAloud,
}: {
  item: ConversationItem;
  defaultOpen?: boolean;
  expansionMode?: ExpansionMode;
  suppressReadOnlyDetail?: boolean;
  thinkingDisplay?: ThinkingDisplay;
  /** Clamp tall sent messages behind a "Show more" fade. */
  collapseLongUserMessages?: boolean;
  /** True only for the thought currently arriving, which `auto` expands. */
  isStreamingReasoning?: boolean;
  /** Show a compact received-at stamp on this assistant reply. */
  showReceivedAt?: boolean;
  retrySource?: Extract<ConversationItem, { kind: "user_message" }> | null;
  onRetryResponse?: (
    item: Extract<ConversationItem, { kind: "user_message" }>,
  ) => void;
  readAloud?: ReadAloudController;
}) {
  switch (item.kind) {
    case "user_message":
      return (
        <UserMessage
          item={item}
          collapseLongMessages={collapseLongUserMessages}
        />
      );
    case "assistant_message":
      return (
        <AssistantMessage
          item={item}
          showReceivedAt={showReceivedAt}
          readAloud={readAloud}
        />
      );
    case "image":
      return <ImageMessage item={item} />;
    case "web_search":
      return <WebSearchMessage item={item} />;
    case "file_change":
      return (
        <FileChangeMessage
          item={item}
          defaultOpen={defaultOpen}
          expansionMode={expansionMode}
        />
      );
    case "tool_call":
      return (
        <ToolCallMessage
          item={item}
          defaultOpen={defaultOpen}
          expansionMode={expansionMode}
          suppressReadOnlyDetail={suppressReadOnlyDetail}
        />
      );
    case "reasoning":
      return (
        <ReasoningMessage
          item={item}
          thinkingDisplay={thinkingDisplay}
          streaming={isStreamingReasoning}
        />
      );
    case "code_review":
      return <CodeReviewMessage item={item} />;
    case "context_compaction":
      return <ContextCompactionMessage item={item} />;
    case "artifact":
      return <ArtifactMessage item={item} />;
    case "plan":
      return <PlanMessage item={item} />;
    case "diff":
      return (
        <DiffMessage
          item={item}
          defaultOpen={defaultOpen}
          expansionMode={expansionMode}
        />
      );
    case "interactive_request":
      return <InteractiveRequestMessage item={item} />;
    case "service":
      return <ServiceMessage item={item} />;
    case "realtime":
      return <RealtimeMessage item={item} />;
    case "unsupported":
      return <UnsupportedMessage item={item} />;
    default:
      // A newer daemon must degrade visibly and remain inspectable rather than
      // silently deleting an output the client does not understand yet.
      return <UnsupportedMessage item={item as unknown} />;
  }
});

type ToolSummaryCardProps = {
  summary: ToolActivitySummary;
  items: Extract<ConversationItem, { kind: "tool_call" }>[];
  defaultOpen?: boolean;
  expansionMode?: ExpansionMode;
  suppressReadOnlyDetail?: boolean;
};

function sameItemReferences<T>(left: T[], right: T[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export const ToolSummaryCard = memo(
  function ToolSummaryCard(props: ToolSummaryCardProps) {
    return <ToolSummaryMessage {...props} />;
  },
  (previous, next) =>
    sameItemReferences(previous.items, next.items) &&
    previous.defaultOpen === next.defaultOpen &&
    previous.expansionMode === next.expansionMode &&
    previous.suppressReadOnlyDetail === next.suppressReadOnlyDetail &&
    previous.summary.title === next.summary.title &&
    previous.summary.subtitle === next.summary.subtitle &&
    previous.summary.completed_at === next.summary.completed_at,
);

/** One buried run of tool work: a single quiet line ("Working…" while live,
    "Worked for 2m 14s" when done) that expands to the full tool detail. */
type WorkSessionCardProps = {
  items: WorkSessionEntry[];
  running: boolean;
  startedAt: string;
  completedAt: string | null;
  expansionMode?: ExpansionMode;
  thinkingDisplay?: ThinkingDisplay;
};

export const WorkSessionCard = memo(
  function WorkSessionCard({
    items,
    running,
    startedAt,
    completedAt,
    expansionMode = "default",
    thinkingDisplay = "auto",
  }: WorkSessionCardProps) {
    const [open, setOpen] = useExpansionState(
      false,
      expansionMode,
      items[0]?.id ?? "work",
    );
    const toolCalls = items.filter(
      (entry): entry is Extract<ConversationItem, { kind: "tool_call" }> =>
        entry.kind === "tool_call",
    );
    const activeTool = [...toolCalls].reverse().find((item) => {
      const lifecycle = toolLifecycle(item);
      return (
        lifecycle === "running" ||
        lifecycle === "queued" ||
        lifecycle === "awaiting_approval"
      );
    });
    // A session can be live past its last tool call — the agent is thinking
    // about what it just did. Labelling that state with the finished tool's
    // name would claim work that already ended.
    const thinkingTail =
      running &&
      items[items.length - 1]?.kind === "reasoning" &&
      !activeTool;
    const currentLabel = activeTool ? toolCallLabel(activeTool) : null;

    return (
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger asChild>
          <button
            type="button"
            aria-expanded={open}
            className={cn(
              AGENT_STATUS_ROW_CLASS,
              "fd-focus group rounded-[var(--fd-radius-sm)] transition-colors hover:text-fg-secondary",
            )}
          >
            {running ? (
              <>
                <ActivityDiamond />
                <span className="shrink-0 font-medium">
                  {thinkingTail ? "Thinking…" : "Working…"}
                </span>
                {currentLabel ? (
                  <span className="fd-type-meta fd-type-mono min-w-0 truncate text-fg-muted">
                    {currentLabel}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="font-medium">
                Worked for{" "}
                {formatWorkDuration(startedAt, completedAt ?? startedAt)}
              </span>
            )}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
          <div className="mt-1 space-y-1 border-l border-border-subtle pl-3">
            {items.map((entry) =>
              entry.kind === "reasoning" ? (
                <ReasoningMessage
                  key={`reasoning:${entry.id}`}
                  item={entry}
                  thinkingDisplay={thinkingDisplay}
                />
              ) : (
                <ToolCallMessage key={entry.id} item={entry} />
              ),
            )}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    );
  },
  (previous, next) =>
    sameItemReferences(previous.items, next.items) &&
    previous.running === next.running &&
    previous.startedAt === next.startedAt &&
    previous.completedAt === next.completedAt &&
    previous.expansionMode === next.expansionMode &&
    previous.thinkingDisplay === next.thinkingDisplay,
);

export const LiveActivityLane = memo(function LiveActivityLane({
  groups,
}: {
  groups: ConversationLiveActivityGroup[];
}) {
  if (groups.length === 0) return null;

  // Rendered in the conversation flow (not a pinned lane), matching where the
  // resulting tool-summary cards will appear once the work completes.
  return (
    <div className="min-w-0">
      <div>
        <div className="space-y-3">
          {groups.map((group) => (
            <div
              key={group.id}
              className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1"
            >
              <div className="border-b border-border-subtle px-3 py-2">
                <p className="truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
                  {group.summary.title}
                </p>
                {group.summary.subtitle ? (
                  <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                    {group.summary.subtitle}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1 p-2">
                {group.items.map((item) => (
                  <ToolCallCompactRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
