import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSettings, UpdateCloudSettingsRequest } from "@falcondeck/client-core";
import type { CloudApi } from "./cloud-api";
import { CloudSettingsForm } from "./CloudSettingsForm";

const savedSettings: CloudSettings = {
  enabled: true,
  has_provider_token: true,
  has_openai_api_key: true,
  team_id: "team-id",
  project_id: "project-id",
  image: "node:22",
  timeout_minutes: 30,
  node_binary: "node",
  runtime_path: "/runtime/cloud-worker.mjs",
  worker_daemon_url: "https://downloads.example.test/falcondeck-daemon",
  worker_daemon_sha256: "a".repeat(64),
  allowed_domains: ["api.openai.com"],
};

function setup(update = vi.fn<(request: UpdateCloudSettingsRequest) => Promise<CloudSettings>>().mockResolvedValue(savedSettings)) {
  const onSaved = vi.fn();
  const api = { updateSettings: update } as unknown as CloudApi;
  render(<CloudSettingsForm api={api} settings={savedSettings} onSaved={onSaved} />);
  return { update, onSaved };
}

afterEach(cleanup);

describe("CloudSettingsForm", () => {
  it("keeps stored credentials write-only and omits unchanged secrets from saves", async () => {
    const { update, onSaved } = setup();
    expect(screen.getByLabelText("Vercel access token")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Vercel access token")).toHaveValue("");
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
    expect(screen.getByText("A token is saved. Leave this empty to keep it.")).toBeInTheDocument();
    expect(screen.getByText("A key is saved. Leave this empty to keep it.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Vercel team ID"), { target: { value: "new-team-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedSettings));
    const request = update.mock.calls[0][0];
    expect(request.team_id).toBe("new-team-id");
    expect(request).not.toHaveProperty("provider_token");
    expect(request).not.toHaveProperty("openai_api_key");
    expect(screen.getByRole("status")).toHaveTextContent("Cloud settings saved.");
  });

  it("sends newly entered credentials once and clears the password fields after success", async () => {
    const { update, onSaved } = setup();
    fireEvent.change(screen.getByLabelText("Vercel access token"), { target: { value: "replacement-vercel-token" } });
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "replacement-openai-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toMatchObject({
      provider_token: "replacement-vercel-token",
      openai_api_key: "replacement-openai-key",
    });
    expect(screen.getByLabelText("Vercel access token")).toHaveValue("");
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1][0]).not.toHaveProperty("provider_token");
    expect(update.mock.calls[1][0]).not.toHaveProperty("openai_api_key");
  });

  it("requires an explicit removal choice before sending empty secret values", async () => {
    const next = { ...savedSettings, has_provider_token: false, has_openai_api_key: false };
    const update = vi.fn<(request: UpdateCloudSettingsRequest) => Promise<CloudSettings>>().mockResolvedValue(next);
    const { onSaved } = setup(update);
    fireEvent.click(screen.getByRole("checkbox", { name: "Remove saved Vercel token" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Remove saved OpenAI key" }));
    expect(screen.getByLabelText("Vercel access token")).toBeDisabled();
    expect(screen.getByLabelText("OpenAI API key")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next));
    expect(update.mock.calls[0][0]).toMatchObject({ provider_token: "", openai_api_key: "" });
    expect(screen.getByRole("checkbox", { name: "Remove saved Vercel token" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Remove saved OpenAI key" })).not.toBeChecked();
  });

  it("keeps pending credentials and reports a failed save without claiming success", async () => {
    const update = vi.fn<(request: UpdateCloudSettingsRequest) => Promise<CloudSettings>>()
      .mockRejectedValue(new Error("Owning host disconnected"));
    const { onSaved } = setup(update);
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "replacement-openai-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cloud settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Owning host disconnected");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("replacement-openai-key");
    expect(screen.getByRole("button", { name: "Save cloud settings" })).toBeEnabled();
  });
});
