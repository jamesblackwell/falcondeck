export const WORKSPACE_COLOR_IDS = [
  "cat-1",
  "cat-2",
  "cat-3",
  "cat-4",
  "cat-5",
  "cat-6",
  "cat-7",
  "cat-8",
  "cat-9",
  "cat-10",
  "cat-11",
  "cat-12",
] as const;

export type WorkspaceColorId = (typeof WORKSPACE_COLOR_IDS)[number];

const WORKSPACE_COLOR_ID_SET = new Set<string>(WORKSPACE_COLOR_IDS);

export function isWorkspaceColorId(
  value: string | null | undefined,
): value is WorkspaceColorId {
  return typeof value === "string" && WORKSPACE_COLOR_ID_SET.has(value);
}

export function workspaceColorCssVar(
  color: string | null | undefined,
): string | undefined {
  return isWorkspaceColorId(color) ? `var(--fd-${color})` : undefined;
}

export function normalizeWorkspaceColors(
  value: unknown,
): Record<string, WorkspaceColorId> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const colors: Record<string, WorkspaceColorId> = {};
  for (const [workspaceId, color] of Object.entries(value)) {
    const normalizedId = workspaceId.trim();
    if (!normalizedId || !isWorkspaceColorId(color) || colors[normalizedId]) {
      continue;
    }
    colors[normalizedId] = color;
  }
  return colors;
}
