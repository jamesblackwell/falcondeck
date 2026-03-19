use std::{net::SocketAddr, path::PathBuf};

use chrono::Duration;
use falcondeck_core::DEFAULT_RELAY_PORT;
use falcondeck_relay::{AppState, RetentionConfig, router};

fn env_or_default(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "falcondeck_relay=info,tower_http=info".to_string()),
        )
        .try_init()
        .ok();

    let bind_addr = env_or_default(
        "FALCONDECK_RELAY_BIND",
        &format!("0.0.0.0:{DEFAULT_RELAY_PORT}"),
    );
    let state_path = env_or_default(
        "FALCONDECK_RELAY_STATE_PATH",
        "./var/falcondeck-relay/state.json",
    );
    let database_url = std::env::var("FALCONDECK_RELAY_DATABASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let pairing_ttl_seconds = env_or_default("FALCONDECK_RELAY_PAIRING_TTL_SECONDS", "600")
        .parse::<i64>()
        .unwrap_or(600);
    let retention = RetentionConfig {
        update_retention: Duration::days(
            env_or_default("FALCONDECK_RELAY_UPDATE_RETENTION_DAYS", "7")
                .parse::<i64>()
                .unwrap_or(7)
                .max(1),
        ),
        max_updates_per_session: env_or_default(
            "FALCONDECK_RELAY_MAX_UPDATES_PER_SESSION",
            "10000",
        )
        .parse::<usize>()
        .unwrap_or(10_000)
        .max(1),
        trusted_device_retention: Duration::days(
            env_or_default("FALCONDECK_RELAY_TRUSTED_DEVICE_RETENTION_DAYS", "180")
                .parse::<i64>()
                .unwrap_or(180)
                .max(1),
        ),
        claimed_pairing_retention: Duration::days(
            env_or_default("FALCONDECK_RELAY_CLAIMED_PAIRING_RETENTION_DAYS", "1")
                .parse::<i64>()
                .unwrap_or(1)
                .max(0),
        ),
        completed_action_retention: Duration::days(
            env_or_default("FALCONDECK_RELAY_COMPLETED_ACTION_RETENTION_DAYS", "3")
                .parse::<i64>()
                .unwrap_or(3)
                .max(0),
        ),
    };

    let state = if let Some(database_url) = database_url {
        AppState::load_postgres_with_retention(
            env!("CARGO_PKG_VERSION").to_string(),
            database_url,
            Duration::seconds(pairing_ttl_seconds.max(1)),
            retention,
        )
        .await?
    } else {
        AppState::load_with_retention(
            env!("CARGO_PKG_VERSION").to_string(),
            PathBuf::from(state_path),
            Duration::seconds(pairing_ttl_seconds.max(1)),
            retention,
        )
        .await?
    };

    let listener = tokio::net::TcpListener::bind(bind_addr.parse::<SocketAddr>()?).await?;
    let local_addr = listener.local_addr()?;
    tracing::info!("falcondeck-relay listening on {local_addr}");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
