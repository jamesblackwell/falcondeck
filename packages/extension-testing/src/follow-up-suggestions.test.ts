import { describe, expect, it } from "vitest";

import followUpSuggestions from "../../../extensions/official/follow-up-suggestions/server";

import { createExtensionTestHost } from "./index";

const AGENT_TOOLS_PERMISSION = "agent-tools:register";

function host(options: Record<string, unknown> = {}) {
  return createExtensionTestHost(followUpSuggestions, {
    extensionId: "falcondeck.follow-up-suggestions",
    declaredTools: ["suggest-follow-ups"],
    declaredViews: ["follow-ups"],
    declaredSuggestionViews: ["follow-ups"],
    grantedPermissions: [AGENT_TOOLS_PERMISSION],
    ...options,
  });
}

const TWO_ACTIONS = {
  actions: [
    {
      id: "run-tests",
      label: "Run the test suite",
      description: "Check the change end to end",
      prompt: "Run the full test suite and report failures.",
    },
    { id: "ship", label: "Ship it", prompt: "Open a pull request for this change." },
  ],
  preferredActionId: "run-tests",
};

describe("Follow-up suggestions public backend SDK contract", () => {
  it("publishes a thread-scoped offer set and returns without blocking", async () => {
    const call = await host().invokeTool("suggest-follow-ups", {
      input: TWO_ACTIONS,
      threadId: "thread-1",
      workspaceId: "workspace-1",
    });

    expect(call.result).toEqual({ published: true, count: 2 });
    expect(call.publishedViews).toEqual([
      {
        viewId: "follow-ups",
        scope: { kind: "thread", id: "thread-1" },
        value: {
          actions: TWO_ACTIONS.actions,
          preferredActionId: "run-tests",
        },
      },
    ]);
  });

  it("rejects sets outside the published bounds before anything is stored", async () => {
    const testHost = host();

    await expect(
      testHost.invokeTool("suggest-follow-ups", {
        input: { actions: [] },
        threadId: "thread-1",
      }),
    ).rejects.toThrow(/between 1 and 5 actions/);

    await expect(
      testHost.invokeTool("suggest-follow-ups", {
        input: {
          actions: [
            {
              id: "long",
              label: "A label that is far too long to fit in the pill",
              prompt: "Do the thing.",
            },
          ],
        },
        threadId: "thread-1",
      }),
    ).rejects.toThrow(/label must be 1-30 characters/);

    await expect(
      testHost.invokeTool("suggest-follow-ups", {
        input: {
          actions: [{ id: "a", label: "Ship it", prompt: "Ship." }],
          preferredActionId: "missing",
        },
        threadId: "thread-1",
      }),
    ).rejects.toThrow(/is not one of the offered actions/);

    expect(testHost.storageSnapshot()).toEqual({});
  });

  it("keeps no state of its own, because the daemon owns staleness", async () => {
    const testHost = host();
    await testHost.invokeTool("suggest-follow-ups", {
      input: TWO_ACTIONS,
      threadId: "thread-1",
    });

    // FalconDeck retires a thread's offers at its next turn-start boundary,
    // for every harness. An extension that tracked that itself would only be
    // right for the providers that report a turn-started notification.
    expect(testHost.storageSnapshot()).toEqual({});
  });

  it("reports rather than fails when a turn has no thread to attach to", async () => {
    const call = await host().invokeTool("suggest-follow-ups", {
      input: TWO_ACTIONS,
    });

    expect(call.result).toMatchObject({ published: false });
    expect(call.publishedViews).toEqual([]);
  });

  it("fails closed when the agent-tools grant is missing", async () => {
    await expect(
      host({ grantedPermissions: [] }).invokeTool("suggest-follow-ups", {
        input: TWO_ACTIONS,
        threadId: "thread-1",
      }),
    ).rejects.toThrow(/agent-tools:register permission is not granted/);
  });
});
