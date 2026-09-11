import type {
  WorkspaceIconPreference,
  WorkspaceResolvedIcon,
} from "./types";

const ICON_MODES = new Set(["auto", "folder", "domain"]);

export function sanitizeLogoDomain(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const domain = raw.trim().replace(/\.+$/, "").toLowerCase();
  if (!domain || domain.length > 253) return null;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return null;
  }
  if (![...domain].every((ch) => /[a-z0-9.-]/.test(ch))) return null;
  if (!domain.includes(".")) return null;
  return domain;
}

export function normalizeWorkspaceIconPreference(
  value: unknown,
): WorkspaceIconPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { mode?: unknown; domain?: unknown };
  if (typeof raw.mode !== "string" || !ICON_MODES.has(raw.mode)) return null;
  if (raw.mode === "domain") {
    const domain = sanitizeLogoDomain(
      typeof raw.domain === "string" ? raw.domain : null,
    );
    if (!domain) return null;
    return { mode: "domain", domain };
  }
  return { mode: raw.mode as "auto" | "folder" };
}

export function normalizeWorkspaceIcons(
  value: unknown,
): Record<string, WorkspaceIconPreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const icons: Record<string, WorkspaceIconPreference> = {};
  for (const [workspaceId, preference] of Object.entries(value)) {
    const normalizedId = workspaceId.trim();
    if (!normalizedId || icons[normalizedId]) continue;
    const normalized = normalizeWorkspaceIconPreference(preference);
    if (!normalized) continue;
    icons[normalizedId] = normalized;
  }
  return icons;
}

export function normalizeWorkspaceResolvedIcon(
  value: unknown,
): WorkspaceResolvedIcon | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as {
    kind?: unknown;
    etag?: unknown;
    source?: unknown;
    domain?: unknown;
  };
  if (raw.kind === "folder") {
    return { kind: "folder" };
  }
  if (raw.kind !== "image") return null;
  const etag = typeof raw.etag === "string" && raw.etag.trim() ? raw.etag : null;
  const source = raw.source === "file" || raw.source === "domain" ? raw.source : null;
  const domain = sanitizeLogoDomain(
    typeof raw.domain === "string" ? raw.domain : null,
  );
  return {
    kind: "image",
    etag,
    source,
    domain,
  };
}

export function workspaceIconPreference(
  icons: Record<string, WorkspaceIconPreference> | undefined,
  workspaceId: string,
): WorkspaceIconPreference {
  return icons?.[workspaceId] ?? { mode: "auto" };
}

/** Accepts a bare host or a pasted URL from the Website… dialog. */
export function workspaceIconUrl(
  baseUrl: string | null | undefined,
  workspaceId: string,
  icon: WorkspaceResolvedIcon | null | undefined,
  preference?: WorkspaceIconPreference | null,
): string | null {
  if (!baseUrl || preference?.mode === "folder" || icon?.kind !== "image") {
    return null;
  }
  const path = `${baseUrl.replace(/\/$/, "")}/api/workspace-icons/${encodeURIComponent(workspaceId)}`;
  return icon.etag ? `${path}?v=${encodeURIComponent(icon.etag)}` : path;
}

export function domainFromUserInput(raw: string): string | null {
  const trimmed = raw.trim();
  const direct = sanitizeLogoDomain(trimmed);
  if (direct) return direct;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return sanitizeLogoDomain(url.hostname);
  } catch {
    return null;
  }
}
