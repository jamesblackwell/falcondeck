use std::{ffi::OsString, sync::OnceLock};

use tokio::{
    sync::Mutex,
    time::{Duration, Instant},
};

use super::{AccountSummary, read_auth_status};

// Auth is account scoped, so restored folders can share a short startup probe.
// Explicit metadata refresh always probes again (including after sign-in).
const AUTH_CACHE_TTL: Duration = Duration::from_secs(30);

struct Entry {
    executable: String,
    config_dir: Option<OsString>,
    taken_at: Instant,
    account: AccountSummary,
}

#[derive(Default)]
struct AuthCache(Mutex<Option<Entry>>);

impl AuthCache {
    async fn read(&self, executable: &str, refresh: bool) -> AccountSummary {
        let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR");
        // Holding the lock through the probe also coalesces concurrent connects.
        let mut cache = self.0.lock().await;
        if !refresh
            && let Some(entry) = cache.as_ref()
            && entry.executable == executable
            && entry.config_dir == config_dir
            && entry.taken_at.elapsed() < AUTH_CACHE_TTL
        {
            return entry.account.clone();
        }
        let account = read_auth_status(executable).await;
        *cache = Some(Entry {
            executable: executable.to_string(),
            config_dir,
            taken_at: Instant::now(),
            account: account.clone(),
        });
        account
    }
}

fn cache() -> &'static AuthCache {
    static CACHE: OnceLock<AuthCache> = OnceLock::new();
    CACHE.get_or_init(AuthCache::default)
}

pub(super) async fn startup_auth_status(executable: &str) -> AccountSummary {
    cache().read(executable, false).await
}

pub(super) async fn refresh_auth_status(executable: &str) -> AccountSummary {
    cache().read(executable, true).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::AccountStatus;
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn startup_coalesces_probes_but_refresh_and_expiry_recheck_auth() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("claude");
        let calls = temp.path().join("calls");
        let logged_in = temp.path().join("logged-in");
        std::fs::write(&executable, format!(
            "#!/bin/sh\necho probe >> '{}'\nif [ -e '{}' ]; then echo '{{\"authenticated\":true}}'; else echo '{{\"authenticated\":false}}'; fi\n",
            calls.display(), logged_in.display(),
        )).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executable = executable.to_str().unwrap();
        let cache = AuthCache::default();
        let (first, second, third) = tokio::join!(
            cache.read(executable, false),
            cache.read(executable, false),
            cache.read(executable, false),
        );
        assert_eq!(first.status, AccountStatus::NeedsAuth);
        assert_eq!(second.status, first.status);
        assert_eq!(third.status, first.status);
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
        std::fs::write(&logged_in, "").unwrap();
        assert_eq!(
            cache.read(executable, true).await.status,
            AccountStatus::Ready
        );
        assert_eq!(
            cache.read(executable, false).await.status,
            AccountStatus::Ready
        );
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 2);
        cache.0.lock().await.as_mut().unwrap().taken_at = Instant::now() - AUTH_CACHE_TTL;
        cache.read(executable, false).await;
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 3);
        assert_eq!(
            cache.read("/missing-other-claude", false).await.status,
            AccountStatus::Unknown
        );
    }
}
