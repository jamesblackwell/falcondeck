import { useState } from "react";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";

import {
  serviceMessagePresentation,
  type ServiceNotice,
} from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

import { CodeBlock } from "./code-block";

export function OperationalNotice({
  notice,
  onDismiss,
}: {
  notice: ServiceNotice;
  onDismiss: (noticeId: string) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = serviceMessagePresentation(notice.level, notice.message);
  const Icon =
    notice.level === "error"
      ? AlertCircle
      : notice.level === "warning"
        ? AlertTriangle
        : Info;
  return (
    <div
      role={notice.level === "error" ? "alert" : "status"}
      aria-live={notice.level === "error" ? "assertive" : "polite"}
      className={cn(
        "mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-[var(--fd-radius-md)] border px-3 py-2 text-[length:var(--fd-text-xs)]",
        notice.level === "error" && "border-danger/30 bg-danger/5 text-danger",
        notice.level === "warning" &&
          "border-warning/30 bg-warning/5 text-warning",
        notice.level === "info" &&
          "border-border-subtle bg-surface-2 text-fg-secondary",
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap text-fg-secondary">
        <p>{presentation.message}</p>
        {presentation.rawDetail ? (
          <details open={detailOpen} className="mt-1">
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
      </div>
      <button
        type="button"
        onClick={() => onDismiss(notice.id)}
        aria-label="Dismiss notice"
        className="-m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted hover:bg-surface-3 hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
