#[cfg(target_os = "macos")]
use std::ffi::CString;

const ALLOWED_SYSTEM_SOUNDS: &[&str] = &[
    "Bottle",
    "Glass",
    "Ping",
    "Pop",
    "Purr",
    "Submarine",
    "Tink",
];

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn fd_play_system_sound(name: *const std::ffi::c_char) -> bool;
}

fn is_allowed_system_sound(name: &str) -> bool {
    ALLOWED_SYSTEM_SOUNDS.contains(&name)
}

#[tauri::command]
pub(crate) fn play_system_sound(name: String) -> Result<(), String> {
    if !is_allowed_system_sound(&name) {
        return Err(format!("unknown system sound: {name}"));
    }

    #[cfg(target_os = "macos")]
    {
        let c_name = CString::new(name).map_err(|error| error.to_string())?;
        let played = unsafe { fd_play_system_sound(c_name.as_ptr()) };
        if played {
            Ok(())
        } else {
            Err("macOS could not play that system sound".to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        Err("system sounds are only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_system_sound, play_system_sound};

    #[test]
    fn allowlist_accepts_the_shipped_macos_chimes() {
        assert!(is_allowed_system_sound("Glass"));
        assert!(is_allowed_system_sound("Ping"));
        assert!(is_allowed_system_sound("Tink"));
    }

    #[test]
    fn allowlist_rejects_paths_and_unknown_names() {
        assert!(!is_allowed_system_sound("../Glass"));
        assert!(!is_allowed_system_sound(
            "/System/Library/Sounds/Glass.aiff"
        ));
        assert!(!is_allowed_system_sound("Sosumi"));
        assert!(!is_allowed_system_sound(""));
    }

    #[test]
    fn command_rejects_unknown_names_before_playback() {
        let error = play_system_sound("Sosumi".to_string()).expect_err("unknown names fail");
        assert!(error.contains("unknown system sound"));
    }
}
