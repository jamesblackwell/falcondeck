/**
 * Shared types for the FalconDeck agent control interface.
 *
 * These mirror `falcondeck-core/src/control.rs` exactly: snake_case field
 * names, tagged unions with a `kind` discriminant, and string-constant
 * unions for the snake_case enums.
 */

export type AgentControlSettings = {
  enabled: boolean;
  providers: Record<string, ProviderControlSettings>;
  default_timezone: string;
  allow_elevated_automations: boolean;
  inject_agent_context: boolean;
  confirmation_policy: ConfirmationPolicy;
};

export type ProviderControlSettings = {
  enabled: boolean;
};

export type ConfirmationPolicy = {
  destructive_operations: boolean;
  sensitive_operations: boolean;
};

export type AutomationState = "enabled" | "paused" | "completed" | "failed";

export type AutomationConcurrencyPolicy = "skip" | "queue_one" | "allow";

export type AutomationMisfirePolicy = "skip" | "run_once";

export type AutomationTrigger =
  | { kind: "once"; run_at: string }
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "interval"; every_seconds: number; anchor_at: string };

export type AutomationTask =
  | { kind: "prompt"; instruction: string }
  | {
      kind: "conditional_prompt";
      instruction: string;
      no_action_marker: string;
    };

export type AutomationThreadTarget =
  | { kind: "managed"; thread_id?: string | null }
  | { kind: "existing"; thread_id: string }
  | { kind: "new_each_run" };

export type AutomationTarget = {
  workspace_path: string;
  provider: string;
  /** Omitted from automation list rows; present on single reads. */
  thread?: AutomationThreadTarget;
  model_id?: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
  reasoning_effort?: string | null;
  collaboration_mode_id?: string | null;
  approval_policy?: string | null;
  isolation?: "project_folder" | "isolated" | null;
  selected_skills?: string[];
};

export type AutomationRunTrigger = "scheduled" | "late" | "manual";

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "succeeded_no_action"
  | "failed"
  | "skipped_overlap"
  | "skipped_dependency"
  | "cancelled";

export type AutomationOutcomeSummary = {
  status: AutomationRunStatus;
  finished_at: string;
  preview?: string | null;
};

export type AutomationOwner = {
  extension_id: string;
  resource_id: string;
};

/**
 * A single automation. List responses return a summary projection that
 * omits `task`, `target.thread`, `created_at` and `updated_at`
 * (`DEFAULT_AUTOMATION_LIST_FIELDS` in the daemon); those fields are only
 * guaranteed on single-automation reads and mutation responses.
 */
export type Automation = {
  id: string;
  revision: number;
  owner?: AutomationOwner | null;
  name: string;
  description?: string | null;
  trigger: AutomationTrigger;
  task?: AutomationTask;
  target: AutomationTarget;
  state: AutomationState;
  concurrency_policy: AutomationConcurrencyPolicy;
  misfire_policy: AutomationMisfirePolicy;
  elevated: boolean;
  required_connectors: string[];
  created_at?: string;
  updated_at?: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  latest_outcome?: AutomationOutcomeSummary | null;
  /** Human-readable schedule summary added by list and read responses. */
  resolved_schedule?: string;
};

export type AutomationRun = {
  id: string;
  automation_id: string;
  automation_name: string;
  automation_revision: number;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  scheduled_for?: string | null;
  queued_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  runtime_workspace_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  outcome_preview?: string | null;
  error?: ControlErrorDetail | null;
};

export type ControlOrigin =
  | "desktop_ui"
  | "mcp"
  | "remote_rpc"
  | "scheduler"
  | "system";

export type ControlRequestContext = {
  origin: ControlOrigin;
  provider?: string | null;
  workspace_path?: string | null;
  thread_id?: string | null;
  device_id?: string | null;
};

export type AuditResult = "success" | "failure";

export type ControlAuditEntry = {
  id: string;
  occurred_at: string;
  context: ControlRequestContext;
  operation: string;
  resource_type?: string | null;
  resource_id?: string | null;
  result: AuditResult;
  summary: string;
};

export type FieldError = {
  field: string;
  message: string;
};

export type ControlErrorDetail = {
  code: string;
  message: string;
  retryable: boolean;
  field_errors: FieldError[];
  current_revision?: number | null;
  suggested_action?: string | null;
};

export type ControlDomain = "settings" | "automations" | "runs" | "audit";

export type ControlStateChanged = {
  store_revision: number;
  domains: ControlDomain[];
};

