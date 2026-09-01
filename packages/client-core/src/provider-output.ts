import type {
  ImageInput,
  ToolCallDetail,
  ToolProviderOutputSummary,
} from "./types";

export type McpResultContent =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; mime_type: string; alt_text: string | null }
  | { kind: "audio"; url: string; mime_type: string }
  | {
      kind: "resource_link";
      uri: string;
      name: string;
      title: string | null;
      description: string | null;
      mime_type: string | null;
      size: number | null;
      icons: McpResourceIcon[];
      annotations: unknown | null;
      metadata: unknown | null;
    }
  | {
      kind: "resource";
      uri: string;
      mime_type: string | null;
      text: string | null;
      blob_url: string | null;
      byte_size: number | null;
      metadata: unknown | null;
    }
  | { kind: "unknown"; value: unknown };

export type ParsedMcpResult = {
  content: McpResultContent[];
  structured_content: unknown | null;
  metadata: unknown | null;
  extra: Record<string, unknown> | null;
};

export type McpResourceIcon = {
  src: string;
  mime_type: string | null;
  sizes: string | null;
  theme: "light" | "dark" | null;
};

export type McpArtifactSummary = {
  total: number;
  resource_links: number;
  embedded_resources: number;
  images: number;
  audio: number;
  structured_results: number;
};

export type McpResultInspection = {
  /** True when the MCP result already carries canonical text output. */
  has_text_content: boolean;
  /** Cheap structural artifact counts used by transcript rows and grouping. */
  artifacts: McpArtifactSummary;
};

type GuardianReviewDetail = Extract<
  NonNullable<ToolCallDetail>,
  { kind: "guardian_review" }
>;

function providerMetadataLabel(value: string, fallback: string): string {
  const words = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!words) return fallback;
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/** Shared safety-review semantics so every client presents provider state alike. */
export function guardianReviewPresentation(detail: GuardianReviewDetail) {
  const normalizedStatus = detail.status.trim().toLowerCase();
  const statusLabel =
    normalizedStatus === "inprogress"
      ? "Reviewing"
      : normalizedStatus === "timedout"
        ? "Timed out"
        : providerMetadataLabel(detail.status, "Unknown");
  return {
    statusLabel,
    actionKindLabel: providerMetadataLabel(detail.action_kind, "Action"),
    decisionSourceLabel: detail.decision_source
      ? providerMetadataLabel(detail.decision_source, "Unknown")
      : null,
    active: normalizedStatus === "inprogress",
    urgent:
      normalizedStatus === "denied" ||
      detail.risk_level?.trim().toLowerCase() === "critical",
  };
}

// Provider payloads are immutable once attached to a normalized conversation
// item. A single render can inspect the same MCP result for presentation tier,
// suppression, artifact count, and body content; retain the parsed view so
// those checks do not repeatedly decode metadata or large inline resources.
const parsedMcpResultCache = new WeakMap<object, ParsedMcpResult>();
const mcpResultInspectionCache = new WeakMap<object, McpResultInspection>();
const providerOutputInspectionCache = new WeakMap<
  ToolProviderOutputSummary,
  McpResultInspection
>();

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedBase64(value: unknown): string | null {
  const encoded = string(value)?.replace(/\s/g, "");
  return encoded &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
    ? encoded
    : null;
}

function dataUrl(mimeType: string, data: unknown): string | null {
  const encoded = normalizedBase64(data);
  if (!encoded) return null;
  const safeMimeType =
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)
      ? mimeType
      : "application/octet-stream";
  return `data:${safeMimeType};base64,${encoded}`;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function base64ByteSize(value: unknown): number | null {
  const encoded = normalizedBase64(value);
  if (!encoded) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function parseResourceIcons(value: unknown): McpResourceIcon[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const icon = record(entry);
    const src = string(icon?.src);
    if (!icon || !src) return [];
    const theme =
      icon.theme === "light" || icon.theme === "dark" ? icon.theme : null;
    return [
      {
        src,
        mime_type: string(icon.mimeType) ?? string(icon.mime_type),
        sizes: string(icon.sizes),
        theme,
      },
    ];
  });
}

