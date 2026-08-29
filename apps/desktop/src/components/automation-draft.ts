import type { AgentControlSettings, Automation } from "@falcondeck/client-core";

export type AutomationEditorState =
  | { kind: "closed" }
  | { kind: "create"; draft: AutomationDraft }
  | { kind: "edit"; id: string; revision: number; draft: AutomationDraft };

export type AutomationDraft = {
  name: string;
  description: string;
  scheduleKind: "cron" | "interval" | "once";
  expression: string;
  timezone: string;
  everySeconds: string;
  runAt: string;
  instruction: string;
  conditional: boolean;
  noActionMarker: string;
  workspacePath: string;
  provider: string;
  threadKind: "managed" | "existing" | "new_each_run";
  /** Preserved managed/existing thread id so edits never reset the thread. */
  threadId: string;
  modelId: string;
  permissionMode: string;
  sandboxMode: string;
  reasoningEffort: string;
  collaborationModeId: string;
  approvalPolicy: string;
  isolation: "project_folder" | "isolated";
  requiredConnectors: string;
  selectedSkills: string;
  concurrencyPolicy: "skip" | "queue_one" | "allow";
  misfirePolicy: "skip" | "run_once";
  /** Preserved interval anchor so edits never shift the schedule grid. */
  anchorAt: string;
};

export function emptyAutomationDraft(
  settings: AgentControlSettings | null,
  workspacePath = "",
): AutomationDraft {
  return {
    name: "",
    description: "",
    scheduleKind: "cron",
    expression: "0 8 * * 1-5",
    timezone: settings?.default_timezone ?? "Europe/London",
    everySeconds: "3600",
    runAt: "",
    instruction: "",
    conditional: false,
    noActionMarker: "FALCONDECK_NO_ACTION",
    workspacePath,
    provider: "codex",
    threadKind: "managed",
    threadId: "",
    modelId: "",
    permissionMode: "",
    sandboxMode: "",
    reasoningEffort: "",
    collaborationModeId: "",
    approvalPolicy: "",
    isolation: "project_folder",
    requiredConnectors: "",
    selectedSkills: "",
    concurrencyPolicy: "skip",
    misfirePolicy: "skip",
    anchorAt: "",
  };
}

export function automationDraftFrom(automation: Automation): AutomationDraft {
  // Drafts are built from single-automation reads, which always carry the
  // task and thread; list rows omit them, so fall back to editor defaults.
  const task = automation.task ?? { kind: "prompt", instruction: "" };
  const thread = automation.target.thread ?? { kind: "managed" };
  return {
    name: automation.name,
    description: automation.description ?? "",
    scheduleKind: automation.trigger.kind,
    expression:
      automation.trigger.kind === "cron" ? automation.trigger.expression : "",
    timezone:
      automation.trigger.kind === "cron" ? automation.trigger.timezone : "",
    everySeconds:
      automation.trigger.kind === "interval"
        ? String(automation.trigger.every_seconds)
        : "3600",
    runAt: automation.trigger.kind === "once" ? automation.trigger.run_at : "",
    instruction: task.instruction,
    conditional: task.kind === "conditional_prompt",
    noActionMarker:
      task.kind === "conditional_prompt" ? task.no_action_marker : "",
    workspacePath: automation.target.workspace_path,
    provider: automation.target.provider,
    threadKind: thread.kind,
    threadId:
      thread.kind === "managed" || thread.kind === "existing"
        ? (thread.thread_id ?? "")
        : "",
    modelId: automation.target.model_id ?? "",
    permissionMode: automation.target.permission_mode ?? "",
    sandboxMode: automation.target.sandbox_mode ?? "",
    reasoningEffort: automation.target.reasoning_effort ?? "",
    collaborationModeId: automation.target.collaboration_mode_id ?? "",
    approvalPolicy: automation.target.approval_policy ?? "",
    isolation: automation.target.isolation ?? "project_folder",
    requiredConnectors: automation.required_connectors.join(", "),
    selectedSkills: (automation.target.selected_skills ?? []).join(", "),
    concurrencyPolicy: automation.concurrency_policy,
    misfirePolicy: automation.misfire_policy,
    anchorAt:
      automation.trigger.kind === "interval"
        ? automation.trigger.anchor_at
        : "",
  };
}

