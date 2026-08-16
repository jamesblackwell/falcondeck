import { describe, expect, it } from "vitest";

import { applySnapshotEvent } from "./snapshot";
import { normalizeEventEnvelope, normalizeThreadSummary } from "./normalization";
import { parseDaemonEvents } from "./remote-events";
import type { DaemonSnapshot } from "./types";

const envelope = {
  seq: 7,
  emitted_at: "2026-08-16T14:22:10Z",
  workspace_id: null,
  thread_id: null,
  event: {
    type: "control-state-changed",
    change: { store_revision: 42, domains: ["automations", "audit"] },
  },
};

describe("automation thread origins", () => {
  it("survives thread summary normalization", () => {
    const normalized = normalizeThreadSummary({
      id: "thread-1",
      title: "Inbox review",
      status: "idle",
      updated_at: "2026-08-16T14:22:10Z",
      origin: { kind: "automation", automation_id: "automation-1", name: "Weekday inbox review" },
    });
    expect(normalized?.origin).toEqual({
      kind: "automation",
      automation_id: "automation-1",
      name: "Weekday inbox review",
    });
  });

  it("still drops malformed origins", () => {
    const normalized = normalizeThreadSummary({
      id: "thread-1",
      title: "Broken",
      status: "idle",
      updated_at: "2026-08-16T14:22:10Z",
      origin: { kind: "automation", automation_id: 7 },
    } as never);
    expect(normalized?.origin).toBeNull();
  });
});

describe("control-state-changed events", () => {
  it("normalizes like every other envelope variant", () => {
    const normalized = normalizeEventEnvelope(envelope);
    expect(normalized?.event.type).toBe("control-state-changed");
    if (normalized?.event.type === "control-state-changed") {
      expect(normalized.event.change.store_revision).toBe(42);
      expect(normalized.event.change.domains).toEqual(["automations", "audit"]);
    }
  });

  it("drops malformed change payloads without killing the stream", () => {
    const malformed = normalizeEventEnvelope({
      ...envelope,
      event: { type: "control-state-changed", change: "not-an-object" },
    });
    // The envelope still normalizes; clients that do not render control
    // state may safely ignore the event after parsing.
    expect(malformed?.event.type).toBe("control-state-changed");
  });

  it("passes through snapshot reduction untouched", () => {
    const snapshot = { version: 1 } as unknown as DaemonSnapshot;
    const reduced = applySnapshotEvent(snapshot, envelope as never);
    expect(reduced).toBe(snapshot);
  });

  it("survives the remote relay event parser", () => {
    const frames = parseDaemonEvents({
      kind: "daemon-event",
      event: envelope,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event.type).toBe("control-state-changed");
  });
});
