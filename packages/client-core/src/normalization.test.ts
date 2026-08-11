import { describe, expect, it } from "vitest";

import {
  normalizeConversationItem,
  normalizeDaemonSnapshot,
  normalizeInteractiveRequest,
  normalizeThreadDetail,
  normalizeToolCallDisplay,
} from "./normalization";
import type { ConversationItem } from "./types";
import { providerOutputKindLabel } from "./conversation";

describe("reasoning duration normalization", () => {
  const reasoning = {
    kind: "reasoning",
    id: "reasoning-1",
    summary: "Inspecting",
    content: "Reading the implementation",
    lifecycle: "complete",
    created_at: "2026-08-09T10:00:00Z",
  };

  it("preserves an authoritative non-negative millisecond duration", () => {
    const normalized = normalizeConversationItem({
      ...reasoning,
      duration_ms: 2690,
    } as unknown as ConversationItem);

    expect(
      normalized.kind === "reasoning" ? normalized.duration_ms : null,
    ).toBe(2690);
  });

  it("routes malformed duration metadata to inspectable fallback", () => {
    const normalized = normalizeConversationItem({
      ...reasoning,
      duration_ms: -1,
    } as unknown as ConversationItem);

    expect(normalized.kind).toBe("unsupported");
  });
});

describe("interactive request resolution normalization", () => {
  it("keeps valid outcomes and neutralizes malformed or legacy receipts", () => {
    const base = {
      kind: "interactive_request",
      id: "request-1",
      request: {
        request_id: "request-1",
        workspace_id: "workspace-1",
        thread_id: "thread-1",
        method: "bash",
        kind: "approval",
        title: "Run tests",
        detail: null,
        command: "npm test",
        path: "/repo",
        turn_id: null,
        item_id: null,
        questions: [],
        created_at: "2026-08-09T12:00:00Z",
      },
      created_at: "2026-08-09T12:00:00Z",
      resolved: true,
    };
    const valid = normalizeConversationItem({
      ...base,
      resolution: { outcome: "denied", resolved_at: "2026-08-09T12:01:00Z" },
    } as unknown as ConversationItem);
    const malformed = normalizeConversationItem({
      ...base,
      resolution: { outcome: "approved", resolved_at: 42 },
    } as unknown as ConversationItem);
    const legacy = normalizeConversationItem(
      base as unknown as ConversationItem,
    );

    expect(
      valid.kind === "interactive_request" ? valid.resolution : null,
    ).toEqual({
      outcome: "denied",
      resolved_at: "2026-08-09T12:01:00Z",
    });
    expect(
      malformed.kind === "interactive_request"
        ? malformed.resolution
        : "wrong-kind",
    ).toBeNull();
    expect(
      legacy.kind === "interactive_request" ? legacy.resolution : "wrong-kind",
    ).toBeNull();
  });
});

describe("interactive request boundary normalization", () => {
  it("drops unsafe nested entries and preserves a usable question", () => {
    const normalized = normalizeInteractiveRequest({
      request_id: "request-1",
      workspace_id: "workspace-1",
      kind: "question",
      questions: [
        {
          id: "framework",
          header: "",
          question: "Which framework?",
          is_secret: true,
          options: [
            { label: "React", description: "Web" },
            { label: "React", description: "Duplicate transport entry" },
            { label: 42 },
          ],
        },
        { id: "framework", question: "Duplicate identifier" },
        { id: "", question: "Missing identifier" },
      ],
    });

    expect(normalized?.questions).toEqual([
      {
        id: "framework",
        header: "Question",
        question: "Which framework?",
        is_other: false,
        is_secret: true,
        options: [{ label: "React", description: "Web" }],
      },
    ]);
  });

  it("rejects requests without authoritative routing identity", () => {
    expect(
      normalizeInteractiveRequest({ kind: "approval", questions: [] }),
    ).toBeNull();
  });

  it("normalizes provider approval capabilities without inventing persistence", () => {
    const base = {
      request_id: "request-1",
      workspace_id: "workspace-1",
      kind: "approval",
      questions: [],
    };

    expect(normalizeInteractiveRequest(base)?.approval_decisions).toEqual([
      "allow",
      "deny",
    ]);
    expect(
      normalizeInteractiveRequest({
        ...base,
        approval_decisions: ["deny", "always_allow", "deny", "unknown"],
      })?.approval_decisions,
    ).toEqual(["deny", "always_allow"]);
    expect(
      normalizeInteractiveRequest({
        ...base,
        approval_decisions: [],
      })?.approval_decisions,
    ).toEqual([]);
  });

  it("filters invalid pending requests from daemon snapshots", () => {
    const snapshot = normalizeDaemonSnapshot({
      interactive_requests: [
        {
          request_id: "",
          workspace_id: "workspace-1",
          kind: "approval",
          questions: [],
        },
        {
          request_id: "valid",
          workspace_id: "workspace-1",
          kind: "approval",
          questions: [],
        },
      ],
    });

    expect(
      snapshot.interactive_requests.map((request) => request.request_id),
    ).toEqual(["valid"]);
  });
});

