import { describe, expect, it } from "vitest";
import { normalizeConversationItem, normalizeInteractiveRequest } from "./normalization";
import { interactiveRequestReceiptPresentation, interactiveResolutionFromResponse } from "./conversation";

describe("exact approval options", () => {
  const request = { request_id: "request", workspace_id: "workspace", kind: "approval", questions: [], created_at: "2026-10-06T10:00:00Z" };
  it("preserves opaque ids and provider labels without conflating standing grants", () => {
    const options = [
      { option_id: "opaque/session", label: "Allow for session", decision: "always_allow" },
      { option_id: "opaque/persist", label: "Allow always", decision: "always_allow" },
    ];
    expect(normalizeInteractiveRequest({ ...request, approval_options: options })?.approval_options).toEqual(options);
  });
  it("keeps legacy requests and filters unsupported exact options", () => {
    expect(normalizeInteractiveRequest(request)?.approval_options).toBeUndefined();
    expect(normalizeInteractiveRequest({ ...request, approval_options: [{ option_id: "bad", label: "Unsafe", decision: "unknown" }] })?.approval_options).toEqual([]);
  });
  it("keeps the native grant scope visible in resolved receipts", () => {
    const resolution = interactiveResolutionFromResponse({ kind: "approval_option", option_id: "opaque/session" });
    expect(interactiveRequestReceiptPresentation({ kind: "approval", title: "Allow command?", approval_options: [
      { option_id: "opaque/session", label: "Allow for session", decision: "always_allow" },
    ] }, resolution).label).toBe("Allow for session: command");
    const item = normalizeConversationItem({ kind: "interactive_request", id: "item", request, created_at: request.created_at, resolved: true,
      resolution: { outcome: "always_allowed", approval_option_id: "opaque/session", resolved_at: request.created_at } });
    expect(item.kind === "interactive_request" && item.resolution?.approval_option_id).toBe("opaque/session");
  });
});
