use std::{net::SocketAddr, path::PathBuf};

use chrono::Duration;
use falcondeck_core::DEFAULT_RELAY_PORT;
use falcondeck_relay::{AppState, RetentionConfig, router};

fn env_or_default(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

/// `chrono::Duration::days` panics on out-of-range values, so fall back to
/// the (known in-range) default instead of aborting startup.
fn duration_days_or(days: i64, default_days: i64) -> Duration {
    Duration::try_days(days).unwrap_or_else(|| {
        tracing::warn!("duration of {days} days is out of range; using {default_days} days");
        Duration::days(default_days)
    })
}

fn duration_seconds_or(seconds: i64, default_seconds: i64) -> Duration {
    Duration::try_seconds(seconds).unwrap_or_else(|| {
        tracing::warn!(
            "duration of {seconds} seconds is out of range; using {default_seconds} seconds"
        );
        Duration::seconds(default_seconds)
    })
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
    // Clamp to the range start_pairing accepts, so an oversized env value
    // cannot make every default-TTL pairing request fail validation.
    let pairing_ttl_seconds = env_or_default("FALCONDECK_RELAY_PAIRING_TTL_SECONDS", "600")
        .parse::<i64>()
        .unwrap_or(600)
        .clamp(1, 86_400);
    let retention = RetentionConfig {
        update_retention: duration_days_or(
            env_or_default("FALCONDECK_RELAY_UPDATE_RETENTION_DAYS", "7")
                .parse::<i64>()
                .unwrap_or(7)
                .max(1),
            7,
        ),
        max_updates_per_session: env_or_default(
            "FALCONDECK_RELAY_MAX_UPDATES_PER_SESSION",
            "10000",
        )
        .parse::<usize>()
        .unwrap_or(10_000)
        .max(1),
        trusted_device_retention: duration_days_or(
            env_or_default("FALCONDECK_RELAY_TRUSTED_DEVICE_RETENTION_DAYS", "180")
                .parse::<i64>()
                .unwrap_or(180)
                .max(1),
            180,
        ),
        claimed_pairing_retention: duration_days_or(
            env_or_default("FALCONDECK_RELAY_CLAIMED_PAIRING_RETENTION_DAYS", "1")
                .parse::<i64>()
                .unwrap_or(1)
                .max(0),
            1,
        ),
        completed_action_retention: duration_days_or(
            env_or_default("FALCONDECK_RELAY_COMPLETED_ACTION_RETENTION_DAYS", "3")
                .parse::<i64>()
                .unwrap_or(3)
                .max(0),
            3,
        ),
    };

    let pairing_ttl = duration_seconds_or(pairing_ttl_seconds, 600);
    let state = if let Some(database_url) = database_url {
        AppState::load_postgres_with_retention(
            env!("CARGO_PKG_VERSION").to_string(),
            database_url,
            pairing_ttl,
            retention,
        )
        .await?
    } else {
        AppState::load_with_retention(
            env!("CARGO_PKG_VERSION").to_string(),
            PathBuf::from(state_path),
            pairing_ttl,
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
