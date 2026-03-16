use std::sync::Arc;

use falcondeck_daemon::{spawn_embedded, DaemonConfig, EmbeddedDaemonHandle};
use serde::Serialize;
use tauri::{async_runtime::Mutex, Manager};

#[derive(Default)]
struct DesktopState {
    daemon: Mutex<Option<Arc<EmbeddedDaemonHandle>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonConnection {
    base_url: String,
}

#[tauri::command]
async fn ensure_daemon_running(
    state: tauri::State<'_, DesktopState>,
) -> Result<DaemonConnection, String> {
    let mut daemon = state.daemon.lock().await;
    if let Some(handle) = daemon.as_ref() {
        return Ok(DaemonConnection {
            base_url: handle.base_url(),
        });
    }

    let handle = spawn_embedded(DaemonConfig {
        bind_addr: "127.0.0.1:0"
            .parse::<std::net::SocketAddr>()
            .map_err(|error| error.to_string())?,
        ..DaemonConfig::default()
    })
    .await
    .map_err(|error| error.to_string())?;
    let handle = Arc::new(handle);
    let base_url = handle.base_url();
    *daemon = Some(handle);

    Ok(DaemonConnection { base_url })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<DesktopState>();
                let _ = ensure_daemon_running(state).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ensure_daemon_running])
        .run(tauri::generate_context!())
        .expect("failed to run FalconDeck desktop");
}
