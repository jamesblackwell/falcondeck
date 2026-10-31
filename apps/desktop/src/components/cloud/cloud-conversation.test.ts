import { describe, expect, it } from "vitest";
import { NO_AGENT_CAPABILITIES, type CloudSettings, type WorkspaceSummary } from "@falcondeck/client-core";
import { cloudConversationCapabilities, cloudLaunchBlockReason } from "./cloud-conversation";

const settings: CloudSettings = {
  enabled: true, has_provider_token: true, has_openai_api_key: true,
  team_id: "team", project_id: "project", image: "worker@sha256:" + "a".repeat(64),
  runtime_path: "/runtime/cli.mjs", node_binary: "node", timeout_minutes: 30,
  worker_daemon_url: "", worker_daemon_sha256: "", allowed_domains: [],
};
const workspace = { id: "ws", kind: "project", status: "needs_auth", agents: [], path: "/source" } as unknown as WorkspaceSummary;
const request = { workspace, provider: "codex", settings, loading: false, attachmentCount: 0 };

describe("cloud conversation readiness", () => {
  it("does not require local CLI authentication or installation", () => {
    expect(cloudLaunchBlockReason(request)).toBeNull();
    expect(cloudLaunchBlockReason({ ...request, workspace: { ...workspace, status: "error" } })).toBeNull();
  });
  it("keeps missing configuration in Settings and blocks a pending host response", () => {
    expect(cloudLaunchBlockReason({ ...request, settings: null })).toMatch(/Settings/);
    expect(cloudLaunchBlockReason({ ...request, loading: true })).toMatch(/Checking/);
    expect(cloudLaunchBlockReason({ ...request, settingsError: "Host offline" })).toBe("Host offline");
  });
  it("rejects unsupported harnesses, non-project source and attachments", () => {
    expect(cloudLaunchBlockReason({ ...request, provider: "claude" })).toMatch(/supports Codex/);
    expect(cloudLaunchBlockReason({ ...request, workspace: { ...workspace, kind: "casual" } })).toMatch(/Select a project/);
    expect(cloudLaunchBlockReason({ ...request, attachmentCount: 1 })).toMatch(/Remove attachments/);
  });
  it("only exposes cloud operations that the current worker implements", () => {
    const capabilities = cloudConversationCapabilities({ ...NO_AGENT_CAPABILITIES, supports_images: true, supports_goals: true, supports_skills: true, supports_forking: true, supports_compaction: true, supports_review: true });
    expect(capabilities.supports_interrupt).toBe(true);
    expect(capabilities.supports_forking).toBe(false);
    expect(capabilities.supports_compaction).toBe(false);
    expect(capabilities.supports_images).toBe(false);
    expect(capabilities.supports_goals).toBe(false);
    expect(capabilities.supports_skills).toBe(false);
    expect(capabilities.supports_review).toBe(false);
  });
});
