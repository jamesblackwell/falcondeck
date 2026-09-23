import {
  Bold,
  Check,
  ChevronDown,
  FileText,
  Image,
  Italic,
  Link,
  List,
  Mic,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

/* ────────────────────────────────────────────────────────────────────
   QA Prompt Playground
   Compare prompt-input design approaches side by side with live controls.
   ──────────────────────────────────────────────────────────────────── */

type PlaygroundState = "idle" | "focused" | "typing" | "with-attachments" | "running" | "disabled" | "voice";

type LayoutWidth = "grid" | "desktop" | "tablet" | "mobile";

type DesignVariant = {
  id: string;
  label: string;
  /** Visual style description */
  style: "default" | "compact" | "bordered" | "ghost" | "pill" | "minimal" | "prominent" | "neumorphic";
  /** Whether to show attachment preview row */
  showAttachments: boolean;
  /** Whether to show the running/stop state */
  isRunning: boolean;
  /** Whether the input is disabled */
  disabled: boolean;
  /** Whether to show voice input active */
  isVoice: boolean;
};

const SAMPLE_TEXT = "Add JWT authentication to the Express API. Use bcrypt for password hashing.";

const TEXT_PRESETS: { label: string; text: string }[] = [
  { label: "Empty", text: "" },
  { label: "Short", text: "Fix the build script error." },
  { label: "Default", text: SAMPLE_TEXT },
  {
    label: "Multiline",
    text: `Refactor the authentication middleware:
1. Extract token verification into separate function
2. Add rate limiting headers (100 req/min)
3. Return 401 with structured JSON errors`,
  },
  {
    label: "Code snippet",
    text: `Can you fix the type error in this function?
\`\`\`ts
function verify(token: string): Claims {
  return jwt.verify(token, secret);
}
\`\`\``,
  },
  {
    label: "Long prompt",
    text: `We need to implement a full user authentication and session management system in FalconDeck.
The system needs to support:
- Ed25519 device key pairs for end-to-end cryptographic pairing
- AES-256-GCM symmetric session keys negotiated over the relay bridge
- Ephemeral challenge-response handshake to establish identity
- Automatic reconnect with monotonic sequence replay and state deduplication
- Graceful offline fallback when daemon is disconnected

Please provide an architectural overview and implement the client-side state machine first.`,
  },
];

function classNames(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/* ── Design helpers ──────────────────────────────────────────────────── */

const MESSAGE_CONTENT = `I'll map the existing routes first, then add the auth middleware and run the test suite. That should cover the registration, login, and protected endpoint flows.`;

/* Each approach returns a ReactNode for the prompt input card. */
type ApproachRenderer = (props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  state: PlaygroundState;
  style: DesignVariant["style"];
  label: string;
}) => React.ReactNode;

/* ────────────────────────────────────────────────────────────────────
   Approach A:  Default (current production style)
   Rounded card, border, footer toolbar, textarea with min/max height
   ──────────────────────────────────────────────────────────────────── */
const ApproachDefault: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";
  const hasAttachments = state === "with-attachments";

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative rounded-[var(--fd-radius-xl)] border bg-surface-2 shadow-[0_-2px_10px_-6px_rgba(0,0,0,0.14)] transition-all duration-150",
          isDisabled ? "opacity-55" : "",
        )}
      >
        {/* Attachments row */}
        {hasAttachments || isVoice ? (
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
            {isVoice ? (
              <div className="flex items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-3 px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-secondary">
                <Mic className="h-4 w-4 text-accent" aria-hidden="true" />
                <span className="tabular-nums">0:32</span>
                <span className="h-3 w-3 rounded-full bg-accent/60 animate-pulse" />
              </div>
            ) : (
              <>
                <div className="relative h-14 w-14 overflow-hidden rounded-[var(--fd-radius-md)] border border-border-default bg-surface-3">
                  <img
                    src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Crect width='56' height='56' fill='%23222'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.35em' fill='%23666' font-size='20' font-family='sans-serif'%3E📷%3C/text%3E
              " alt=""
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex h-14 w-36 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2 text-[length:var(--fd-text-xs)] text-fg-secondary">
                  <FileText className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">api-spec.yaml</span>
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* Textarea */}
        <label htmlFor={id} className="sr-only">Prompt input</label>
        <textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={isDisabled || isVoice}
          placeholder={isDisabled ? "Add a project to get started..." : "Ask anything"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (hasContent && !isDisabled) onSubmit();
            }
          }}
          className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[length:var(--fd-text-md)] leading-relaxed text-fg-primary placeholder:text-fg-muted focus:outline-none md:text-[length:var(--fd-text-base)]"
          style={{ minHeight: 52, maxHeight: 200 }}
          rows={1}
        />

        {/* Footer toolbar */}
        <div className="flex items-center gap-1.5 px-3 pb-3">
          <div className="flex items-center gap-1 text-fg-muted">
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-md)] transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:pointer-events-none disabled:opacity-50"
              aria-label="Attach file"
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-md)] transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:pointer-events-none disabled:opacity-50"
              aria-label="Voice input"
            >
              <Mic className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="ml-auto">
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-md)] bg-danger/10 text-danger transition-colors hover:bg-danger/20"
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!hasContent || isDisabled}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-md)] bg-accent text-[var(--fd-bg-0)] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach B:  Compact minimal
   No border, flat surface, smaller text, no toolbar icons
   ──────────────────────────────────────────────────────────────────── */
