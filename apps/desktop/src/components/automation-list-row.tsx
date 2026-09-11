import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { MoreHorizontal, Pause, Play } from "lucide-react";

import {
  ActivityDiamond,
  Badge,
  Button,
  Popover,
  cn,
} from "@falcondeck/ui";

export type AutomationRowTone =
  | "active"
  | "paused"
  | "completed"
  | "running"
  | "queued"
  | "waiting"
  | "failed";

function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onClose: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "[role=menuitem]:not(:disabled)",
    ),
  ];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const offset = event.key === "ArrowDown" ? 1 : -1;
  const base = current < 0 ? (offset > 0 ? -1 : 0) : current;
  items[(base + offset + items.length) % items.length]?.focus();
}

function ToneMark({ tone }: { tone: AutomationRowTone }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {tone === "running" || tone === "queued" ? (
        <ActivityDiamond size="xs" />
      ) : tone === "paused" || tone === "completed" ? (
        <span
          aria-hidden="true"
          className="block h-2 w-2 rounded-full border border-fg-muted"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 rounded-full",
            tone === "waiting" &&
              "bg-warning shadow-[0_0_0_3px_var(--fd-warning-muted)]",
            tone === "failed" && "bg-danger",
            tone === "active" && "bg-info",
          )}
        />
      )}
    </span>
  );
}

function MenuItems({
  paused,
  online,
  canToggle,
  onRun,
  onEdit,
  onToggle,
  onDelete,
}: {
  paused: boolean;
  online: boolean;
  canToggle: boolean;
  onRun: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const itemClass =
    "fd-focus block w-full rounded px-3 py-2 text-left text-sm text-fg-primary hover:bg-surface-3 disabled:opacity-40";
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!online}
        onClick={onRun}
      >
        Run now
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!online}
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!online || !canToggle}
        onClick={onToggle}
      >
        {paused ? "Resume" : "Pause"}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cn(itemClass, "text-danger")}
        disabled={!online}
        onClick={onDelete}
      >
        Delete
      </button>
    </>
  );
}

export function AutomationRowMenuContent({
  title,
  paused,
  online,
  canToggle,
  onClose,
  onRun,
  onEdit,
  onToggle,
  onDelete,
}: {
  title: string;
  paused: boolean;
  online: boolean;
  canToggle: boolean;
  onClose: () => void;
  onRun: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="menu"
      aria-label={`Actions for ${title}`}
      onKeyDown={(event) => handleMenuKeyDown(event, onClose)}
      className="z-50 min-w-44 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-1 shadow-[var(--fd-shadow-md)]"
    >
      <MenuItems
        paused={paused}
        online={online}
        canToggle={canToggle}
        onRun={() => {
          onClose();
          onRun();
        }}
        onEdit={() => {
          onClose();
          onEdit();
        }}
        onToggle={() => {
          onClose();
          onToggle();
        }}
        onDelete={() => {
          onClose();
          onDelete();
        }}
      />
    </div>
  );
}

export function AutomationListRow({
  title,
  cadence,
  projectLabel,
  hostLabel,
  hostOffline = false,
  whenLabel,
  whenTitle,
  whenOverdue = false,
  attention,
  attentionTone,
  tone,
  extensionOwned = false,
  elevated = false,
  selected = false,
  busy = false,
  online = true,
  canToggle = true,
  paused = false,
  menuOpen,
  onOpen,
  onRun,
  onToggle,
  onEdit,
  onDelete,
  onMenuOpenChange,
  onContextMenu,
}: {
  title: string;
  cadence: string;
  projectLabel: string | null;
  hostLabel: string | null;
  hostOffline?: boolean;
  whenLabel: string;
  whenTitle?: string;
  whenOverdue?: boolean;
  attention?: string | null;
  attentionTone?: "danger" | "warning";
  tone: AutomationRowTone;
  extensionOwned?: boolean;
  elevated?: boolean;
  selected?: boolean;
  busy?: boolean;
  online?: boolean;
  canToggle?: boolean;
  paused?: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const muted = tone === "paused" || tone === "completed" || hostOffline;

  return (
    <article
      className={cn(
        "group relative flex items-start gap-3 px-4 py-3 transition-colors duration-[var(--fd-duration-fast)]",
        selected ? "fd-row-selected" : "hover:bg-interactive-hover",
        (busy || hostOffline) && "opacity-70",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event);
      }}
    >
      <span className="mt-0.5">
        <ToneMark tone={tone} />
      </span>
      <button
        type="button"
        className="fd-focus-inset min-w-0 flex-1 rounded-[var(--fd-radius-sm)] text-left"
        aria-label={`Open ${title}`}
        onClick={onOpen}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "fd-type-label min-w-0 flex-1 truncate",
              muted ? "text-fg-secondary" : "text-fg-primary",
            )}
          >
            {title}
          </span>
          {extensionOwned ? <Badge variant="default">Extension</Badge> : null}
          {elevated ? <Badge variant="danger">Elevated</Badge> : null}
          <span
            className={cn(
              "fd-type-meta shrink-0 tabular-nums",
              whenOverdue ? "text-danger" : "text-fg-muted",
            )}
            title={whenTitle}
          >
            {whenLabel}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className="fd-type-meta min-w-0 flex-1 truncate text-fg-muted">
            {cadence}
          </span>
          {projectLabel ? (
            <span className="fd-type-meta max-w-[10rem] shrink-0 truncate text-fg-muted">
              {projectLabel}
            </span>
          ) : null}
          {hostLabel ? (
            <span
              className={cn(
                "fd-type-meta max-w-[9rem] shrink-0 truncate",
                hostOffline ? "text-danger" : "text-fg-muted",
              )}
            >
              {hostLabel}
              {hostOffline ? " · Offline" : ""}
            </span>
          ) : null}
          {attention ? (
            <span
              className={cn(
                "fd-type-meta shrink-0",
                attentionTone === "warning" ? "text-warning" : "text-danger",
              )}
            >
              {attention}
            </span>
          ) : null}
        </span>
      </button>
      <div className="flex shrink-0 items-start">
        {extensionOwned ? (
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open extension
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Run ${title} now`}
              disabled={!online || busy}
              className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
              onClick={onRun}
            >
              <Play className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${paused ? "Resume" : "Pause"} ${title}`}
              disabled={!online || busy || !canToggle}
              className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
              onClick={onToggle}
            >
              {paused ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
            </Button>
            <Popover.Root modal={false} open={menuOpen} onOpenChange={onMenuOpenChange}>
              <Popover.Trigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={`More actions for ${title}`}
                  className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={6}
                  className="z-50 p-0"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <AutomationRowMenuContent
                    title={title}
                    paused={paused}
                    online={online}
                    canToggle={canToggle}
                    onClose={() => onMenuOpenChange(false)}
                    onRun={onRun}
                    onEdit={onEdit}
                    onToggle={onToggle}
                    onDelete={onDelete}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </>
        )}
      </div>
    </article>
  );
}
