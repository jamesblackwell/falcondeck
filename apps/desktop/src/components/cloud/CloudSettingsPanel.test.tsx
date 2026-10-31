import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSettings } from "@falcondeck/client-core";
import { CloudSettingsPanel } from "./CloudSettingsPanel";
import type { CloudApi } from "./cloud-api";

function settings(team: string): CloudSettings {
  return {
    enabled: false,
    has_provider_token: false,
    has_openai_api_key: false,
    team_id: team,
    project_id: "project",
    image: "worker@sha256:" + "a".repeat(64),
    timeout_minutes: 30,
    node_binary: "node",
    runtime_path: "/runtime/cli.mjs",
    worker_daemon_url: "",
    worker_daemon_sha256: "",
    allowed_domains: ["api.openai.com"],
  };
}

function apiFor(team: string) {
  const config = settings(team);
  return {
    settings: vi.fn().mockResolvedValue(config),
    updateSettings: vi.fn().mockResolvedValue(config),
  } as unknown as CloudApi & {
    settings: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
  };
}

afterEach(cleanup);

describe("CloudSettingsPanel", () => {
  it("loads and saves through the selected project owner", async () => {
    const local = apiFor("local-team");
    const remote = apiFor("remote-team");
    render(<CloudSettingsPanel owners={[
      { id: "local", label: "This Mac", api: local },
      { id: "remote", label: "Build server", api: remote },
    ]} initialOwnerId="remote" />);

    expect(await screen.findByLabelText("Vercel team ID")).toHaveValue("remote-team");
    expect(local.settings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));
    await waitFor(() => expect(remote.updateSettings).toHaveBeenCalledTimes(1));
    expect(local.updateSettings).not.toHaveBeenCalled();
  });

  it("discards an old host's delayed response after switching", async () => {
    let finishLocal!: (value: CloudSettings) => void;
    const local = apiFor("local-team");
    local.settings.mockImplementation(() => new Promise<CloudSettings>((resolve) => { finishLocal = resolve; }));
    const remote = apiFor("remote-team");
    render(<CloudSettingsPanel owners={[
      { id: "local", label: "This Mac", api: local },
      { id: "remote", label: "Build server", api: remote },
    ]} />);
    fireEvent.change(screen.getByLabelText("Project host"), { target: { value: "remote" } });
    expect(await screen.findByLabelText("Vercel team ID")).toHaveValue("remote-team");
    await act(async () => { finishLocal(settings("stale-local-team")); });
    expect(screen.getByLabelText("Vercel team ID")).toHaveValue("remote-team");
  });

  it("does not fall back to the Mac when the chosen host is unavailable", async () => {
    const local = apiFor("local-team");
    render(<CloudSettingsPanel owners={[
      { id: "local", label: "This Mac", api: local },
      { id: "remote", label: "Build server", api: null },
    ]} initialOwnerId="remote" />);
    expect(screen.getByRole("status")).toHaveTextContent("Connect the selected project host");
    expect(local.settings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Vercel access token")).not.toBeInTheDocument();
  });

  it("ignores a stale save when the host connection is replaced", async () => {
    let finishSave!: (value: CloudSettings) => void;
    const previous = apiFor("previous-team");
    previous.updateSettings.mockImplementation(() => new Promise<CloudSettings>((resolve) => { finishSave = resolve; }));
    const { rerender } = render(<CloudSettingsPanel owners={[{ id: "local", label: "This Mac", api: previous }]} />);
    await screen.findByLabelText("Vercel team ID");
    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));
    await waitFor(() => expect(previous.updateSettings).toHaveBeenCalledTimes(1));
    const replacement = apiFor("replacement-team");
    rerender(<CloudSettingsPanel owners={[{ id: "local", label: "This Mac", api: replacement }]} />);
    await waitFor(() => expect(screen.getByLabelText("Vercel team ID")).toHaveValue("replacement-team"));
    await act(async () => { finishSave(settings("stale-save-team")); });
    expect(screen.getByLabelText("Vercel team ID")).toHaveValue("replacement-team");
  });

  it("does not display a credential form for a removed host", async () => {
    const local = apiFor("local-team");
    render(<CloudSettingsPanel owners={[{ id: "local", label: "This Mac", api: local }]} initialOwnerId="removed" />);
    expect(screen.getByRole("status")).toHaveTextContent("Connect the selected project host");
    expect(local.settings).not.toHaveBeenCalled();
  });
});
