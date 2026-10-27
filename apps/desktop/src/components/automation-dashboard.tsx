import { useId, useState, type ReactNode } from "react";
import { Activity, AlertCircle, CalendarClock, ChevronDown, Clock3 } from "lucide-react";
import { Card, cn } from "@falcondeck/ui";
import type { AutomationEntryGroup, summarizeAutomationEntries } from "./automation-list-model";

export type AutomationOverviewSelection = "active" | "due" | "running" | "attention";

const OVERVIEW_ITEMS = [
  { key: "active", label: "Active", hint: "Schedules enabled", action: "Show active automations", icon: CalendarClock },
  { key: "due", label: "Due in 24h", hint: "Upcoming automations", action: "Show automations due in 24 hours", icon: Clock3 },
  { key: "running", label: "Running", hint: "Including queued", action: "Show running or queued automations", icon: Activity },
  { key: "attention", label: "Needs attention", hint: "Failed or waiting for input", action: "Show automations needing attention", icon: AlertCircle },
] as const;

export function AutomationOverview({ summary, selection, onSelect }: {
  summary: ReturnType<typeof summarizeAutomationEntries>;
  selection: AutomationOverviewSelection | null;
  onSelect: (selection: AutomationOverviewSelection) => void;
}) {
  return (
    <section aria-label="Automation overview" className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {OVERVIEW_ITEMS.map(({ key, label, hint, action, icon: Icon }) => (
        <Card key={key} className={cn("overflow-hidden", selection === key && "border-border-strong bg-surface-2")}>
          <button
            type="button"
            className="fd-focus-inset flex h-full w-full flex-col p-4 text-left transition-colors hover:bg-interactive-hover"
            aria-label={`${action} (${summary[key]})`}
            aria-pressed={selection === key}
            onClick={() => onSelect(key)}
          >
            <span className="fd-type-meta flex w-full items-center gap-2 text-fg-secondary">
              <Icon aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", key === "attention" && summary.attention > 0 && "text-warning")} />
              {label}
            </span>
            <span className={cn("mt-2 text-2xl font-semibold tabular-nums leading-none", key === "attention" && summary.attention > 0 ? "text-warning" : "text-fg-primary")}>
              {summary[key]}
            </span>
            <span className="fd-type-meta mt-2 text-fg-muted">{hint}</span>
          </button>
        </Card>
      ))}
    </section>
  );
}

export function AutomationGroup({ group, children }: {
  group: AutomationEntryGroup;
  children: () => ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  return (
    <Card className="overflow-hidden border-border-subtle bg-surface-2">
      {group.label ? (
        <h2>
          <button
            type="button"
            aria-label={`${group.label}, ${group.entries.length} ${group.entries.length === 1 ? "automation" : "automations"}${group.description ? `, ${group.description}` : ""}`}
            aria-expanded={expanded}
            aria-controls={contentId}
            className="fd-focus-inset flex w-full items-center gap-2.5 bg-surface-1 px-4 py-3 text-left hover:bg-interactive-hover"
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform", !expanded && "-rotate-90")} />
            <span className="fd-type-eyebrow min-w-0 truncate text-fg-secondary" title={group.label}>{group.label}</span>
            <span className="fd-type-meta shrink-0 text-fg-muted">{group.entries.length}</span>
            {group.description ? <span className="fd-type-meta ml-auto min-w-0 truncate text-fg-muted" title={group.description}>{group.description}</span> : null}
          </button>
        </h2>
      ) : null}
      <div id={contentId} hidden={!expanded} className={cn("divide-y divide-border-subtle", group.label && expanded && "border-t border-border-subtle")}>
        {expanded ? children() : null}
      </div>
    </Card>
  );
}
