/** Secret-free configuration returned by the coordinator. */
export interface CloudSettings {
  enabled: boolean;
  has_provider_token: boolean;
  has_openai_api_key: boolean;
  team_id: string | null;
  project_id: string | null;
  image: string;
  timeout_minutes: number;
  node_binary: string;
  runtime_path: string;
  worker_daemon_url: string;
  worker_daemon_sha256: string;
  allowed_domains: string[];
}
/** Credentials are write-only; empty strings clear them. */
export interface UpdateCloudSettingsRequest {
  enabled?: boolean;
  provider_token?: string;
  openai_api_key?: string;
  team_id?: string;
  project_id?: string;
  image?: string;
  timeout_minutes?: number;
  node_binary?: string;
  runtime_path?: string;
  worker_daemon_url?: string;
  worker_daemon_sha256?: string;
  allowed_domains?: string[];
}
export interface CaptureCloudSourceRequest { workspace_id: string }
export interface CloudSourcePreview {
  id: string;
  workspace_id: string;
  base_head: string | null;
  tree_hash: string;
  included_paths: string[];
  excluded_paths: string[];
  total_bytes: number;
  created_at: string;
}
export interface CreateCloudJobRequest {
  workspace_id: string;
  prompt: string;
  source_capture_id?: string | null;
  idempotency_key: string;
  model_id?: string | null;
}
export type CloudJobStatus = "provisioning" | "running" | "awaiting_input" | "completed" | "failed" | "unknown" | "stopping" | "stopped" | "expired";
export interface CloudWorkerLocator { workspace_id: string; thread_id: string; provider: string }
export interface CloudJobResult {
  collected_at: string;
  tree_hash: string;
  changed_paths: string[];
  deleted_paths: string[];
  native_session_count: number;
  imported_at: string | null;
}
export interface CloudJob {
  id: string;
  workspace_id: string;
  source: CloudSourcePreview;
  status: CloudJobStatus;
  prompt: string;
  model_id: string | null;
  worker: CloudWorkerLocator | null;
  result: CloudJobResult | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}
export type CloudJobDetail = import("./types").ThreadDetail & {
  interactive_requests: import("./types").InteractiveRequest[];
  is_live: boolean;
  collected_at: string | null;
};