function draftTrigger(draft: AutomationDraft): Record<string, unknown> {
  return draft.scheduleKind === "cron"
    ? {
        kind: "cron",
        expression: draft.expression.trim(),
        timezone: draft.timezone.trim(),
      }
    : draft.scheduleKind === "interval"
      ? {
          kind: "interval",
          every_seconds: Number(draft.everySeconds) || 0,
          // Editing must never shift the schedule grid: keep the stored
          // anchor and only fall back to now for brand-new automations.
          anchor_at: draft.anchorAt.trim() || new Date().toISOString(),
        }
      : { kind: "once", run_at: draft.runAt.trim() };
}

export function automationDraftArguments(
  draft: AutomationDraft,
): Record<string, unknown> {
  const task = draft.conditional
    ? {
        kind: "conditional_prompt",
        instruction: draft.instruction,
        no_action_marker: draft.noActionMarker.trim(),
      }
    : { kind: "prompt", instruction: draft.instruction };
  return {
    name: draft.name.trim(),
    // Always send the description so edits can clear it; the daemon treats
    // an absent field as keep-current.
    description: draft.description.trim(),
    trigger: draftTrigger(draft),
    task,
    target: {
      workspace_path: draft.workspacePath.trim(),
      provider: draft.provider,
      thread:
        draft.threadKind === "managed"
          ? {
              kind: "managed",
              ...(draft.threadId.trim()
                ? { thread_id: draft.threadId.trim() }
                : {}),
            }
          : draft.threadKind === "existing"
            ? { kind: "existing", thread_id: draft.threadId.trim() }
            : { kind: "new_each_run" },
      ...(draft.modelId.trim() ? { model_id: draft.modelId.trim() } : {}),
      ...(draft.permissionMode.trim()
        ? { permission_mode: draft.permissionMode.trim() }
        : {}),
      ...(draft.sandboxMode.trim()
        ? { sandbox_mode: draft.sandboxMode.trim() }
        : {}),
      ...(draft.reasoningEffort.trim()
        ? { reasoning_effort: draft.reasoningEffort.trim() }
        : {}),
      ...(draft.collaborationModeId.trim()
        ? { collaboration_mode_id: draft.collaborationModeId.trim() }
        : {}),
      ...(draft.approvalPolicy.trim()
        ? { approval_policy: draft.approvalPolicy.trim() }
        : {}),
      isolation: draft.isolation,
      selected_skills: draft.selectedSkills
        .split(",")
        .map((skill) => skill.trim())
        .filter(Boolean),
    },
    required_connectors: draft.requiredConnectors
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    concurrency_policy: draft.concurrencyPolicy,
    misfire_policy: draft.misfirePolicy,
  };
}

export function draftIsSubmittable(draft: AutomationDraft): string | null {
  if (!draft.name.trim()) return "A name is required.";
  if (!draft.instruction.trim()) return "An instruction is required.";
  if (!draft.workspacePath.trim().startsWith("/"))
    return "Workspace path must be absolute.";
  if (
    draft.scheduleKind === "cron" &&
    draft.expression.trim().split(/\s+/).length !== 5
  ) {
    return "Cron expressions use exactly five fields.";
  }
  if (
    draft.scheduleKind === "interval" &&
    Number(draft.everySeconds) < 60
  ) {
    return "Intervals must be at least 60 seconds.";
  }
  if (draft.scheduleKind === "once" && !draft.runAt.trim()) {
    return "A one-time schedule needs an RFC 3339 timestamp with an offset.";
  }
  if (draft.conditional && !draft.noActionMarker.trim()) {
    return "Conditional automations need a no-action marker.";
  }
  return null;
}

export function draftIsElevated(draft: AutomationDraft): boolean {
  return [draft.permissionMode.trim(), draft.sandboxMode.trim()].some((mode) =>
    ["bypassPermissions", "danger-full-access"].includes(mode),
  );
}