function parseContent(value: unknown): McpResultContent {
  const item = record(value);
  const type = string(item?.type);
  if (!item || !type) return { kind: "unknown", value };

  if (type === "text" && typeof item.text === "string") {
    return { kind: "text", text: item.text };
  }
  if (type === "image") {
    const mimeType =
      string(item.mimeType) ?? string(item.mime_type) ?? "image/png";
    const url = string(item.url) ?? dataUrl(mimeType, item.data);
    if (url) {
      return {
        kind: "image",
        url,
        mime_type: mimeType,
        alt_text: string(item.altText) ?? string(item.alt_text),
      };
    }
  }
  if (type === "audio") {
    const mimeType =
      string(item.mimeType) ?? string(item.mime_type) ?? "audio/mpeg";
    const url = string(item.url) ?? dataUrl(mimeType, item.data);
    if (url) return { kind: "audio", url, mime_type: mimeType };
  }
  if (type === "resource_link") {
    const uri = string(item.uri);
    const name = string(item.name);
    if (uri && name) {
      return {
        kind: "resource_link",
        uri,
        name,
        title: string(item.title),
        description: string(item.description),
        mime_type: string(item.mimeType) ?? string(item.mime_type),
        size: number(item.size),
        icons: parseResourceIcons(item.icons),
        annotations: item.annotations ?? null,
        metadata: item._meta ?? null,
      };
    }
  }
  if (type === "resource") {
    const resource = record(item.resource);
    const uri = string(resource?.uri);
    if (resource && uri) {
      const mimeType = string(resource.mimeType) ?? string(resource.mime_type);
      return {
        kind: "resource",
        uri,
        mime_type: mimeType,
        text: typeof resource.text === "string" ? resource.text : null,
        blob_url: dataUrl(
          mimeType ?? "application/octet-stream",
          resource.blob,
        ),
        byte_size: base64ByteSize(resource.blob),
        metadata: resource._meta ?? null,
      };
    }
  }
  return { kind: "unknown", value };
}

/**
 * Inspects only the fields needed by collapsed transcript rows. Unlike
 * `parseMcpResult`, this deliberately avoids decoding resource metadata,
 * normalizing embedded blobs, or allocating display primitives. Full parsing
 * stays behind the tool-detail disclosure.
 */
export function inspectMcpResult(
  value: unknown,
  summary?: ToolProviderOutputSummary | null,
): McpResultInspection {
  if (summary) {
    const cached = providerOutputInspectionCache.get(summary);
    if (cached) return cached;
    const artifacts: McpArtifactSummary = {
      total:
        summary.images +
        summary.audio +
        summary.resource_links +
        summary.embedded_resources +
        summary.structured_results,
      resource_links: summary.resource_links,
      embedded_resources: summary.embedded_resources,
      images: summary.images,
      audio: summary.audio,
      structured_results: summary.structured_results,
    };
    const inspection = {
      has_text_content: summary.text_blocks > 0,
      artifacts,
    };
    providerOutputInspectionCache.set(summary, inspection);
    return inspection;
  }
  const result = record(value);
  if (!result) {
    return {
      has_text_content: false,
      artifacts: {
        total: 0,
        resource_links: 0,
        embedded_resources: 0,
        images: 0,
        audio: 0,
        structured_results: 0,
      },
    };
  }
  const cached = mcpResultInspectionCache.get(result);
  if (cached) return cached;

  const artifacts: McpArtifactSummary = {
    total: 0,
    resource_links: 0,
    embedded_resources: 0,
    images: 0,
    audio: 0,
    structured_results:
      result.structuredContent == null && result.structured_content == null
        ? 0
        : 1,
  };
  let hasTextContent = false;
  if (Array.isArray(result.content)) {
    for (const value of result.content) {
      const item = record(value);
      const type = string(item?.type);
      if (!item || !type) continue;
      if (type === "text" && typeof item.text === "string") {
        hasTextContent = true;
      } else if (
        type === "image" &&
        (string(item.url) || normalizedBase64(item.data))
      ) {
        artifacts.images += 1;
      } else if (
        type === "audio" &&
        (string(item.url) || normalizedBase64(item.data))
      ) {
        artifacts.audio += 1;
      } else if (
        type === "resource_link" &&
        string(item.uri) &&
        string(item.name)
      ) {
        artifacts.resource_links += 1;
      } else if (type === "resource") {
        const resource = record(item.resource);
        if (resource && string(resource.uri)) {
          artifacts.embedded_resources += 1;
        }
      }
    }
  }
  artifacts.total =
    artifacts.resource_links +
    artifacts.embedded_resources +
    artifacts.images +
    artifacts.audio +
    artifacts.structured_results;
  const inspection = { has_text_content: hasTextContent, artifacts };
  mcpResultInspectionCache.set(result, inspection);
  return inspection;
}

