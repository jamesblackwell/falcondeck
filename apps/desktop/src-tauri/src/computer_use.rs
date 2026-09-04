use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUsePermission {
    Accessibility,
    ScreenRecording,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUsePermissionStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
    pub macos_ok: bool,
    pub macos_major: i32,
    pub supported: bool,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn fd_dictation_accessibility_permission() -> bool;
    fn fd_dictation_request_accessibility_permission();
    fn fd_dictation_open_accessibility_settings();
    fn fd_computer_use_screen_recording_permission() -> bool;
    fn fd_computer_use_request_screen_recording_permission();
    fn fd_computer_use_open_screen_recording_settings();
    fn fd_computer_use_macos_major() -> i32;
}

#[tauri::command]
pub fn computer_use_permission_status() -> ComputerUsePermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        let macos_major = fd_computer_use_macos_major();
        return ComputerUsePermissionStatus {
            accessibility: fd_dictation_accessibility_permission(),
            screen_recording: fd_computer_use_screen_recording_permission(),
            macos_ok: macos_major >= 14,
            macos_major,
            supported: true,
        };
    }
    #[cfg(not(target_os = "macos"))]
    ComputerUsePermissionStatus {
        accessibility: false,
        screen_recording: false,
        macos_ok: false,
        macos_major: 0,
        supported: false,
    }
}

#[tauri::command]
pub fn request_computer_use_permission(permission: ComputerUsePermission) {
    #[cfg(target_os = "macos")]
    unsafe {
        match permission {
            ComputerUsePermission::Accessibility => {
                fd_dictation_request_accessibility_permission();
            }
            ComputerUsePermission::ScreenRecording => {
                fd_computer_use_request_screen_recording_permission();
            }
        }
    }
    let _ = permission;
}

#[tauri::command]
pub fn open_computer_use_settings(permission: ComputerUsePermission) {
    #[cfg(target_os = "macos")]
    unsafe {
        match permission {
            ComputerUsePermission::Accessibility => fd_dictation_open_accessibility_settings(),
            ComputerUsePermission::ScreenRecording => {
                fd_computer_use_open_screen_recording_settings();
            }
        }
    }
    let _ = permission;
}