const ApproachCompact: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative rounded-[var(--fd-radius-lg)] bg-surface-1 transition-all duration-150",
          isDisabled ? "opacity-50" : "focus-within:bg-surface-2",
        )}
      >
        <label htmlFor={id} className="sr-only">Prompt input</label>
        <textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={isDisabled || isVoice}
          placeholder="Ask anything…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (hasContent && !isDisabled) onSubmit();
            }
          }}
          className="block w-full resize-none bg-transparent px-4 py-3 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-primary placeholder:text-fg-muted focus:outline-none"
          style={{ minHeight: 44, maxHeight: 160 }}
          rows={1}
        />
        <div className="flex items-center justify-between px-3 pb-2">
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-6 items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 text-[length:var(--fd-text-xs)] text-danger transition-colors hover:bg-danger/10"
              aria-label="Stop"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              Stop
            </button>
          ) : (
            <span className="text-[length:var(--fd-text-2xs)] text-fg-muted">
              {hasContent ? `${value.length} chars` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={isRunning ? onStop : onSubmit}
            disabled={!isRunning && (!hasContent || isDisabled)}
            className={classNames(
              "inline-flex h-6 w-6 items-center justify-center rounded-[var(--fd-radius-sm)] transition-colors",
              isRunning
                ? "bg-danger/10 text-danger hover:bg-danger/20"
                : "bg-accent text-[var(--fd-bg-0)] hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40",
            )}
            aria-label={isRunning ? "Stop" : "Send"}
          >
            {isRunning ? (
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            ) : (
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach C:  Bordered prominent
   Thick border, larger padding, distinct send button
   ──────────────────────────────────────────────────────────────────── */
const ApproachBordered: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";
  const hasAttachments = state === "with-attachments";

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 240)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative rounded-2xl border-2 transition-all duration-150",
          isDisabled
            ? "border-border-default bg-surface-1 opacity-55"
            : state === "focused" || value.length > 0
              ? "border-accent/50 bg-surface-2 shadow-[0_0_0_1px_rgba(52,211,153,0.08)]"
              : "border-border-default bg-surface-2",
        )}
      >
        {hasAttachments || isVoice ? (
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-5 pt-4 pb-3">
            <div className="relative h-16 w-16 overflow-hidden rounded-xl border border-border-default bg-surface-3">
              <img
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23222'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.35em' fill='%23666' font-size='22' font-family='sans-serif'%3E📷%3C/text%3E"
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
            <div className="flex h-16 w-40 items-center gap-3 rounded-xl border border-border-default bg-surface-2 px-3 text-[length:var(--fd-text-sm)] text-fg-secondary">
              <FileText className="h-5 w-5 shrink-0 text-fg-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">schema.prisma</span>
            </div>
          </div>
        ) : null}

        <label htmlFor={id} className="sr-only">Prompt input</label>
        <div className="relative">
          <textarea
            id={id}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled || isVoice}
            placeholder="What would you like to build?"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                if (hasContent && !isDisabled) onSubmit();
              }
            }}
            className="block w-full resize-none bg-transparent px-5 pt-5 pb-3 text-[length:var(--fd-text-base)] leading-relaxed text-fg-primary placeholder:text-fg-muted/60 focus:outline-none"
            style={{ minHeight: 60, maxHeight: 240 }}
            rows={2}
          />
        </div>

        <div className="flex items-center justify-between px-4 pb-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border-default bg-surface-1 text-fg-muted transition-colors hover:border-accent/30 hover:text-accent disabled:pointer-events-none disabled:opacity-50"
              aria-label="Attach"
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border-default bg-surface-1 text-fg-muted transition-colors hover:border-accent/30 hover:text-accent disabled:pointer-events-none disabled:opacity-50"
              aria-label="Voice"
            >
              <Mic className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border-default bg-surface-1 text-fg-muted transition-colors hover:border-accent/30 hover:text-accent disabled:pointer-events-none disabled:opacity-50"
              aria-label="Attach image"
            >
              <Image className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 text-[length:var(--fd-text-sm)] font-medium text-danger transition-colors hover:bg-danger/20"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!hasContent || isDisabled}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-5 text-[length:var(--fd-text-sm)] font-medium text-[var(--fd-bg-0)] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach D:  Ghost / transparent
   No border, subtle background only on focus, floating send
   ──────────────────────────────────────────────────────────────────── */