describe("malformed conversation output normalization", () => {
  it("humanizes open-ended provider discriminators", () => {
    expect(providerOutputKindLabel("artifactPreview")).toBe("artifact preview");
    expect(providerOutputKindLabel("future_trace-event")).toBe(
      "future trace event",
    );
  });

  it("normalizes first-class unsupported receipts and their lifecycle", () => {
    const item = normalizeConversationItem({
      kind: "unsupported",
      id: "future-1",
      output_kind: "artifactPreview",
      reason: "Provider output is not supported by this FalconDeck version",
      payload: { artifact: { title: "Prototype" } },
      lifecycle: "streaming",
      created_at: "2026-08-09T10:00:00Z",
    });

    expect(item).toMatchObject({
      kind: "unsupported",
      output_kind: "artifactPreview",
      lifecycle: "streaming",
      payload: { artifact: { title: "Prototype" } },
    });
  });

  it("normalizes first-class artifact receipts and their lifecycle", () => {
    const item = normalizeConversationItem({
      kind: "artifact",
      id: "artifact-1",
      artifact: {
        title: "Prototype",
        artifact_kind: "preview",
        url: "https://example.com/prototype",
        mime_type: "text/html",
        version: "v2",
        content: "<main>Prototype</main>",
        payload: { title: "Prototype" },
      },
      lifecycle: "streaming",
      created_at: "2026-08-09T10:00:00Z",
    });

    expect(item).toMatchObject({
      kind: "artifact",
      lifecycle: "streaming",
      artifact: { title: "Prototype", version: "v2" },
    });
  });

  it("routes malformed artifacts to the bounded fallback", () => {
    const item = normalizeConversationItem({
      kind: "artifact",
      id: "artifact-broken",
      artifact: { title: 42, artifact_kind: "preview" },
    }) as unknown as Record<string, unknown>;

    expect(item).toMatchObject({
      kind: "unsupported",
      output_kind: "artifact",
      reason: "Malformed conversation output",
    });
  });

  it("preserves malformed known output behind the inspectable fallback", () => {
    const item = normalizeConversationItem({
      kind: "assistant_message",
      id: "assistant-broken",
      text: { nested: "not text" },
    }) as unknown as Record<string, unknown>;

    expect(item.kind).toBe("unsupported");
    expect(item.output_kind).toBe("assistant_message");
    expect(item.reason).toBe("Malformed conversation output");
    expect(item.payload).toEqual({
      kind: "assistant_message",
      id: "assistant-broken",
      text: { nested: "not text" },
    });
    expect(item.id).toMatch(/^malformed-/);
  });

  it("keeps a malformed item from failing the entire thread detail", () => {
    const detail = normalizeThreadDetail({
      workspace: {},
      thread: {},
      items: [null, { kind: "future_output", id: "future-1", value: 42 }],
    });

    expect(detail.items).toHaveLength(2);
    expect((detail.items[0] as unknown as { kind: string }).kind).toBe(
      "unsupported",
    );
    expect((detail.items[1] as unknown as { kind: string }).kind).toBe(
      "future_output",
    );
  });

  it("filters malformed user attachments before native or DOM image rendering", () => {
    const item = normalizeConversationItem({
      kind: "user_message",
      id: "user-1",
      text: "See attached",
      attachments: [
        { type: "image", id: "good", url: "https://example.com/image.png" },
        { type: "image", id: "broken", url: 42 },
      ],
      created_at: "2026-08-09T12:00:00Z",
    });

    expect(item.kind === "user_message" ? item.attachments : null).toEqual([
      { type: "image", id: "good", url: "https://example.com/image.png" },
    ]);
  });

  it("accepts daemon wire attachments that carry no type discriminant", () => {
    // The daemon serializes ImageInput without a `type` field; normalization
    // must brand it rather than drop the attachment.
    const item = normalizeConversationItem({
      kind: "user_message",
      id: "user-1",
      text: "See attached",
      attachments: [
        {
          id: "att-1",
          name: "shot.png",
          mime_type: "image/png",
          url: "data:image/png;base64,aGk=",
          local_path: "/tmp/att-1.png",
        },
        { type: "video", id: "other", url: "https://example.com/clip.mp4" },
      ],
      created_at: "2026-08-09T12:00:00Z",
    });

    expect(item.kind === "user_message" ? item.attachments : null).toEqual([
      {
        type: "image",
        id: "att-1",
        name: "shot.png",
        mime_type: "image/png",
        url: "data:image/png;base64,aGk=",
        local_path: "/tmp/att-1.png",
      },
    ]);
  });

  it("normalizes file-change destinations before renderers consume them", () => {
    const item = normalizeConversationItem({
      kind: "file_change",
      id: "patch-1",
      status: "completed",
      changes: [
        {
          path: "src/valid.ts",
          change_kind: "update",
          diff: "+valid",
          move_path: { bad: true },
        },
        {
          path: "src/old.ts",
          change_kind: "update",
          diff: "+moved",
          move_path: "src/new.ts",
        },
        { path: "", change_kind: "update", diff: "+missing identity" },
      ],
      created_at: "2026-08-09T12:00:00Z",
    });

    expect(item.kind === "file_change" ? item.changes : null).toEqual([
      {
        path: "src/valid.ts",
        change_kind: "update",
        diff: "+valid",
        move_path: null,
      },
      {
        path: "src/old.ts",
        change_kind: "update",
        diff: "+moved",
        move_path: "src/new.ts",
      },
    ]);
  });

  it("survives provider objects whose kind getter throws", () => {
    const hostile = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        throw new Error("unreadable kind");
      },
    });

    expect(() => normalizeConversationItem(hostile)).not.toThrow();
    expect(
      (normalizeConversationItem(hostile) as unknown as { kind: string }).kind,
    ).toBe("unsupported");
  });
});

