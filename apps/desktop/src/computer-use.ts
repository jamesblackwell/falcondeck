import { isTauriDesktop } from "./api";

export type ComputerUsePermission = "accessibility" | "screen_recording";

export type ComputerUsePermissionStatus = {
  accessibility: boolean;
  screenRecording: boolean;
  macosOk: boolean;
  macosMajor: number;
  supported: boolean;
};

const UNSUPPORTED: ComputerUsePermissionStatus = {
  accessibility: false,
  screenRecording: false,
  macosOk: false,
  macosMajor: 0,
  supported: false,
};

export async function readComputerUsePermissions(): Promise<ComputerUsePermissionStatus> {
  if (!isTauriDesktop()) return UNSUPPORTED;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ComputerUsePermissionStatus>("computer_use_permission_status");
}

export async function requestComputerUsePermission(
  permission: ComputerUsePermission,
): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("request_computer_use_permission", { permission });
}

export async function openComputerUseSettings(
  permission: ComputerUsePermission,
): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_computer_use_settings", { permission });
}

export async function restartFalconDeck(): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_app");
}
