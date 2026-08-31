import type { ExtensionSnapshot } from "./types";

export const MISSIONS_EXTENSION_ID = "falcondeck.missions";
export const MISSIONS_REQUIRED_PERMISSIONS = [
  "threads:read",
  "agent-tools:register",
  "orchestration:manage-owned-tasks",
] as const;

/** Whether the composer may honestly advertise FalconDeck's Mission flow. */
export function missionCommandAvailable(
  extensions: ExtensionSnapshot | null | undefined,
): boolean {
  const mission = extensions?.catalog.find(
    (extension) => extension.id === MISSIONS_EXTENSION_ID,
  );
  if (!mission || !mission.enabled || mission.status !== "active") return false;
  const granted = new Set(mission.granted_permissions ?? []);
  return (
    MISSIONS_REQUIRED_PERMISSIONS.every((permission) =>
      granted.has(permission),
    ) &&
    (mission.contributes.agentTools ?? []).some(
      (tool) => tool.id === "draft-mission",
    )
  );
}
