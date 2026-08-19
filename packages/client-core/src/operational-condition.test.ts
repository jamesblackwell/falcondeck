import { describe, expect, it } from "vitest";

import { normalizeDaemonSnapshot } from "./normalization";
import {
  applySnapshotEvent,
  groupOperationalConditions,
  operationalConditionDismissalKey,
  workspaceOperationalConditions,
} from "./snapshot";
import type { EventEnvelope, OperationalCondition } from "./types";

function condition(
  id: string,
  key: string,
  level: OperationalCondition["level"],
  updatedAt: string,
): OperationalCondition {
  return {
    id,
    key,
    workspace_id: "workspace-1",
    level,
    message: `${key} message`,
    source: "test",
    created_at: "2026-08-13T10:00:00Z",
    updated_at: updatedAt,
  };
}

describe("operational conditions", () => {
  it("orders active conditions by severity and recency", () => {
    const conditions = workspaceOperationalConditions(
      [
        condition("warning", "warning", "warning", "2026-08-13T10:02:00Z"),
        condition("old-error", "old_error", "error", "2026-08-13T10:01:00Z"),
        condition("new-error", "new_error", "error", "2026-08-13T10:03:00Z"),
      ],
      [],
      "workspace-1",
      new Set(),
    );

    expect(conditions.map(({ id }) => id)).toEqual([
      "new-error",
      "old-error",
      "warning",
    ]);
  });

  it("shows a condition again when a dismissed condition receives an update", () => {
    const original = condition(
      "connection",
      "codex_connection",
      "error",
      "2026-08-13T10:00:00Z",
    );
    const dismissed = new Set([operationalConditionDismissalKey(original)]);
    const updated = { ...original, updated_at: "2026-08-13T10:05:00Z" };

    expect(
      workspaceOperationalConditions([updated], [], "workspace-1", dismissed),
    ).toEqual([updated]);
  });

  it("replaces and clears conditions by workspace and semantic key", () => {
    const snapshot = normalizeDaemonSnapshot({
      service_notices: [
        {
          id: "connection",
          workspace_id: "workspace-1",
          level: "warning",
          message: "Legacy connection warning",
          raw_method: "disconnect",
          created_at: "2026-08-13T10:00:00Z",
        },
      ],
    });
    const first = condition(
      "connection",
      "codex_connection",
      "warning",
      "2026-08-13T10:00:00Z",
    );
    const replacement = {
      ...first,
      level: "error" as const,
      message: "Reconnect exhausted",
      updated_at: "2026-08-13T10:05:00Z",
    };
    const upsert = (next: OperationalCondition): EventEnvelope => ({
      seq: 1,
      emitted_at: next.updated_at,
      workspace_id: next.workspace_id,
      thread_id: null,
      event: { type: "operational-condition-upserted", condition: next },
    });

    const withFirst = applySnapshotEvent(snapshot, upsert(first));
    const withReplacement = applySnapshotEvent(withFirst, upsert(replacement));
    const cleared = applySnapshotEvent(withReplacement, {
      seq: 2,
      emitted_at: "2026-08-13T10:06:00Z",
      workspace_id: "workspace-1",
      thread_id: null,
      event: {
        type: "operational-condition-cleared",
        key: "codex_connection",
        condition_id: "connection",
      },
    });

    expect(cleared?.operational_conditions).toEqual([]);
    expect(cleared?.service_notices).toEqual([]);
  });

  it("folds one family into a counted group and leaves the rest alone", () => {
    const groups = groupOperationalConditions([
      condition("a", "codex_connection", "error", "2026-08-13T10:03:00Z"),
      condition("b", "mcp_startup:clarity", "warning", "2026-08-13T10:02:00Z"),
      condition("c", "mcp_startup:cloudflare-api", "warning", "2026-08-13T10:01:00Z"),
      condition("d", "mcp_auth:linear", "warning", "2026-08-13T10:00:00Z"),
    ]);

    expect(groups.map((group) => [group.family, group.conditions.length])).toEqual([
      ["codex_connection", 1],
      ["mcp_startup", 2],
      ["mcp_auth", 1],
    ]);
    expect(groups[1]?.summary).toBe("2 MCP servers could not start");
    // A family of one reads better as its own message than as a count.
    expect(groups[0]?.summary).toBeNull();
    expect(groups[2]?.summary).toBeNull();
  });
});