const ApproachGhost: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative transition-all duration-200",
          isDisabled ? "opacity-50" : "",
        )}
      >
        <div
          className={classNames(
            "rounded-[var(--fd-radius-xl)] transition-all duration-200",
            focused && !isDisabled
              ? "bg-surface-2 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
              : "bg-transparent",
          )}
        >
          <label htmlFor={id} className="sr-only">Prompt input</label>
          <textarea
            id={id}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={isDisabled || isVoice}
            placeholder="Write a message…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                if (hasContent && !isDisabled) onSubmit();
              }
            }}
            className="block w-full resize-none bg-transparent px-5 pt-5 pb-4 text-[length:var(--fd-text-base)] leading-relaxed text-fg-primary placeholder:text-fg-muted/40 focus:outline-none"
            style={{ minHeight: 56, maxHeight: 200 }}
            rows={1}
          />
        </div>

        {/* Floating send button */}
        <div className="flex items-center justify-between px-2 pb-2">
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--fd-radius-sm)] bg-danger/10 px-3 text-[length:var(--fd-text-xs)] text-danger transition-colors hover:bg-danger/20"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              Stop
            </button>
          ) : (
            <span className="text-[length:var(--fd-text-2xs)] text-fg-muted/60">
              {hasContent ? `${value.length} chars` : "Cmd+Enter to send"}
            </span>
          )}
          <button
            type="button"
            onClick={isRunning ? onStop : onSubmit}
            disabled={!isRunning && (!hasContent || isDisabled)}
            className={classNames(
              "inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-full)] shadow-sm transition-all duration-200",
              isRunning
                ? "bg-danger/10 text-danger hover:bg-danger/20"
                : focused
                  ? "bg-accent text-[var(--fd-bg-0)] hover:bg-accent-strong disabled:opacity-40"
                  : "bg-surface-3 text-fg-muted hover:bg-surface-4 hover:text-fg-secondary disabled:opacity-40",
            )}
            aria-label={isRunning ? "Stop" : "Send"}
          >
            {isRunning ? (
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach E:  Pill / iMessage-style
   Rounded pill shape, no separate footer, inline send
   ──────────────────────────────────────────────────────────────────── */
const ApproachPill: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative flex items-end gap-2 rounded-full border transition-all duration-150",
          isDisabled
            ? "border-border-default bg-surface-2 opacity-55"
            : hasContent
              ? "border-accent/40 bg-surface-2"
              : "border-border-default bg-surface-2",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center pl-5">
          <label htmlFor={id} className="sr-only">Prompt input</label>
          <textarea
            id={id}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled || isVoice}
            placeholder="Message…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                if (hasContent && !isDisabled) onSubmit();
              }
            }}
            className="block w-full resize-none bg-transparent py-3 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-primary placeholder:text-fg-muted/50 focus:outline-none"
            style={{ minHeight: 40, maxHeight: 160 }}
            rows={1}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1 pr-2 pb-2">
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-50"
            aria-label="Attach"
          >
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-danger/10 text-danger transition-colors hover:bg-danger/20"
              aria-label="Stop"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!hasContent || isDisabled}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-[var(--fd-bg-0)] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach F:  Minimalist / bare
   No icons, no border, just a line and send hint
   ──────────────────────────────────────────────────────────────────── */