export function summarizeParsedMcpArtifacts(
  result: ParsedMcpResult,
): McpArtifactSummary {
  const summary: McpArtifactSummary = {
    total: 0,
    resource_links: 0,
    embedded_resources: 0,
    images: 0,
    audio: 0,
    structured_results: result.structured_content == null ? 0 : 1,
  };
  for (const content of result.content) {
    if (content.kind === "resource_link") summary.resource_links += 1;
    else if (content.kind === "resource") summary.embedded_resources += 1;
    else if (content.kind === "image") summary.images += 1;
    else if (content.kind === "audio") summary.audio += 1;
  }
  summary.total =
    summary.resource_links +
    summary.embedded_resources +
    summary.images +
    summary.audio +
    summary.structured_results;
  return summary;
}

export function summarizeMcpArtifacts(
  value: unknown,
  summary?: ToolProviderOutputSummary | null,
): McpArtifactSummary {
  return inspectMcpResult(value, summary).artifacts;
}

export function formatArtifactSize(
  bytes: number | null | undefined,
): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000)
    return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/**
 * Converts the open-ended MCP CallToolResult into ordered display primitives.
 * Unknown content is deliberately retained so a provider addition never
 * silently disappears from the conversation.
 */
export function parseMcpResult(value: unknown): ParsedMcpResult {
  const result = record(value);
  if (!result) {
    return {
      content: value == null ? [] : [{ kind: "unknown", value }],
      structured_content: null,
      metadata: null,
      extra: null,
    };
  }
  const cached = parsedMcpResultCache.get(result);
  if (cached) return cached;

  const { content, structuredContent, structured_content, _meta, ...extra } =
    result;
  const parsed: ParsedMcpResult = {
    content: Array.isArray(content) ? content.map(parseContent) : [],
    structured_content: structuredContent ?? structured_content ?? null,
    metadata: _meta ?? null,
    extra: Object.keys(extra).length > 0 ? extra : null,
  };
  parsedMcpResultCache.set(result, parsed);
  return parsed;
}

export type ExtensionToolResultIdentity = {
  extensionId: string;
  toolId: string;
};

/** Identifies a result emitted by FalconDeck's manifest-declared tool bridge. */
export function extensionToolResultIdentity(
  value: unknown,
): ExtensionToolResultIdentity | null {
  const metadata = record(parseMcpResult(value).metadata);
  const identity = record(metadata?.["falcondeck/extensionTool"]);
  const extensionId = identity?.extensionId;
  const toolId = identity?.toolId;
  return typeof extensionId === "string" && typeof toolId === "string"
    ? { extensionId, toolId }
    : null;
}

export function isSafeMediaUrl(url: string, media: "image" | "audio"): boolean {
  const normalized = url.trim();
  if (/^https?:\/\//i.test(normalized)) return isSafeExternalUrl(normalized);
  if (/^blob:/i.test(normalized)) {
    return (
      !/[\u0000-\u0020\u007F]/.test(normalized) &&
      /^blob:(?:(?:https?|tauri):\/\/[^/\s]+\/|null\/)[^\s]+$/i.test(normalized)
    );
  }
  const dataMatch = new RegExp(
    `^data:${media}/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$`,
    "i",
  ).exec(normalized);
  return dataMatch ? normalizedBase64(dataMatch[1]) !== null : false;
}

/** Native image decoders also need the local URI schemes emitted by iOS and
 * Android pickers. Keep this separate from browser media validation so a
 * daemon-local file URL can never become a web-renderable attachment. */
export function isSafeNativeImageUrl(url: string): boolean {
  const normalized = url.trim();
  return (
    isSafeMediaUrl(normalized, "image") ||
    /^(?:file|content|ph|assets-library):\/\//i.test(normalized)
  );
}

/** Stable, compact attachment label shared by DOM and native renderers.
 * Data URLs deliberately never become visible filenames. */
export function imageInputLabel(attachment: ImageInput): string {
  const suppliedName = attachment.name?.trim();
  if (suppliedName) return suppliedName;

  const candidate = attachment.local_path?.trim() || attachment.url.trim();
  if (!candidate || /^data:/i.test(candidate)) return "Image";

  const path = candidate.split(/[?#]/, 1)[0];
  const encodedName = path.split(/[\\/]/).filter(Boolean).at(-1);
  if (!encodedName || encodedName.includes(":")) return "Image";

  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

export function isSafeExternalUrl(url: string): boolean {
  const normalized = url.trim();
  if (!normalized || /[\u0000-\u001F\u007F]/.test(normalized)) return false;
  try {
    const parsed = new URL(normalized);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

/** Trim and validate an untrusted provider URL before exposing it as an action. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  const normalized = url?.trim() ?? "";
  return isSafeExternalUrl(normalized) ? normalized : null;
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60)
    return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1).replace(/\.0$/, "")} s`;
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
}
