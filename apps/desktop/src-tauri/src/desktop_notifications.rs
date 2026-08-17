#[cfg(target_os = "macos")]
use mac_usernotifications::{AuthorizationStatus, Notification};

#[cfg(target_os = "macos")]
const PERMISSION_GRANTED: &str = "granted";
#[cfg(target_os = "macos")]
const PERMISSION_DENIED: &str = "denied";
#[cfg(target_os = "macos")]
const PERMISSION_DEFAULT: &str = "default";
#[cfg(not(target_os = "macos"))]
const PERMISSION_UNSUPPORTED: &str = "unsupported";

#[cfg(target_os = "macos")]
fn permission_label(status: AuthorizationStatus) -> &'static str {
    match status {
        AuthorizationStatus::Authorized
        | AuthorizationStatus::Provisional
        | AuthorizationStatus::Ephemeral => PERMISSION_GRANTED,
        AuthorizationStatus::Denied => PERMISSION_DENIED,
        AuthorizationStatus::NotDetermined | AuthorizationStatus::Unknown => PERMISSION_DEFAULT,
    }
}

#[tauri::command]
pub(crate) async fn macos_notification_permission_state() -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        let settings = mac_usernotifications::get_notification_settings()
            .await
            .map_err(|error| error.to_string())?;
        Ok(permission_label(settings.authorization_status))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(PERMISSION_UNSUPPORTED)
    }
}

#[tauri::command]
pub(crate) async fn request_macos_notification_permission() -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        mac_usernotifications::request_auth()
            .await
            .map(|granted| {
                if granted {
                    PERMISSION_GRANTED
                } else {
                    PERMISSION_DENIED
                }
            })
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(PERMISSION_UNSUPPORTED)
    }
}

#[tauri::command]
pub(crate) async fn send_macos_notification(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Notification::new()
            .title(title)
            .message(body)
            .default_sound()
            .send()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Err("native macOS notifications are unavailable on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use mac_usernotifications::AuthorizationStatus;

    #[cfg(target_os = "macos")]
    use super::permission_label;

    #[cfg(target_os = "macos")]
    #[test]
    fn permission_label_treats_provisional_authorization_as_granted() {
        assert_eq!(
            permission_label(AuthorizationStatus::Provisional),
            "granted"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn permission_label_preserves_not_determined_state() {
        assert_eq!(
            permission_label(AuthorizationStatus::NotDetermined),
            "default"
        );
    }
}
