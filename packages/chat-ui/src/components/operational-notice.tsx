import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";

import {
  groupOperationalConditions,
  serviceMessagePresentation,
  type OperationalCondition,
} from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

import { CodeBlock } from "./code-block";

/**
 * How long a non-blocking notice stays up before it retires itself. Warnings
 * report the environment (a connector that did not come up), not a failure of
 * the work in front of the user, so they behave like a toast rather than a
 * banner that has to be clicked away on every launch.
 */
const AUTO_DISMISS_MS = 8000;

export function OperationalNotice({
  conditions,
  onDismiss,
}: {
  conditions: readonly OperationalCondition[];
  onDismiss: (condition: OperationalCondition) => void;
}) {
  const groups = groupOperationalConditions(conditions);
  const lead = groups[0];
  const [detailOpen, setDetailOpen] = useState(false);
  // Errors are the only tier that waits for acknowledgement.
  const transient = conditions.every((condition) => condition.level !== "error");
  // Version-keyed so a re-reported condition restarts the timer instead of
  // riding out the previous one's remainder.
  const versionKey = conditions
    .map((condition) => `${condition.id}:${condition.updated_at}`)
    .join("|");
  useEffect(() => {
    if (!transient || !versionKey) return;
    const timer = setTimeout(() => {
      for (const condition of conditions) onDismiss(condition);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transient, versionKey]);
  if (!lead) return null;
  const notice = lead.conditions[0]!;
  const presentation = serviceMessagePresentation(notice.level, notice.message);
  const headline = lead.summary ?? presentation.message;
  const Icon =
    notice.level === "error"
      ? AlertCircle
      : notice.level === "warning"
        ? AlertTriangle
        : Info;
  const remainder = groups.slice(1);
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
        <p>{headline}</p>
        {lead.summary ? (
          <details className="mt-1">
            <summary className="fd-focus cursor-pointer text-fg-muted">
              {conditionSubjects(lead.conditions)}
            </summary>
            <ConditionList
              conditions={lead.conditions}
              onDismiss={onDismiss}
              className="mt-2"
            />
          </details>
        ) : null}
        {!lead.summary && presentation.rawDetail ? (
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
        {remainder.length > 0 ? (
          <details className="mt-2 border-t border-border-subtle pt-2">
            <summary className="fd-focus cursor-pointer font-medium text-fg-secondary">
              {remainder.length === 1
                ? "1 other issue"
                : `${remainder.length} other issues`}
            </summary>
            <ConditionList
              conditions={remainder.flatMap((group) => group.conditions)}
              onDismiss={onDismiss}
              className="mt-2"
            />
          </details>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => {
          for (const condition of lead.conditions) onDismiss(condition);
        }}
        aria-label="Dismiss issue"
        className="-m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted hover:bg-surface-3 hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/** The names a grouped family failed on, taken from each condition's key. */
function conditionSubjects(conditions: readonly OperationalCondition[]) {
  return conditions
    .map((condition) => condition.key.slice(condition.key.indexOf(":") + 1))
    .join(", ");
}

function ConditionList({
  conditions,
  onDismiss,
  className,
}: {
  conditions: readonly OperationalCondition[];
  onDismiss: (condition: OperationalCondition) => void;
  className?: string;
}) {
  return (
    <ul className={cn("space-y-2", className)}>
      {conditions.map((condition) => {
        const presentation = serviceMessagePresentation(
          condition.level,
          condition.message,
        );
        return (
          <li
            key={condition.id}
            className="flex items-start gap-2 rounded-[var(--fd-radius-sm)] bg-surface-2 px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap">
              {presentation.message}
            </span>
            <button
              type="button"
              onClick={() => onDismiss(condition)}
              className="fd-focus shrink-0 text-fg-muted hover:text-fg-primary"
              aria-label={`Dismiss issue: ${presentation.message}`}
            >
              Dismiss
            </button>
          </li>
        );
      })}
    </ul>
  );
}
