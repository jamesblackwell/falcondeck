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
  it("starts a thread from a row above the project list", () => {
    const onNewThread = vi.fn();
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1", path: "/tmp/proj" }),
        threads: [thread({ id: "t1", workspace_id: "w1" })],
      },
      {
        workspace: workspace({ id: "w2", path: "/tmp/other" }),
        threads: [],
      },
    ];
    const r = renderComponent(
      <SidebarView
        {...base}
        groups={groups}
        selectedWorkspaceId="w2"
        onNewThread={onNewThread}
      />,
    );

    const newThread = r.root.find(
      (node) => node.props.accessibilityLabel === "New thread",
    );
    newThread.props.onPress();
    expect(onNewThread).toHaveBeenCalledWith("w2");
  });

  it("aims the new-thread row at the first project before anything is open", () => {
    const onNewThread = vi.fn();
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1", path: "/tmp/proj" }),
        threads: [],
      },
    ];
    const r = renderComponent(
      <SidebarView {...base} groups={groups} onNewThread={onNewThread} />,
    );

    r.root
      .find((node) => node.props.accessibilityLabel === "New thread")
      .props.onPress();
    expect(onNewThread).toHaveBeenCalledWith("w1");
  });

  it("hides the new-thread row until there is a project to start it in", () => {
    const r = renderComponent(<SidebarView {...base} />);
    expect(
      r.root.findAll((node) => node.props.accessibilityLabel === "New thread"),
    ).toHaveLength(0);
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
  it("shows a skeleton silently during the first-sync grace period", () => {
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

    expect(text).not.toContain("Syncing your projects…");
    expect(text).not.toContain("Loading your projects");
    expect(text).not.toContain("No projects");
  });
  it("filters threads with a synchronized custom stage", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "w1" }),
        threads: [
          thread({
            id: "blocked-thread",
            workspace_id: "w1",
            title: "Blocked thread",
            is_pinned: true,
          }),
          thread({
            id: "done-thread",
            workspace_id: "w1",
            title: "Done thread",
          }),
        ],
      },
    ];
    const extensionSnapshot: ExtensionSnapshot = {
      catalog: [],
      views: [
        {
          extension_id: "falcondeck.thread-tags",
          view_id: "thread-tags",
          scope: { kind: "thread", id: "blocked-thread" },
          value: { tagIds: ["blocked"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
        {
          extension_id: "falcondeck.thread-tags",
          view_id: "thread-tags",
          scope: { kind: "thread", id: "done-thread" },
          value: { tagIds: ["done"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
      ],
    };
    const extensionSidebarFilters: ExtensionSidebarFilterDefinition[] = [
      {
        key: "falcondeck.thread-tags:stages",
        extensionId: "falcondeck.thread-tags",
        extensionName: "Thread Stages",
        contributionId: "stages",
        title: "Stages",
        unsupportedReason: null,
        document: {
          version: 1,
          root: {
            type: "select",
            id: "stages",
            label: "Filter by stage",
            multiple: true,
            options: [{ value: "done", label: "Done", tone: "orange" }],
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
        threadTagOptions={[
          {
            id: "blocked",
            label: "Blocked",
            color: "red",
            icon: "custom",
          },
          { id: "done", label: "Done", color: "orange", icon: "done" },
        ]}
      />,
    );

    expect(textOf(r)).not.toContain("available on desktop and web");
    expect(
      r.root.findAllByProps({ accessibilityLabel: "Filter threads" }),
    ).toHaveLength(1);
    act(() => {
      r.root
        .findByProps({ accessibilityLabel: "Filter threads" })
        .props.onPress();
    });
    act(() => {
      r.root.findByProps({ accessibilityLabel: "Blocked" }).props.onPress();
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

    expect(textOf(r)).toContain("Blocked thread");
    expect(textOf(r)).not.toContain("Done thread");
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
