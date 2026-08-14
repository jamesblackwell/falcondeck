import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react-test-renderer";
import { renderComponent, cleanup, textOf } from "../../test/render";
import { ConnectionHeader } from "./ConnectionHeader";
import { SidebarView } from "./SidebarView";
import { workspace, thread } from "../../test/factories";
import { useRelayStore } from "@/store";
import type {
  ExtensionSidebarFilterDefinition,
  ExtensionSnapshot,
  ProjectGroup,
} from "@falcondeck/client-core";

const idleRelayState = {
  connectionStatus: useRelayStore.getState().connectionStatus,
  isEncrypted: useRelayStore.getState().isEncrypted,
  isSyncing: useRelayStore.getState().isSyncing,
  hasSyncedOnce: useRelayStore.getState().hasSyncedOnce,
  machinePresence: useRelayStore.getState().machinePresence,
};

afterEach(() => {
  cleanup();
  useRelayStore.setState(idleRelayState);
});

describe("ConnectionHeader component", () => {
  it("renders connected as a label-free status dot", () => {
    const r = renderComponent(
      <ConnectionHeader
        connectionStatus="encrypted"
        isEncrypted
        machinePresence={{
          session_id: "s1",
          daemon_connected: true,
          last_seen_at: null,
        }}
      />,
    );
    expect(textOf(r)).toBe("");
    expect(
      r.root.findByProps({ accessibilityLabel: "Connection: Connected" }),
    ).toBeTruthy();
  });
  it("keeps disconnected detail in its accessible label", () => {
    const r = renderComponent(
      <ConnectionHeader
        connectionStatus="disconnected"
        isEncrypted={false}
        machinePresence={null}
      />,
    );
    expect(textOf(r)).toBe("");
    expect(
      r.root.findByProps({ accessibilityLabel: "Connection: Disconnected" }),
    ).toBeTruthy();
  });
  it("keeps connecting detail in its accessible label", () => {
    const r = renderComponent(
      <ConnectionHeader
        connectionStatus="connecting"
        isEncrypted={false}
        machinePresence={null}
      />,
    );
    expect(
      r.root.findByProps({ accessibilityLabel: "Connection: Connecting…" }),
    ).toBeTruthy();
  });
  it("keeps securing detail in its accessible label", () => {
    const r = renderComponent(
      <ConnectionHeader
        connectionStatus="connected"
        isEncrypted={false}
        machinePresence={{
          session_id: "s1",
          daemon_connected: false,
          last_seen_at: null,
        }}
      />,
    );
    expect(
      r.root.findByProps({
        accessibilityLabel: "Connection: Securing session…",
      }),
    ).toBeTruthy();
  });
  it("keeps unpaired detail in its accessible label", () => {
    const r = renderComponent(
      <ConnectionHeader
        connectionStatus="not_connected"
        isEncrypted={false}
        machinePresence={null}
      />,
    );
    expect(
      r.root.findByProps({ accessibilityLabel: "Connection: Not connected" }),
    ).toBeTruthy();
  });
});

