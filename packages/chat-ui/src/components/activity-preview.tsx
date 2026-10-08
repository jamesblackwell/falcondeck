import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import type { ThreadDetail } from "@falcondeck/client-core";
import { Button, Textarea } from "@falcondeck/ui";
import { Conversation } from "./conversation";

export type ActivityPreviewActions = {
  onLoadPreview: (
    workspaceId: string,
    threadId: string,
  ) => Promise<ThreadDetail>;
  onSendPreview: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => Promise<void>;
};

export function ActivityPreview({
  workspaceId,
  threadId,
  title,
  offline,
  draft,
  onDraftChange,
  onLoadPreview,
  onSendPreview,
  onRead,
  onClose,
  onOpen,
}: ActivityPreviewActions & {
  workspaceId: string;
  threadId: string;
  title: string;
  offline: boolean;
  draft: string;
  onDraftChange: (value: string, submitted?: string) => void;
  onRead: (sequence: number) => Promise<void> | void;
  onClose: () => void;
  onOpen: () => void;
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    const previous = document.activeElement;
    const background: { element: HTMLElement; inert: boolean }[] = [];
    let branch = panelRef.current?.parentElement;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        const controls = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) ?? [],
        ).filter((element) => !element.closest("[hidden]"));
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      for (const { element, inert } of background) element.inert = inert;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (offline) return;
    void onLoadPreview(workspaceId, threadId)
      .then(async (loaded) => {
        if (!active) return;
        setDetail(loaded);
        setError(null);
        // A partial hydration has not yet supplied the messages being marked read.
        if (!loaded.is_partial && document.hasFocus()) {
          await onReadRef.current(
            loaded.thread.attention.last_agent_activity_seq,
          );
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Could not load task",
          );
      });
    return () => {
      active = false;
    };
  }, [onLoadPreview, workspaceId, threadId, offline, refresh]);

  const send = async () => {
    const submitted = draft;
    if (!submitted.trim() || sending || offline || !detail || detail.is_partial)
      return;
    setSending(true);
    setError(null);
    try {
      await onSendPreview(workspaceId, threadId, submitted.trim());
      onDraftChange("", submitted);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send reply");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-[color:var(--fd-overlay)] p-4 sm:p-8"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview: ${title}`}
        className="fd-type-scope fd-scope-chat flex h-full max-h-[min(850px,90vh)] w-full max-w-4xl flex-col overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-strong bg-surface-1 shadow-[var(--fd-shadow-lg)]"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate font-semibold text-fg-primary">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh messages"
            disabled={offline}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw aria-hidden className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            <ExternalLink aria-hidden className="h-4 w-4" />
            Open task
          </Button>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </header>
        {detail?.has_older ? (
          <p className="px-4 pt-2 text-xs text-fg-muted">
            Recent messages · Open task for the full conversation
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <Conversation
            threadKey={`preview:${workspaceId}:${threadId}`}
            items={detail?.items ?? []}
            isLoading={!detail && !error && !offline}
            isSending={sending}
          />
        </div>
        <footer className="shrink-0 border-t border-border-subtle p-4">
          {offline ? (
            <p className="mb-2 text-sm text-fg-muted">
              Host offline. Reconnect to review and reply.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mb-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Textarea
            aria-label="Quick reply"
            placeholder="Send a quick follow-up…"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-fg-muted">
              Enter to send · Shift+Enter for a new line · Esc to return
            </p>
            <Button
              size="sm"
              disabled={
                sending ||
                offline ||
                !detail ||
                detail.is_partial ||
                !draft.trim()
              }
              onClick={() => void send()}
            >
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