describe("assistant citation normalization", () => {
  it("keeps provider evidence and rejects unidentifiable entries", () => {
    const item = normalizeConversationItem({
      kind: "assistant_message",
      id: "assistant-1",
      text: "Grounded answer",
      citations: [
        {
          id: "assistant-1:citation:0",
          kind: "web_search_result_location",
          url: "https://example.com/source",
          title: "Source title",
          cited_text: "Supporting passage",
        },
        { kind: "search_result_location" },
        { kind: 42, url: "https://example.com/invalid" },
      ],
      created_at: "2026-08-09T12:00:00Z",
    } as unknown as ConversationItem);

    expect(item.kind).toBe("assistant_message");
    if (item.kind !== "assistant_message") return;
    expect(item.citations).toEqual([
      {
        id: "assistant-1:citation:0",
        kind: "web_search_result_location",
        url: "https://example.com/source",
        title: "Source title",
        cited_text: "Supporting passage",
      },
    ]);
  });

  it("hydrates legacy assistant items with no citations", () => {
    const item = normalizeConversationItem({
      kind: "assistant_message",
      id: "assistant-legacy",
      text: "Legacy response",
      created_at: "2026-08-09T12:00:00Z",
    } as ConversationItem);

    expect(item.kind === "assistant_message" ? item.citations : null).toEqual(
      [],
    );
  });

  it("validates citation locators and deduplicates streamed evidence", () => {
    const locator = {
      kind: "search_result" as const,
      search_result_index: 1,
      start_block_index: 2,
      end_block_index: 3,
    };
    const item = normalizeConversationItem({
      kind: "assistant_message",
      id: "assistant-citations",
      text: "Grounded response",
      citations: [
        {
          kind: "search_result_location",
          source: "https://example.com/guide",
          title: "Original title",
          locator,
        },
        {
          kind: "search_result_location",
          source: "https://example.com/guide",
          title: "Updated title",
          cited_text: "Supporting passage",
          locator,
        },
        {
          kind: "search_result_location",
          source: "kb://invalid-range",
          locator: { ...locator, end_block_index: 2 },
        },
      ],
      created_at: "2026-08-09T12:00:00Z",
    } as unknown as ConversationItem);

    expect(item.kind === "assistant_message" ? item.citations : null).toEqual([
      {
        kind: "search_result_location",
        source: "https://example.com/guide",
        title: "Updated title",
        cited_text: "Supporting passage",
        locator,
      },
      {
        kind: "search_result_location",
        source: "kb://invalid-range",
      },
    ]);
  });
});