export type CapabilityBehaviorInfo = {
  read_only: boolean;
  destructive: boolean;
  idempotent: boolean;
  confirmation_class: "none" | "mutation" | "sensitive" | "destructive";
};

export type CapabilityExampleInfo = {
  description: string;
  arguments: Record<string, unknown>;
};

export type CapabilitySummary = {
  operation: string;
  title: string;
  description: string;
  domain: string;
  behavior: CapabilityBehaviorInfo;
  related_operations: string[];
  available: boolean;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  examples?: CapabilityExampleInfo[];
};

export type SearchDetail = "summary" | "full";

export type ControlSearchRequest = {
  query?: string;
  domain?: string;
  operation?: string;
  detail?: SearchDetail;
  limit?: number;
};

export type ControlSearchResponse = {
  results: CapabilitySummary[];
};

export type ControlGetRequest = {
  resource: string;
  id?: string;
  filters?: Record<string, unknown>;
  fields?: string[];
  cursor?: string;
  limit?: number;
};

export type ControlGetResponse = {
  resource: string;
  data: unknown;
  next_cursor?: string | null;
};

export type ControlExecuteRequest = {
  operation: string;
  arguments: Record<string, unknown>;
  expected_revision?: number;
  idempotency_key?: string;
};

export type ControlExecuteResponse = {
  ok: boolean;
  operation: string;
  data?: unknown;
  error?: ControlErrorDetail;
};

export class ControlOperationError extends Error {
  readonly detail: ControlErrorDetail;

  constructor(detail: ControlErrorDetail) {
    super(detail.message);
    this.name = "ControlOperationError";
    this.detail = detail;
  }
}

/**
 * Providers the control and automation editors always list. AgentProvider is
 * an open identifier, so a stored or workspace id that is not in this list is
 * still prepended — otherwise a native `<select>` paints the first option
 * (codex) while the draft remains grok.
 */
export const CONTROL_PROVIDER_CHOICES = [
  "codex",
  "claude",
  "grok",
  "agy",
] as const;

export function controlProviderChoices(
  current?: string | null,
  extra: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const id of [current ?? "", ...extra, ...CONTROL_PROVIDER_CHOICES]) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    choices.push(trimmed);
  }
  return choices;
}

const AUTOMATION_STATES: ReadonlySet<string> = new Set([
  "enabled",
  "paused",
  "completed",
  "failed",
]);

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "succeeded_no_action",
  "failed",
  "skipped_overlap",
  "skipped_dependency",
  "cancelled",
]);

const CONTROL_ORIGINS: ReadonlySet<string> = new Set([
  "desktop_ui",
  "mcp",
  "remote_rpc",
  "scheduler",
  "system",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeControlErrorDetail(
  value: unknown,
): ControlErrorDetail | null {
  if (!isRecord(value)) return null;
  const detail = value as Partial<ControlErrorDetail>;
  if (
    typeof detail.code !== "string" ||
    typeof detail.message !== "string" ||
    typeof detail.retryable !== "boolean"
  ) {
    return null;
  }
  return {
    code: detail.code,
    message: detail.message,
    retryable: detail.retryable,
    field_errors: Array.isArray(detail.field_errors)
      ? detail.field_errors.filter(
          (error): error is FieldError =>
            isRecord(error) &&
            typeof error.field === "string" &&
            typeof error.message === "string",
        )
      : [],
    current_revision:
      typeof detail.current_revision === "number"
        ? detail.current_revision
        : null,
    suggested_action:
      typeof detail.suggested_action === "string"
        ? detail.suggested_action
        : null,
  };
}

export function normalizeAutomationTrigger(
  value: unknown,
): AutomationTrigger | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "once":
      return typeof value.run_at === "string"
        ? { kind: "once", run_at: value.run_at }
        : null;
    case "cron":
      return typeof value.expression === "string" &&
        typeof value.timezone === "string"
        ? {
            kind: "cron",
            expression: value.expression,
            timezone: value.timezone,
          }
        : null;
    case "interval":
      return typeof value.every_seconds === "number" &&
        typeof value.anchor_at === "string"
        ? {
            kind: "interval",
            every_seconds: value.every_seconds,
            anchor_at: value.anchor_at,
          }
        : null;
    default:
      return null;
  }
}

export function normalizeAutomationTask(value: unknown): AutomationTask | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "prompt":
      return typeof value.instruction === "string"
        ? { kind: "prompt", instruction: value.instruction }
        : null;
    case "conditional_prompt":
      return typeof value.instruction === "string" &&
        typeof value.no_action_marker === "string"
        ? {
            kind: "conditional_prompt",
            instruction: value.instruction,
            no_action_marker: value.no_action_marker,
          }
        : null;
    default:
      return null;
  }
}