describe("SidebarView component", () => {
  const base = {
    groups: [] as ProjectGroup[],
    selectedThreadId: null as string | null,
    onSelectThread: vi.fn(),
    onNewThread: vi.fn(),
  };

  it("renders empty", () => {
    const r = renderComponent(<SidebarView {...base} />);
    expect(textOf(r)).toContain("No projects");
  });
  it("renders a persistent settings footer action", () => {
    const onOpenSettings = vi.fn();
    const r = renderComponent(
      <SidebarView {...base} onOpenSettings={onOpenSettings} />,
    );
    const settings = r.root.find(
      (node) => node.props.accessibilityLabel === "Settings",
    );
    expect(textOf(r)).toContain("Settings");
    settings.props.onPress();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
  it("renders groups", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1", path: "/tmp/proj" }),
        threads: [thread({ id: "t1", workspace_id: "w1" })],
      },
    ];
    const r = renderComponent(<SidebarView {...base} groups={groups} />);
    expect(textOf(r)).toContain("proj");
    expect(textOf(r)).toContain("Test thread");
  });
  it("renders selected", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1" }),
        threads: [thread({ id: "t1", workspace_id: "w1" })],
      },
    ];
    expect(
      renderComponent(
        <SidebarView {...base} groups={groups} selectedThreadId="t1" />,
      ).toJSON(),
    ).toBeTruthy();
  });
  it("renders empty-titled thread", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1" }),
        threads: [thread({ id: "t1", workspace_id: "w1", title: "" })],
      },
    ];
    expect(
      renderComponent(<SidebarView {...base} groups={groups} />).toJSON(),
    ).toBeTruthy();
  });
  it("says the first sync once — banner only, no duplicate empty state", () => {
    useRelayStore.setState({
      connectionStatus: "encrypted",
      isEncrypted: true,
      isSyncing: true,
      hasSyncedOnce: false,
      machinePresence: {
        session_id: "s1",
        daemon_connected: true,
        daemon_rpc_ready: true,
        last_seen_at: null,
      },
    });

    const text = textOf(renderComponent(<SidebarView {...base} />));

    expect(text).toContain("Syncing your projects…");
    expect(text.match(/Syncing your projects…/g)).toHaveLength(1);
    expect(text).not.toContain("Loading your projects");
    expect(text).not.toContain("No projects");
  });
  it("filters threads with a declarative colour filter", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1" }),
        threads: [
          thread({
            id: "red-thread",
            workspace_id: "w1",
            title: "Red thread",
            is_pinned: true,
          }),
          thread({ id: "blue-thread", workspace_id: "w1", title: "Blue thread" }),
        ],
      },
    ];
    const extensionSnapshot: ExtensionSnapshot = {
      catalog: [],
      views: [
        {
          extension_id: "falcondeck.thread-tags",
          view_id: "thread-tags",
          scope: { kind: "thread", id: "red-thread" },
          value: { tagIds: ["red"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
        {
          extension_id: "falcondeck.thread-tags",
          view_id: "thread-tags",
          scope: { kind: "thread", id: "blue-thread" },
          value: { tagIds: ["blue"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
      ],
    };
    const extensionSidebarFilters: ExtensionSidebarFilterDefinition[] = [
      {
        key: "falcondeck.thread-tags:colors",
        extensionId: "falcondeck.thread-tags",
        extensionName: "Thread Colours",
        contributionId: "colors",
        title: "Colours",
        unsupportedReason: null,
        document: {
          version: 1,
          root: {
            type: "select",
            id: "colors",
            label: "Filter by colour",
            multiple: true,
            options: [
              { value: "red", label: "Red", tone: "red" },
              { value: "blue", label: "Blue", tone: "blue" },
            ],
            binding: {
              view: "thread-tags",
              path: ["tagIds"],
              operator: "includes_any",
            },
          },
        },
      },
    ];
    const r = renderComponent(
      <SidebarView
        {...base}
        groups={groups}
        extensionSnapshot={extensionSnapshot}
        extensionSidebarFilters={extensionSidebarFilters}
      />,
    );

    expect(textOf(r)).not.toContain("available on desktop and web");
    expect(
      r.root.findAllByProps({ accessibilityLabel: "Filter threads" }),
    ).toHaveLength(1);
    act(() => {
      r.root.findByProps({ accessibilityLabel: "Filter threads" }).props.onPress();
    });
    act(() => {
      r.root.findByProps({ accessibilityLabel: "Red" }).props.onPress();
    });
    act(() => {
      r.root
        .findAll(
          (node) =>
            node.props.accessibilityLabel === "Close thread filters" &&
            typeof node.props.onPress === "function",
        )[0]!
        .props.onPress();
    });

    expect(textOf(r)).toContain("Red thread");
    expect(textOf(r)).not.toContain("Blue thread");
  });
  it("shows a visible fallback for extension panels not supported on mobile", () => {
    const r = renderComponent(
      <SidebarView {...base} extensionPanelCount={1} />,
    );

    expect(textOf(r)).toContain(
      "This extension provides a panel not yet supported here.",
    );
  });
});