describe("plan normalization", () => {
  it("preserves provider step identities and neutralizes malformed legacy ids", () => {
    const item = normalizeConversationItem({
      kind: "plan",
      id: "plan-1",
      plan: {
        explanation: null,
        steps: [
          { id: "step-1", step: "Inspect", status: "done" },
          { id: "  ", step: "Implement", status: "running" },
          { id: 42, step: "Verify", status: "pending" },
        ],
      },
      created_at: "2026-08-09T12:00:00Z",
    } as unknown as ConversationItem);

    expect(item.kind).toBe("plan");
    if (item.kind !== "plan") return;
    expect(item.plan.steps.map((step) => step.id)).toEqual([
      "step-1",
      null,
      null,
    ]);
  });
});

describe("test summary normalization", () => {
  it("keeps only non-negative integer counts from newer daemons", () => {
    const display = normalizeToolCallDisplay({
      lifecycle: "failed",
      artifact_kind: "test",
      activity_kind: "test",
      history_mode: "full",
      test_summary: {
        framework: " vitest ",
        total: 12,
        passed: 10,
        failed: 2,
        skipped: -1,
        suites_total: 3.5,
        suites_passed: 2,
        suites_failed: 1,
        duration_ms: 1_250,
      },
    });

    expect(display.test_summary).toEqual({
      framework: "vitest",
      total: 12,
      passed: 10,
      failed: 2,
      skipped: null,
      suites_total: null,
      suites_passed: 2,
      suites_failed: 1,
      duration_ms: 1_250,
    });
  });

  it("defaults malformed and legacy summaries to null", () => {
    expect(normalizeToolCallDisplay({}).test_summary).toBeNull();
    expect(
      normalizeToolCallDisplay({ test_summary: { failed: "2" } }).test_summary,
    ).toBeNull();
  });
});

describe("provider output summary normalization", () => {
  const summary = {
    text_blocks: 2,
    images: 1,
    audio: 0,
    resource_links: 3,
    embedded_resources: 1,
    structured_results: 1,
  };

  it("preserves complete non-negative integer summaries from newer daemons", () => {
    expect(
      normalizeToolCallDisplay({ provider_output_summary: summary })
        .provider_output_summary,
    ).toEqual(summary);
  });

  it("defaults legacy, partial, and malformed summaries to null", () => {
    expect(normalizeToolCallDisplay({}).provider_output_summary).toBeNull();
    expect(
      normalizeToolCallDisplay({
        provider_output_summary: { ...summary, resource_links: -1 },
      }).provider_output_summary,
    ).toBeNull();
    expect(
      normalizeToolCallDisplay({
        provider_output_summary: { ...summary, structured_results: 1.5 },
      }).provider_output_summary,
    ).toBeNull();
    expect(
      normalizeToolCallDisplay({
        provider_output_summary: { images: 1 },
      }).provider_output_summary,
    ).toBeNull();
  });
});
