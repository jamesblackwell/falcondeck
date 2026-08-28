//! Cached company logos for the Plugins directory.
//!
//! Logos are fetched from logo.dev (or a favicon fallback) once, stored under
//! `~/.falcondeck/cache/logos`, and rechecked about once a month. The first
//! fetch timestamp is shifted backwards by a domain-stable 0–14 day offset so
//! a full catalog does not expire on the same day.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MONTH_SECS: u64 = 30 * 24 * 60 * 60;
const STAGGER_SECS: u64 = 14 * 24 * 60 * 60;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LogoIndex {
    entries: HashMap<String, LogoMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LogoMeta {
    fetched_at: u64,
    content_type: String,
    /// True when the last fetch found no usable image.
    #[serde(default)]
    missing: bool,
}

fn test_cache_dir() -> &'static Mutex<Option<PathBuf>> {
    static PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    PATH.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
pub fn set_cache_dir_for_test(path: PathBuf) {
    *test_cache_dir().lock().unwrap_or_else(|p| p.into_inner()) = Some(path);
}

#[cfg(test)]
pub fn lock_cache_for_test() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

fn cache_dir() -> PathBuf {
    if let Some(path) = test_cache_dir()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return path;
    }
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".falcondeck").join("cache").join("logos")
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn image_path(dir: &Path, domain: &str) -> PathBuf {
    dir.join(format!("{domain}.bin"))
}

/// Hostnames only: labels, dots, hyphens. Rejects paths and `..`.
pub fn sanitize_domain(raw: &str) -> Result<String, String> {
    let domain = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty() || domain.len() > 253 {
        return Err("invalid logo domain".to_string());
    }
    if domain.starts_with('.') || domain.ends_with('.') || domain.contains("..") {
        return Err("invalid logo domain".to_string());
    }
    if !domain
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("invalid logo domain".to_string());
    }
    if !domain.contains('.') {
        return Err("invalid logo domain".to_string());
    }
    Ok(domain)
}

