import type { AgentCapabilitySummary, CloudSettings, WorkspaceSummary } from "@falcondeck/client-core";

export function cloudLaunchBlockReason({ workspace, provider, settings, settingsError, loading, attachmentCount }: {
  workspace: WorkspaceSummary | null;
  provider: string;
  settings: CloudSettings | null;
  settingsError?: string | null;
  loading: boolean;
  attachmentCount: number;
}): string | null {
  if (!workspace || workspace.kind === "casual") return "Select a project to run in the cloud.";
  if (provider !== "codex") return "Cloud execution currently supports Codex. Choose Codex to continue.";
  if (attachmentCount) return "Cloud execution currently accepts text. Remove attachments to continue.";
  if (loading) return "Checking cloud settings…";
  if (settingsError) return settingsError;
  if (!settings?.enabled || !settings.has_provider_token || !settings.has_openai_api_key || !settings.team_id || !settings.project_id || !settings.image.includes("@sha256:") || !settings.runtime_path) {
    return "Set up Cloud execution in Settings to continue.";
  }
  // The coordinator validates the worker configuration; local CLI sign-in does
  // not apply to the separate API credential used inside the cloud environment.
  return null;
}

export function cloudConversationCapabilities(base: AgentCapabilitySummary): AgentCapabilitySummary {
  return { ...base, supports_images: false, supports_skills: false, supports_goals: false, supports_review: false, supports_forking: false, supports_compaction: false, supports_compaction_instructions: false, supports_interrupt: true, supports_steering: false };
}
