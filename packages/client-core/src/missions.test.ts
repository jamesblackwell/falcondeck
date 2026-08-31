import { describe, expect, it } from "vitest";

import { missionCommandAvailable } from "./missions";
import type { ExtensionSnapshot, ExtensionSummary } from "./types";

function snapshot(
  overrides: Partial<ExtensionSummary> = {},
): ExtensionSnapshot {
  return {
    catalog: [
      {
        id: "falcondeck.missions",
        name: "Missions",
        version: "0.3.0",
        source: "bundled",
        bundled: true,
        enabled: true,
        status: "active",
        contributes: {
          threadMenuActions: [],
          threadDecorations: [],
          sidebarFilters: [],
          agentTools: [
            {
              id: "draft-mission",
              title: "Start a FalconDeck Mission draft",
              description: "Create a bounded Mission draft.",
            },
          ],
        },
        permissions: [
          "threads:read",
          "agent-tools:register",
          "orchestration:manage-owned-tasks",
        ],
        granted_permissions: [
          "threads:read",
          "agent-tools:register",
          "orchestration:manage-owned-tasks",
        ],
        ...overrides,
      },
    ],
    views: [],
  };
}

describe("missionCommandAvailable", () => {
  it("requires an active extension with every Mission permission", () => {
    expect(missionCommandAvailable(snapshot())).toBe(true);
    expect(missionCommandAvailable(snapshot({ enabled: false }))).toBe(false);
    expect(missionCommandAvailable(snapshot({ status: "error" }))).toBe(false);
    expect(
      missionCommandAvailable(
        snapshot({
          granted_permissions: ["threads:read", "agent-tools:register"],
        }),
      ),
    ).toBe(false);
  });

  it("does not advertise a missing draft tool", () => {
    expect(
      missionCommandAvailable(
        snapshot({
          contributes: {
            threadMenuActions: [],
            threadDecorations: [],
            sidebarFilters: [],
            agentTools: [],
          },
        }),
      ),
    ).toBe(false);
  });
});