/// Domain-stable 0..14d offset so first monthly rechecks are spread out.
pub fn stagger_secs(domain: &str) -> u64 {
    let digest = Sha256::digest(domain.as_bytes());
    let n = u64::from_le_bytes(digest[..8].try_into().unwrap_or([0; 8]));
    n % STAGGER_SECS
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn is_fresh(domain: &str, fetched_at: u64, now: u64) -> bool {
    let ttl = MONTH_SECS.saturating_sub(stagger_secs(domain));
    now.saturating_sub(fetched_at) < ttl
}

fn recorded_fetched_at(domain: &str, now: u64) -> u64 {
    now.saturating_sub(stagger_secs(domain))
}

fn read_index(dir: &Path) -> LogoIndex {
    let raw = match std::fs::read_to_string(index_path(dir)) {
        Ok(raw) => raw,
        Err(_) => return LogoIndex::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_index(dir: &Path, index: &LogoIndex) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("failed to create logo cache dir: {error}"))?;
    let body = serde_json::to_string_pretty(index)
        .map_err(|error| format!("failed to encode logo index: {error}"))?;
    let tmp = dir.join(format!("index.tmp.{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, body).map_err(|error| format!("failed to write logo index: {error}"))?;
    std::fs::rename(&tmp, index_path(dir))
        .map_err(|error| format!("failed to replace logo index: {error}"))
}

fn write_image(dir: &Path, domain: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("failed to create logo cache dir: {error}"))?;
    let path = image_path(dir, domain);
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&tmp)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|error| format!("failed to write logo: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("failed to replace logo: {error}"))
}

fn logo_dev_token() -> Option<String> {
    std::env::var("FALCONDECK_LOGO_DEV_TOKEN")
        .ok()
        .or_else(|| std::env::var("LOGO_DEV_PUBLISHABLE_KEY").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("pk_"))
}

async fn download(url: &str) -> Result<(Vec<u8>, String), String> {
    let response = reqwest::Client::new()
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .header("User-Agent", "FalconDeck/0.1")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("logo fetch {}", response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .trim()
        .to_string();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("logo payload unusable".to_string());
    }
    if !content_type.starts_with("image/") {
        return Err(format!("unexpected logo type {content_type}"));
    }
    Ok((bytes.to_vec(), content_type))
}

async fn fetch_remote(domain: &str) -> Result<(Vec<u8>, String), String> {
    if let Some(token) = logo_dev_token() {
        let url =
            format!("https://img.logo.dev/{domain}?token={token}&size=128&format=png&theme=dark");
        if let Ok(hit) = download(&url).await {
            return Ok(hit);
        }
    }
    let fallback = format!("https://www.google.com/s2/favicons?domain={domain}&sz=128");
    download(&fallback).await
}

/// Cached logo bytes and content type, or an error if none is available.
pub async fn load(raw_domain: &str) -> Result<(Vec<u8>, String), String> {
    let domain = sanitize_domain(raw_domain)?;
    let dir = cache_dir();
    let now = now_unix();
    let mut index = read_index(&dir);
    if let Some(meta) = index.entries.get(&domain)
        && is_fresh(&domain, meta.fetched_at, now)
    {
        if meta.missing {
            return Err("no logo cached".to_string());
        }
        if let Ok(bytes) = std::fs::read(image_path(&dir, &domain))
            && !bytes.is_empty()
        {
            return Ok((bytes, meta.content_type.clone()));
        }
    }

    match fetch_remote(&domain).await {
        Ok((bytes, content_type)) => {
            write_image(&dir, &domain, &bytes)?;
            index.entries.insert(
                domain.clone(),
                LogoMeta {
                    fetched_at: recorded_fetched_at(&domain, now),
                    content_type: content_type.clone(),
                    missing: false,
                },
            );
            let _ = write_index(&dir, &index);
            Ok((bytes, content_type))
        }
        Err(error) => {
            index.entries.insert(
                domain.clone(),
                LogoMeta {
                    fetched_at: recorded_fetched_at(&domain, now),
                    content_type: "application/octet-stream".into(),
                    missing: true,
                },
            );
            let _ = write_index(&dir, &index);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_paths_and_odd_hosts() {
        assert!(sanitize_domain("notion.so").is_ok());
        assert!(sanitize_domain("GitHub.COM.").is_ok());
        assert_eq!(sanitize_domain("GitHub.COM.").unwrap(), "github.com");
        assert!(sanitize_domain("../etc/passwd").is_err());
        assert!(sanitize_domain("notion.so/logo").is_err());
        assert!(sanitize_domain("localhost").is_err());
        assert!(sanitize_domain("").is_err());
    }

    #[test]
    fn stagger_is_stable_and_bounded() {
        let a = stagger_secs("notion.so");
        let b = stagger_secs("notion.so");
        let c = stagger_secs("linear.app");
        assert_eq!(a, b);
        assert!(a < STAGGER_SECS);
        assert_ne!(a, c);
    }

    #[test]
    fn ttl_is_between_sixteen_and_thirty_days() {
        let ttl = MONTH_SECS.saturating_sub(stagger_secs("stripe.com"));
        assert!(ttl >= MONTH_SECS - STAGGER_SECS);
        assert!(ttl <= MONTH_SECS);
    }

    #[test]
    fn fresh_cache_is_served_without_network() {
        let _lock = lock_cache_for_test();
        let dir = tempfile::tempdir().unwrap();
        set_cache_dir_for_test(dir.path().to_path_buf());
        let domain = "cached.example.com";
        write_image(dir.path(), domain, b"png-bytes").unwrap();
        let mut index = LogoIndex::default();
        index.entries.insert(
            domain.to_string(),
            LogoMeta {
                fetched_at: now_unix(),
                content_type: "image/png".into(),
                missing: false,
            },
        );
        write_index(dir.path(), &index).unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (bytes, content_type) = runtime.block_on(load(domain)).unwrap();
        assert_eq!(bytes, b"png-bytes");
        assert_eq!(content_type, "image/png");
    }
}
