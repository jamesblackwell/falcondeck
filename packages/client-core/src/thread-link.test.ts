import { describe, expect, it } from "vitest";

import { parseThreadLink, resolveThreadLinkTarget } from "./thread-link";

describe("task links", () => {
  it("uses a stable ID with no dependency on the display title", () => {
    const target = { id: "0199b3a0-task-123", workspace_id: "another-project", title: "Renamed task" };
    expect(parseThreadLink("falcondeck://thread/0199b3a0-task-123")).toBe(target.id);
    expect(resolveThreadLinkTarget(target.id, [target])).toBe(target);
    expect(parseThreadLink("falcondeck://thread/claude%3Atask-123")).toBe("claude:task-123");
  });

  it.each([
    "falcondeck://thread/", "falcondeck://pair/task-123", "https://thread/task-123",
    "falcondeck://thread/../other", "falcondeck://thread/%2E%2E", "falcondeck://thread/%2Fetc",
    "falcondeck://thread/task?command=delete", "falcondeck://thread/task#fragment",
    "falcondeck://thread/%ZZ", "falcondeck://thread/task%0A123", "falcondeck://thread/task 123", "falcondeck://thread/task%0A",
  ])("rejects malformed or unrelated destinations: %s", (value) => {
    expect(parseThreadLink(value)).toBeNull();
  });

  it("looks up only the supplied daemon's tasks", () => {
    const local = { id: "task-123", workspace_id: "local-project" };
    const remote = { id: "task-123", workspace_id: "remote-project" };
    expect(resolveThreadLinkTarget("task-123", [remote])).toBe(remote);
    expect(resolveThreadLinkTarget("task-123", [])).toBeNull();
    expect(resolveThreadLinkTarget("missing", [local])).toBeNull();
  });
});