const ApproachMinimal: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div className={classNames("relative", isDisabled ? "opacity-40" : "")}>
        <div
          className={classNames(
            "border-b transition-all duration-150",
            isDisabled
              ? "border-border-default"
              : focused
                ? "border-accent"
                : "border-border-default hover:border-border-strong",
          )}
        >
          <label htmlFor={id} className="sr-only">Prompt input</label>
          <textarea
            id={id}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={isDisabled || isVoice}
            placeholder="Type here…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                if (hasContent && !isDisabled) onSubmit();
              }
            }}
            className="block w-full resize-none bg-transparent pb-3 pt-2 text-[length:var(--fd-text-base)] leading-relaxed text-fg-primary placeholder:text-fg-muted/40 focus:outline-none"
            style={{ minHeight: 44, maxHeight: 160 }}
            rows={1}
          />
        </div>
        <div className="flex items-center justify-end pt-2">
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1.5 rounded-[var(--fd-radius-sm)] px-2 py-1 text-[length:var(--fd-text-xs)] text-danger transition-colors hover:bg-danger/10"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              Stop
            </button>
          ) : hasContent ? (
            <span className="inline-flex items-center gap-1 text-[length:var(--fd-text-2xs)] text-fg-muted/60">
              Enter to send
              <Send className="h-3 w-3" aria-hidden="true" />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach G:  Prominent / editor-style
   Big textarea, full toolbar with formatting, image attachment visible
   ──────────────────────────────────────────────────────────────────── */
const ApproachProminent: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";
  const hasAttachments = state === "with-attachments";

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 280)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative overflow-hidden rounded-2xl border bg-surface-1 transition-all duration-150",
          isDisabled ? "border-border-default opacity-55" : "border-border-default",
        )}
      >
        {/* Attachment area */}
        {hasAttachments || isVoice ? (
          <div className="flex flex-wrap gap-2 border-b border-border-subtle bg-surface-2 px-5 py-3">
            <div className="relative h-20 w-20 overflow-hidden rounded-xl border border-border-default bg-surface-3">
              <img
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23222'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.35em' fill='%23666' font-size='28' font-family='sans-serif'%3E📷%3C/text%3E"
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
            <div className="flex h-20 w-44 items-center gap-3 rounded-xl border border-border-default bg-surface-2 px-3 text-[length:var(--fd-text-sm)] text-fg-secondary">
              <FileText className="h-5 w-5 shrink-0 text-fg-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg-primary">schema.prisma</span>
                <span className="block text-[length:var(--fd-text-2xs)] text-fg-muted">Prisma schema · 2.4 KB</span>
              </span>
            </div>
          </div>
        ) : null}

        <label htmlFor={id} className="sr-only">Prompt input</label>
        <textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={isDisabled || isVoice}
          placeholder="Describe what you want to build or change…"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (hasContent && !isDisabled) onSubmit();
            }
          }}
          className="block w-full resize-none bg-transparent px-5 pt-5 pb-3 text-[length:var(--fd-text-base)] leading-relaxed text-fg-primary placeholder:text-fg-muted/50 focus:outline-none"
          style={{ minHeight: 80, maxHeight: 280 }}
          rows={3}
        />

        {/* Formatting toolbar */}
        <div className="flex items-center gap-1 border-t border-border-subtle bg-surface-2 px-3 py-2">
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            aria-label="Bold"
          >
            <Bold className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            aria-label="Italic"
          >
            <Italic className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            aria-label="List"
          >
            <List className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            aria-label="Link"
          >
            <Link className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <div className="mx-2 h-5 w-px bg-border-subtle" />
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            aria-label="Attach file"
          >
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={isDisabled || isVoice}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            aria-label="Voice input"
          >
            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <div className="ml-auto flex items-center gap-2">
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--fd-radius-md)] bg-danger/10 px-3 text-[length:var(--fd-text-xs)] font-medium text-danger transition-colors hover:bg-danger/20"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!hasContent || isDisabled}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--fd-radius-md)] bg-accent px-3 text-[length:var(--fd-text-xs)] font-medium text-[var(--fd-bg-0)] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Approach H:  Neumorphic / soft UI
   Inset shadow on idle, raised on focus, soft colors
   ──────────────────────────────────────────────────────────────────── */
