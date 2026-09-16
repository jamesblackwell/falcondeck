import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mmkvMock from "react-native-mmkv";
vi.doMock("react-native-mmkv", () => mmkvMock);
import {
  workspaceOperationalConditions,
  type OperationalCondition,
} from "@falcondeck/client-core";

const warning: OperationalCondition = {
  id: "first",
  key: "mcp_startup:AbletonMCP",
  workspace_id: "workspace-1",
  level: "warning",
  message: "AbletonMCP failed to start",
  source: null,
  created_at: "2026-09-16T10:00:00Z",
  updated_at: "2026-09-16T10:00:00Z",
};
const repeated = {
  ...warning,
  id: "second",
  updated_at: "2026-09-16T11:00:00Z",
};

describe("operational notice dismissals", () => {
  beforeEach(() => {
    mmkvMock.__resetAllStores();
    vi.resetModules();
  });

  it("remembers an explicit dismissal across reloads, but shows changed failures", async () => {
    const { useOperationalNoticeStore } =
      await import("./operational-notice-store");
    useOperationalNoticeStore.getState().dismiss(warning, true);
    vi.resetModules();
    const restored = (
      await import("./operational-notice-store")
    ).useOperationalNoticeStore.getState();
    const visible = (condition: OperationalCondition) =>
      workspaceOperationalConditions(
        [condition],
        [],
        condition.workspace_id,
        restored.dismissed,
      );
    expect(visible(repeated)).toEqual([]);
    const changed = { ...repeated, message: "Sign in required" };
    expect(visible(changed)).toEqual([changed]);
    const escalated = { ...repeated, level: "error" as const };
    expect(visible(escalated)).toEqual([escalated]);
    const otherWorkspace = { ...repeated, workspace_id: "workspace-2" };
    expect(visible(otherWorkspace)).toEqual([otherWorkspace]);
  });

  it("auto expiry hides the current version across remounts without silencing a recurrence", async () => {
    const { useOperationalNoticeStore } =
      await import("./operational-notice-store");
    useOperationalNoticeStore.getState().dismiss(warning, false);
    const { dismissed } = useOperationalNoticeStore.getState();
    expect(
      workspaceOperationalConditions([warning], [], "workspace-1", dismissed),
    ).toEqual([]);
    expect(
      workspaceOperationalConditions([repeated], [], "workspace-1", dismissed),
    ).toEqual([repeated]);
    vi.resetModules();
    expect(
      (
        await import("./operational-notice-store")
      ).useOperationalNoticeStore.getState().dismissed.size,
    ).toBe(0);
  });

  it("ignores malformed saved preferences", async () => {
    const { setJson } = await import("@/storage/mmkv");
    setJson("mobile.dismissed-operational-notices", { invalid: true });
    const { useOperationalNoticeStore } =
      await import("./operational-notice-store");
    expect(useOperationalNoticeStore.getState().dismissed.size).toBe(0);
  });
});
