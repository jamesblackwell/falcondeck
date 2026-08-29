import { describe, expect, it } from "vitest";

import {
  normalizeAgentControlSettings,
  normalizeAutomation,
  normalizeAutomationRun,
  normalizeControlAuditEntry,
  normalizeControlErrorDetail,
  normalizeControlStateChanged,
} from "./control";

const automation = {
  id: "automation-9fc78b39",
  revision: 3,
  name: "Weekday inbox review",
  description: null,
  trigger: { kind: "cron", expression: "0 8 * * 1-5", timezone: "Europe/London" },
  task: {
    kind: "conditional_prompt",
    instruction: "Review my inbox.",
    no_action_marker: "FALCONDECK_NO_ACTION",
  },
  target: {
    workspace_path: "/Users/james/Code/quizgecko",
    provider: "codex",
    thread: { kind: "managed", thread_id: null },
    model_id: null,
    permission_mode: null,
    sandbox_mode: "workspace-write",
    selected_skills: [],
  },
  state: "enabled",
  concurrency_policy: "skip",
  misfire_policy: "skip",
  elevated: false,
  required_connectors: ["gmail"],
  created_at: "2026-08-16T14:00:00Z",
  updated_at: "2026-08-16T14:22:10Z",
  next_run_at: "2026-08-17T07:00:00Z",
  last_run_at: null,
  latest_outcome: null,
};

describe("normalizeAutomation", () => {
  it("accepts a well-formed automation", () => {
    expect(normalizeAutomation(automation)).toEqual(automation);
  });

  it("accepts a daemon list-projection row (no task, thread or timestamps)", () => {
    // Mirrors DEFAULT_AUTOMATION_LIST_FIELDS in the daemon's control store.
    const listRow = {
      id: "automation-9fc78b39",
      revision: 3,
      name: "Weekday inbox review",
      state: "enabled",
      trigger: {
        kind: "cron",
        expression: "0 8 * * 1-5",
        timezone: "Europe/London",
      },
      target: {
        provider: "codex",
        workspace_path: "/Users/james/Code/quizgecko",
      },
      elevated: false,
      required_connectors: [],
      concurrency_policy: "skip",
      misfire_policy: "skip",
      next_run_at: "2026-08-30T07:00:00Z",
      last_run_at: "2026-08-29T07:00:00Z",
      latest_outcome: {
        status: "succeeded",
        finished_at: "2026-08-29T07:00:31Z",
        preview: "Done.",
      },
      resolved_schedule: 'cron "0 8 * * 1-5" (Europe/London)',
    };
    expect(normalizeAutomation(listRow)).toEqual(listRow);
  });

  it.each([
    ["unknown state", { ...automation, state: "bogus" }],
    ["malformed task when present", { ...automation, task: { kind: "prompt" } }],
    ["malformed updated_at when present", { ...automation, updated_at: 42 }],
    ["missing name", { ...automation, name: undefined }],
    [
      "malformed trigger",
      { ...automation, trigger: { kind: "once", expression: "x" } },
    ],
    [
      "missing target provider",
      { ...automation, target: { ...automation.target, provider: undefined } },
    ],
    ["array input", [] as unknown],
    ["null input", null],
  ])("rejects %s", (_label, value) => {
    expect(normalizeAutomation(value)).toBeNull();
  });
});

describe("normalizeAutomationRun", () => {
  it("accepts a run and rejects unknown statuses", () => {
    const run = {
      id: "run-1",
      automation_id: "automation-9fc78b39",
      automation_name: "Weekday inbox review",
      automation_revision: 3,
      status: "succeeded_no_action",
      queued_at: "2026-08-17T07:00:01Z",
    };
    expect(normalizeAutomationRun(run)).toEqual({
      ...run,
      trigger: "scheduled",
    });
    expect(normalizeAutomationRun({ ...run, trigger: "manual" })).toEqual({
      ...run,
      trigger: "manual",
    });
    expect(
      normalizeAutomationRun({ ...run, status: "exploded" }),
    ).toBeNull();
  });
});

describe("normalizeAgentControlSettings", () => {
  it("keeps provider overrides that parse and drops junk entries", () => {
    const settings = normalizeAgentControlSettings({
      enabled: true,
      providers: {
        claude: { enabled: false },
        codex: { enabled: true },
        broken: { enabled: "yes" },
      },
      default_timezone: "Europe/London",
      allow_elevated_automations: false,
      confirmation_policy: {
        destructive_operations: true,
        sensitive_operations: true,
      },
    });
    expect(settings?.providers).toEqual({
      claude: { enabled: false },
      codex: { enabled: true },
    });
  });

  it("rejects settings missing required booleans", () => {
    expect(
      normalizeAgentControlSettings({ enabled: true, default_timezone: "UTC" }),
    ).toBeNull();
  });
});

describe("normalizeControlErrorDetail", () => {
  it("normalizes optional fields to explicit nulls", () => {
    expect(
      normalizeControlErrorDetail({
        code: "invalid_timezone",
        message: "Timezone 'London' is not an IANA timezone identifier.",
        retryable: true,
        field_errors: [{ field: "trigger.timezone", message: "Use Europe/London." }],
      }),
    ).toEqual({
      code: "invalid_timezone",
      message: "Timezone 'London' is not an IANA timezone identifier.",
      retryable: true,
      field_errors: [{ field: "trigger.timezone", message: "Use Europe/London." }],
      current_revision: null,
      suggested_action: null,
    });
  });
});

describe("normalizeControlAuditEntry", () => {
  it("accepts MCP-originated entries and rejects unknown origins", () => {
    const entry = {
      id: "audit-1",
      occurred_at: "2026-08-16T14:22:10Z",
      context: { origin: "mcp", provider: "codex" },
      operation: "automation.create",
      result: "success",
      summary: "Created automation 'Weekday inbox review'",
    };
    expect(normalizeControlAuditEntry(entry)).toEqual(entry);
    expect(
      normalizeControlAuditEntry({
        ...entry,
        context: { origin: "elsewhere" },
      }),
    ).toBeNull();
  });
});

describe("normalizeControlStateChanged", () => {
  it("accepts change payloads", () => {
    expect(
      normalizeControlStateChanged({
        store_revision: 42,
        domains: ["automations", "audit"],
      }),
    ).toEqual({ store_revision: 42, domains: ["automations", "audit"] });
    expect(normalizeControlStateChanged({ store_revision: 42 })).toBeNull();
  });
});