const ApproachNeumorphic: ApproachRenderer = ({
  value, onChange, onSubmit, onStop, state, style, label,
}) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;
  const isRunning = state === "running";
  const isDisabled = state === "disabled";
  const isVoice = state === "voice";
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted tracking-wide">{label}</div>
      <div
        className={classNames(
          "relative rounded-2xl transition-all duration-200",
          isDisabled
            ? "opacity-50"
            : focused
              ? "shadow-[0_4px_20px_-8px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.06)] bg-surface-2"
              : "shadow-[inset_0_2px_6px_-4px_rgba(0,0,0,0.3)] bg-surface-1",
        )}
      >
        <label htmlFor={id} className="sr-only">Prompt input</label>
        <textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={isDisabled || isVoice}
          placeholder="What's on your mind?"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (hasContent && !isDisabled) onSubmit();
            }
          }}
          className="block w-full resize-none bg-transparent px-5 pt-5 pb-3 text-[length:var(--fd-text-base)] leading-relaxed text-fg-primary placeholder:text-fg-muted/50 focus:outline-none"
          style={{ minHeight: 56, maxHeight: 200 }}
          rows={1}
        />

        <div className="flex items-center justify-between px-4 pb-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className={classNames(
                "inline-flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150",
                focused
                  ? "shadow-[0_2px_8px_-4px_rgba(0,0,0,0.3)] bg-surface-3 text-fg-muted hover:text-fg-secondary"
                  : "shadow-[inset_0_1px_3px_-2px_rgba(0,0,0,0.3)] bg-surface-2 text-fg-muted",
                isDisabled ? "opacity-40 pointer-events-none" : "",
              )}
              aria-label="Attach"
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={isDisabled || isVoice}
              className={classNames(
                "inline-flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150",
                focused
                  ? "shadow-[0_2px_8px_-4px_rgba(0,0,0,0.3)] bg-surface-3 text-fg-muted hover:text-fg-secondary"
                  : "shadow-[inset_0_1px_3px_-2px_rgba(0,0,0,0.3)] bg-surface-2 text-fg-muted",
                isDisabled ? "opacity-40 pointer-events-none" : "",
              )}
              aria-label="Mic"
            >
              <Mic className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div>
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                className={classNames(
                  "inline-flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150",
                  focused
                    ? "shadow-[0_2px_8px_-4px_rgba(0,0,0,0.3)] bg-danger/10 text-danger"
                    : "shadow-[inset_0_1px_3px_-2px_rgba(0,0,0,0.3)] bg-danger/10 text-danger/80",
                )}
                aria-label="Stop"
              >
                <Square className="h-4 w-4 fill-current" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!hasContent || isDisabled}
                className={classNames(
                  "inline-flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150",
                  !hasContent || isDisabled
                    ? "opacity-40 cursor-not-allowed"
                    : focused
                      ? "shadow-[0_2px_8px_-4px_rgba(0,0,0,0.3)] bg-accent text-[var(--fd-bg-0)]"
                      : "shadow-[inset_0_1px_3px_-2px_rgba(0,0,0,0.3)] bg-accent/80 text-[var(--fd-bg-0)]",
                )}
                aria-label="Send"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
   Conversation context display (for realism)
   ──────────────────────────────────────────────────────────────────── */

