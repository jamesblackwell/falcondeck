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
pub(crate) fn desktop_user_present() -> Option<bool> {
    falcondeck_daemon::desktop_presence::native_desktop_is_present()
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
pub(crate) async fn send_macos_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    review_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut notification = Notification::new().title(title).message(body).default_sound();
        // macOS replaces a request with the same identifier, so one review can
        // only ever occupy one notification.
        if let Some(review_id) = &review_id {
            notification = notification.id(&review_notification_id(review_id));
        }
        let handle = notification
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if let Some(review_id) = review_id {
            tauri::async_runtime::spawn(open_review_on_click(app, handle, review_id));
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body, review_id);
        Err("native macOS notifications are unavailable on this platform".to_string())
    }
}

#[cfg(target_os = "macos")]
fn review_notification_id(review_id: &str) -> String {
    format!("review-{review_id}")
}

/// The crate polls for a dismissal while it waits, so stop watching eventually.
/// Past this the notification still shows; a click just raises the app.
#[cfg(target_os = "macos")]
const CLICK_WATCH: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

#[cfg(target_os = "macos")]
async fn open_review_on_click(
    app: tauri::AppHandle,
    handle: mac_usernotifications::NotificationHandle,
    review_id: String,
) {
    use tauri::{Emitter, Manager};

    let Ok(Ok(response)) = tokio::time::timeout(CLICK_WATCH, handle.response()).await else {
        return;
    };
    // A dismissal or expiry carries a close reason. A real click does not.
    if response.close_reason.is_some() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("falcondeck://open-review", review_id);
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use mac_usernotifications::AuthorizationStatus;

    #[cfg(target_os = "macos")]
    use super::{permission_label, review_notification_id};

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
    fn each_review_has_one_notification_identity() {
        assert_eq!(review_notification_id("R-7"), review_notification_id("R-7"));
        assert_ne!(review_notification_id("R-7"), review_notification_id("R-8"));
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
