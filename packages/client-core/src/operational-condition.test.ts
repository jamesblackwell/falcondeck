import { describe, expect, it } from "vitest";

import { normalizeDaemonSnapshot } from "./normalization";
import {
  applySnapshotEvent,
  conversationOperationalConditions,
  groupOperationalConditions,
  operationalConditionContentKey,
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

  it("keeps a re-reported condition hidden after its wording was dismissed", () => {
    const original = condition(
      "condition-1",
      "mcp_startup:AbletonMCP",
      "warning",
      "2026-08-13T10:00:00Z",
    );
    const dismissed = new Set([operationalConditionContentKey(original)]);
    const reported = {
      ...original,
      id: "condition-2",
      created_at: "2026-08-13T11:00:00Z",
      updated_at: "2026-08-13T11:00:00Z",
    };
    expect(
      workspaceOperationalConditions([reported], [], "workspace-1", dismissed),
    ).toEqual([]);

    const escalated = { ...reported, level: "error" as const };
    expect(
      workspaceOperationalConditions([escalated], [], "workspace-1", dismissed),
    ).toEqual([escalated]);

    const reworded = { ...reported, message: `${reported.message} (new)` };
    expect(
      workspaceOperationalConditions([reworded], [], "workspace-1", dismissed),
    ).toEqual([reworded]);
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
      condition(
        "c",
        "mcp_startup:cloudflare-api",
        "warning",
        "2026-08-13T10:01:00Z",
      ),
      condition("d", "mcp_auth:linear", "warning", "2026-08-13T10:00:00Z"),
    ]);

    expect(
      groups.map((group) => [group.family, group.conditions.length]),
    ).toEqual([
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

describe("conversation condition scope", () => {
  const warning = {
    ...condition(
      "a",
      "mcp_startup:AbletonMCP",
      "warning",
      "2026-09-16T10:00:00Z",
    ),
    thread_id: "thread-a",
  };
  const other = { ...warning, id: "b", thread_id: "thread-b" };
  it("shows a startup failure only in its reporting conversation, including after snapshot restore", () => {
    const snapshot = normalizeDaemonSnapshot({
      operational_conditions: [warning, other],
    });
    expect(
      conversationOperationalConditions(
        snapshot.operational_conditions,
        [],
        "workspace-1",
        "thread-a",
        new Set(),
      ),
    ).toEqual([warning]);
    expect(
      conversationOperationalConditions(
        snapshot.operational_conditions,
        [],
        "workspace-1",
        "old-thread",
        new Set(),
      ),
    ).toEqual([]);
    expect(
      conversationOperationalConditions(
        snapshot.operational_conditions,
        [],
        "workspace-1",
        null,
        new Set(),
      ),
    ).toEqual([]);
  });
  it("does not assign old unscoped MCP warnings to the open conversation, but retains actual workspace health", () => {
    const unscoped = { ...warning, thread_id: undefined };
    const health = condition(
      "offline",
      "codex_connection",
      "error",
      warning.updated_at,
    );
    expect(
      conversationOperationalConditions(
        [unscoped, health],
        [],
        "workspace-1",
        "old-thread",
        new Set(),
      ),
    ).toEqual([health]);
    const legacy = {
      id: "legacy",
      workspace_id: "workspace-1",
      level: "warning" as const,
      message: "ableton failed to start: connection closed",
      raw_method: "warning",
      created_at: warning.created_at,
    };
    expect(
      conversationOperationalConditions(
        undefined,
        [legacy],
        "workspace-1",
        "old-thread",
        new Set(),
      ),
    ).toEqual([]);
    expect(
      conversationOperationalConditions(
        undefined,
        [{ ...legacy, thread_id: "thread-a" }],
        "workspace-1",
        "thread-a",
        new Set(),
      ),
    ).toHaveLength(1);
  });
  it("keeps concurrent thread conditions distinct through event replay and recovery", () => {
    let snapshot = normalizeDaemonSnapshot({
      operational_conditions: [warning],
    });
    const envelope = {
      seq: 1,
      emitted_at: warning.updated_at,
      workspace_id: "workspace-1",
      thread_id: null,
    };
    snapshot = applySnapshotEvent(snapshot, {
      ...envelope,
      event: { type: "operational-condition-upserted", condition: other },
    })!;
    expect(snapshot.operational_conditions).toHaveLength(2);
    snapshot = applySnapshotEvent(snapshot, {
      ...envelope,
      seq: 2,
      event: {
        type: "operational-condition-cleared",
        key: warning.key,
        condition_id: warning.id,
      },
    })!;
    expect(snapshot.operational_conditions).toEqual([other]);
  });
  it("does not carry an explicit dismissal into another reporting conversation", () => {
    const dismissed = new Set([operationalConditionContentKey(warning)]);
    expect(
      conversationOperationalConditions(
        [warning, other],
        [],
        "workspace-1",
        "thread-a",
        dismissed,
      ),
    ).toEqual([]);
    expect(
      conversationOperationalConditions(
        [warning, other],
        [],
        "workspace-1",
        "thread-b",
        dismissed,
      ),
    ).toEqual([other]);
  });
});