function ConversationContext({ state }: { state: PlaygroundState }) {
  if (state === "idle" || state === "disabled") return null;
  return (
    <div className="mb-4 space-y-3 px-1">
      {state === "with-attachments" ? (
        <div className="rounded-[var(--fd-radius-lg)] bg-surface-2 p-3 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
          <div className="mb-1 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">Agent response</div>
          <p>{MESSAGE_CONTENT}</p>
        </div>
      ) : null}
      {state === "running" ? (
        <div className="space-y-2">
          <div className="rounded-[var(--fd-radius-lg)] bg-surface-2 p-3 text-[length:var(--fd-text-sm)] text-fg-secondary">
            Add JWT authentication to the Express API. Use bcrypt for password hashing.
          </div>
          <div className="flex items-center gap-2 rounded-[var(--fd-radius-lg)] bg-accent/5 p-3 text-[length:var(--fd-text-sm)] text-accent-strong">
            <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />
            Agent is working…
          </div>
        </div>
      ) : null}
      {state === "voice" ? (
        <div className="rounded-[var(--fd-radius-lg)] bg-surface-2 p-3 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
          <div className="mb-1 flex items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
            Voice input active
          </div>
          <p>Recording in progress… tap stop when you're done.</p>
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   State control bar
   ──────────────────────────────────────────────────────────────────── */
function StateSelector({
  current,
  onChange,
}: {
  current: PlaygroundState;
  onChange: (s: PlaygroundState) => void;
}) {
  const states: { value: PlaygroundState; label: string; icon?: React.ReactNode }[] = [
    { value: "idle", label: "Idle" },
    { value: "focused", label: "Focused" },
    { value: "typing", label: "Typing" },
    { value: "with-attachments", label: "+ Attachments" },
    { value: "running", label: "Running" },
    { value: "disabled", label: "Disabled" },
    { value: "voice", label: "Voice" },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {states.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => onChange(s.value)}
          className={classNames(
            "inline-flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-3 py-1.5 text-[length:var(--fd-text-xs)] font-medium transition-colors",
            current === s.value
              ? "bg-accent text-[var(--fd-bg-0)]"
              : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
          )}
        >
          {s.icon}
          {s.label}
        </button>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Approach selector
   ──────────────────────────────────────────────────────────────────── */
function ApproachSelector({
  active,
  variants,
  onToggle,
  onSelectAll,
  onClearAll,
}: {
  active: Set<string>;
  variants: DesignVariant[];
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {variants.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onToggle(v.id)}
          className={classNames(
            "inline-flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-3 py-1.5 text-[length:var(--fd-text-xs)] font-medium transition-colors",
            active.has(v.id)
              ? "bg-accent text-[var(--fd-bg-0)]"
              : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
          )}
        >
          {active.has(v.id) ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
          {v.label}
        </button>
      ))}
      <div className="mx-1 h-4 w-px bg-border-subtle" />
      <button
        type="button"
        onClick={onSelectAll}
        className="rounded-[var(--fd-radius-md)] bg-surface-2 px-2.5 py-1.5 text-[length:var(--fd-text-2xs)] font-medium text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary"
      >
        All
      </button>
      <button
        type="button"
        onClick={onClearAll}
        className="rounded-[var(--fd-radius-md)] bg-surface-2 px-2.5 py-1.5 text-[length:var(--fd-text-2xs)] font-medium text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary"
      >
        None
      </button>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Approach renderer map
   ──────────────────────────────────────────────────────────────────── */
const APPROACH_RENDERERS: Record<DesignVariant["style"], ApproachRenderer> = {
  default: ApproachDefault,
  compact: ApproachCompact,
  bordered: ApproachBordered,
  ghost: ApproachGhost,
  pill: ApproachPill,
  minimal: ApproachMinimal,
  prominent: ApproachProminent,
  neumorphic: ApproachNeumorphic,
};

const ALL_VARIANTS: DesignVariant[] = [
  { id: "default", label: "Default", style: "default", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "compact", label: "Compact", style: "compact", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "bordered", label: "Bordered", style: "bordered", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "ghost", label: "Ghost", style: "ghost", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "pill", label: "Pill", style: "pill", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "minimal", label: "Minimal", style: "minimal", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "prominent", label: "Prominent", style: "prominent", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
  { id: "neumorphic", label: "Neumorphic", style: "neumorphic", showAttachments: false, isRunning: false, disabled: false, isVoice: false },
];

/* ────────────────────────────────────────────────────────────────────
   Main QA Playground component
   ──────────────────────────────────────────────────────────────────── */

export default function QAPromptPlayground() {
  const [state, setState] = useState<PlaygroundState>("typing");
  const [widthMode, setWidthMode] = useState<LayoutWidth>("grid");
  const [value, setValue] = useState(SAMPLE_TEXT);
  const [log, setLog] = useState<string[]>([]);
  const [activeVariants, setActiveVariants] = useState<Set<string>>(
    () => new Set(["default", "bordered", "pill", "ghost", "prominent", "compact"]),
  );

  const logAction = useCallback((msg: string) => {
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 19)]);
  }, []);

  const handleSubmit = useCallback(() => {
    logAction(`Submitted: "${value.slice(0, 60)}${value.length > 60 ? "…" : ""}"`);
  }, [logAction, value]);

  const handleStop = useCallback(() => {
    logAction("Stop clicked");
  }, [logAction]);

  const toggleVariant = useCallback((id: string) => {
    setActiveVariants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllVariants = useCallback(() => {
    setActiveVariants(new Set(ALL_VARIANTS.map((v) => v.id)));
  }, []);

  const clearAllVariants = useCallback(() => {
    setActiveVariants(new Set());
  }, []);

  const activeStyles = ALL_VARIANTS.filter((v) => activeVariants.has(v.id));

  const containerClasses =
    widthMode === "grid"
      ? "grid gap-8 md:grid-cols-2"
      : widthMode === "desktop"
        ? "mx-auto flex flex-col gap-8 max-w-3xl"
        : widthMode === "tablet"
          ? "mx-auto flex flex-col gap-8 max-w-xl"
          : "mx-auto flex flex-col gap-8 max-w-sm";

  return (
    <div className="qa-playground min-h-screen bg-surface-0 text-fg-primary">
      {/* Header bar */}
      <div className="sticky top-0 z-30 border-b border-border-default bg-surface-0/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <a href="/" className="brand-lockup text-[length:var(--fd-text-sm)] text-fg-muted hover:text-fg-primary">
              ← Site
            </a>
            <div className="h-4 w-px bg-border-subtle" />
            <h1 className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
              QA: Prompt Input
            </h1>
          </div>
          <span className="text-[length:var(--fd-text-2xs)] text-fg-muted">
            {activeStyles.length} / {ALL_VARIANTS.length} approaches shown
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-6">
        {/* Controls */}
        <div className="mb-8 space-y-4">
          <div>
            <div className="mb-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">State simulation</div>
            <StateSelector current={state} onChange={(s) => {
              setState(s);
              if (s === "typing") {
                setValue(SAMPLE_TEXT);
              } else if (s === "idle" || s === "focused") {
                setValue("");
              }
              logAction(`State changed to "${s}"`);
            }} />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
              <span>Input text presets</span>
              <span className="font-mono text-[length:var(--fd-text-2xs)]">
                {value.length} chars · {value ? value.split("\n").length : 0} lines
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {TEXT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setValue(p.text);
                    if (p.text.length > 0 && (state === "idle" || state === "focused")) {
                      setState("typing");
                    }
                    logAction(`Applied preset "${p.label}"`);
                  }}
                  className={classNames(
                    "rounded-[var(--fd-radius-md)] px-3 py-1.5 text-[length:var(--fd-text-xs)] font-medium transition-colors",
                    value === p.text
                      ? "border border-accent/40 bg-accent/20 text-accent"
                      : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
                  )}
                >
                  {p.label}
                </button>
              ))}
              {value ? (
                <button
                  type="button"
                  onClick={() => {
                    setValue("");
                    logAction("Cleared text");
                  }}
                  className="rounded-[var(--fd-radius-md)] bg-surface-2 px-2.5 py-1.5 text-[length:var(--fd-text-2xs)] font-medium text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">Container width preview</div>
            <div className="flex flex-wrap items-center gap-2">
              {[
                { value: "grid", label: "2-Column Grid" },
                { value: "desktop", label: "Desktop (768px)" },
                { value: "tablet", label: "Tablet (576px)" },
                { value: "mobile", label: "Mobile (380px)" },
              ].map((w) => (
                <button
                  key={w.value}
                  type="button"
                  onClick={() => setWidthMode(w.value as LayoutWidth)}
                  className={classNames(
                    "rounded-[var(--fd-radius-md)] px-3 py-1.5 text-[length:var(--fd-text-xs)] font-medium transition-colors",
                    widthMode === w.value
                      ? "bg-accent text-[var(--fd-bg-0)]"
                      : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">Design approaches</div>
            <ApproachSelector
              active={activeVariants}
              variants={ALL_VARIANTS}
              onToggle={toggleVariant}
              onSelectAll={selectAllVariants}
              onClearAll={clearAllVariants}
            />
          </div>

          <details className="group">
            <summary className="flex cursor-pointer items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted hover:text-fg-secondary">
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
              Event log ({log.length})
            </summary>
            <div className="mt-2 max-h-32 overflow-y-auto rounded-[var(--fd-radius-md)] bg-surface-2 p-3 font-mono text-[length:var(--fd-text-2xs)] leading-relaxed text-fg-muted">
              {log.length === 0 ? (
                <span className="italic">No events yet — interact with the playground</span>
              ) : (
                log.map((entry, i) => <div key={i}>{entry}</div>)
              )}
            </div>
          </details>
        </div>

        {/* Prompt input grid / container */}
        <div className={containerClasses}>
          {activeStyles.map((variant) => {
            const Renderer = APPROACH_RENDERERS[variant.style];
            return (
              <div
                key={variant.id}
                className="rounded-2xl border border-border-default bg-surface-1 p-5 transition-shadow hover:shadow-[0_2px_16px_-6px_rgba(0,0,0,0.25)]"
              >
                <div className="mb-4 flex items-center justify-between">
                  <span className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-2 py-0.5 text-[length:var(--fd-text-2xs)] font-mono uppercase tracking-wider text-fg-muted">
                    {variant.style}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleVariant(variant.id)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary"
                    aria-label={`Remove ${variant.label}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>

                <ConversationContext state={state} />

                <Renderer
                  value={value}
                  onChange={(v) => {
                    setValue(v);
                    if (state === "idle" || state === "focused") setState("typing");
                  }}
                  onSubmit={handleSubmit}
                  onStop={handleStop}
                  state={state}
                  style={variant.style}
                  label={variant.label}
                />
              </div>
            );
          })}
        </div>

        {/* Empty state */}
        {activeStyles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-[length:var(--fd-text-lg)] text-fg-muted">No approaches selected</p>
            <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-muted/60">
              Toggle approaches above to compare prompt input designs.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}