export function normalizeAutomation(value: unknown): Automation | null {
  if (!isRecord(value)) return null;
  const automation = value as Partial<Automation>;
  if (
    typeof automation.id !== "string" ||
    typeof automation.revision !== "number" ||
    typeof automation.name !== "string" ||
    typeof automation.state !== "string" ||
    !AUTOMATION_STATES.has(automation.state) ||
    normalizeAutomationTrigger(automation.trigger) === null ||
    !isRecord(automation.target) ||
    typeof automation.target.workspace_path !== "string" ||
    typeof automation.target.provider !== "string"
  ) {
    return null;
  }
  // List rows are a summary projection: task, target.thread and the
  // timestamps are only present on single reads. Validate them when present.
  if (
    (automation.task !== undefined &&
      normalizeAutomationTask(automation.task) === null) ||
    (automation.target.thread !== undefined &&
      !isRecord(automation.target.thread)) ||
    (automation.updated_at !== undefined &&
      typeof automation.updated_at !== "string")
  ) {
    return null;
  }
  return automation as Automation;
}

export function normalizeAutomationRun(value: unknown): AutomationRun | null {
  if (!isRecord(value)) return null;
  const run = value as Partial<AutomationRun>;
  if (
    typeof run.id !== "string" ||
    typeof run.automation_id !== "string" ||
    typeof run.automation_name !== "string" ||
    typeof run.automation_revision !== "number" ||
    typeof run.status !== "string" ||
    !RUN_STATUSES.has(run.status) ||
    typeof run.queued_at !== "string"
  ) {
    return null;
  }
  const trigger =
    run.trigger === "scheduled" ||
    run.trigger === "late" ||
    run.trigger === "manual"
      ? run.trigger
      : "scheduled";
  return { ...run, trigger } as AutomationRun;
}

export function normalizeAgentControlSettings(
  value: unknown,
): AgentControlSettings | null {
  if (!isRecord(value)) return null;
  const settings = value as Partial<AgentControlSettings>;
  if (
    typeof settings.enabled !== "boolean" ||
    typeof settings.default_timezone !== "string" ||
    typeof settings.allow_elevated_automations !== "boolean" ||
    !isRecord(settings.confirmation_policy) ||
    typeof settings.confirmation_policy.destructive_operations !==
      "boolean" ||
    typeof settings.confirmation_policy.sensitive_operations !== "boolean" ||
    (settings.inject_agent_context !== undefined &&
      typeof settings.inject_agent_context !== "boolean")
  ) {
    return null;
  }
  const providers: Record<string, ProviderControlSettings> = {};
  if (isRecord(settings.providers)) {
    for (const [provider, entry] of Object.entries(settings.providers)) {
      if (isRecord(entry) && typeof entry.enabled === "boolean") {
        providers[provider] = { enabled: entry.enabled };
      }
    }
  }
  return {
    enabled: settings.enabled,
    providers,
    default_timezone: settings.default_timezone,
    allow_elevated_automations: settings.allow_elevated_automations,
    // Older daemons predate the field; it defaults to on there too.
    inject_agent_context: settings.inject_agent_context ?? true,
    confirmation_policy: {
      destructive_operations:
        settings.confirmation_policy.destructive_operations,
      sensitive_operations: settings.confirmation_policy.sensitive_operations,
    },
  };
}

export function normalizeControlAuditEntry(
  value: unknown,
): ControlAuditEntry | null {
  if (!isRecord(value)) return null;
  const entry = value as Partial<ControlAuditEntry>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.occurred_at !== "string" ||
    !isRecord(entry.context) ||
    typeof entry.context.origin !== "string" ||
    !CONTROL_ORIGINS.has(entry.context.origin) ||
    typeof entry.operation !== "string" ||
    (entry.result !== "success" && entry.result !== "failure") ||
    typeof entry.summary !== "string"
  ) {
    return null;
  }
  return entry as ControlAuditEntry;
}

export function normalizeControlStateChanged(
  value: unknown,
): ControlStateChanged | null {
  if (!isRecord(value)) return null;
  const change = value as Partial<ControlStateChanged>;
  if (
    typeof change.store_revision !== "number" ||
    !Array.isArray(change.domains)
  ) {
    return null;
  }
  return change as ControlStateChanged;
}
