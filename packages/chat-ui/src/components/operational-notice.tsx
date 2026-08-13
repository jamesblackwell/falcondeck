import { useState } from "react";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";

import {
  serviceMessagePresentation,
  type OperationalCondition,
} from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

import { CodeBlock } from "./code-block";

export function OperationalNotice({
  conditions,
  onDismiss,
}: {
  conditions: readonly OperationalCondition[];
  onDismiss: (condition: OperationalCondition) => void;
}) {
  const notice = conditions[0];
  const [detailOpen, setDetailOpen] = useState(false);
  if (!notice) return null;
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
        {conditions.length > 1 ? (
          <details className="mt-2 border-t border-border-subtle pt-2">
            <summary className="fd-focus cursor-pointer font-medium text-fg-secondary">
              {conditions.length} active issues
            </summary>
            <ul className="mt-2 space-y-2">
              {conditions.map((condition) => {
                const conditionPresentation = serviceMessagePresentation(
                  condition.level,
                  condition.message,
                );
                return (
                  <li
                    key={condition.id}
                    className="flex items-start gap-2 rounded-[var(--fd-radius-sm)] bg-surface-2 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 whitespace-pre-wrap">
                      {conditionPresentation.message}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDismiss(condition)}
                      className="fd-focus shrink-0 text-fg-muted hover:text-fg-primary"
                      aria-label={`Dismiss issue: ${conditionPresentation.message}`}
                    >
                      Dismiss
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(notice)}
        aria-label="Dismiss issue"
        className="-m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted hover:bg-surface-3 hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
