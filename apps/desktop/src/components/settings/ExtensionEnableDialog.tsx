import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@falcondeck/ui";

export function ExtensionEnableDialog({
  name,
  permissions,
  busy,
  error,
  onCancel,
  onAllow,
}: {
  name: string;
  permissions: Array<{ id: string; title: string; description: string }>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAllow: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
    else cancelRef.current?.focus();
  }, [busy]);

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
          if (busy) return;
          if (document.activeElement === cancelRef.current) {
            allowRef.current?.focus();
          } else {
            cancelRef.current?.focus();
          }
        }
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]"
      >
        <h2 id={titleId} className="fd-type-heading fd-type-heading--sm text-fg-primary">
          Enable {name}?
        </h2>
        <p id={descriptionId} className="mt-2 text-sm text-fg-secondary">
          Allow these permissions to enable {name}. You can revoke them in Extensions.
        </p>
        <ul className="mt-4 space-y-3">
          {permissions.map((permission) => (
            <li key={permission.id} className="rounded-[var(--fd-radius-md)] bg-surface-2 p-3">
              <p className="text-sm font-medium text-fg-primary">{permission.title}</p>
              <p className="mt-1 text-sm text-fg-secondary">{permission.description}</p>
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-danger">{error}</p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={allowRef} type="button" disabled={busy} onClick={onAllow}>
            {busy ? "Enabling…" : "Allow and enable"}
          </Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
