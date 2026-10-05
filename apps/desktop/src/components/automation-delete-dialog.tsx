import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { Button } from "@falcondeck/ui";

export function AutomationDeleteDialog({
  title, busy, onCancel, onDelete,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-6"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onCancel();
        }
        if (event.key === "Tab") {
          event.preventDefault();
          if (document.activeElement === cancelRef.current) deleteRef.current?.focus();
          else cancelRef.current?.focus();
        }
      }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-md rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="mb-4 inline-flex rounded-[var(--fd-radius-lg)] bg-danger-muted p-2.5 text-danger">
          <Trash2 aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 id={titleId} className="fd-type-heading fd-type-heading--sm text-fg-primary">Delete automation?</h2>
        <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-fg-secondary">
          <span className="font-medium text-fg-primary">{title}</span> will be permanently removed.
          {" "}Its schedule will stop. Previously generated tasks and their history will be kept.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button ref={deleteRef} variant="danger" disabled={busy} onClick={onDelete}>
            {busy ? "Deleting…" : "Delete automation"}
          </Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
