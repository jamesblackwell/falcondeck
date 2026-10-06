//! Metadata for successful bounded scans that found no searchable user text.

use std::{
    collections::HashMap,
    fs::Metadata,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

// Bump when changing which records/windows qualify as an empty scan.
const EMPTY_SCAN_VERSION: u32 = 1;
const MAX_EMPTY_FILES: usize = 16_384;
const MAX_EMPTY_METADATA_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SourceFingerprint {
    pub size: u64,
    // Sign, seconds and nanoseconds also represent pre-epoch modification times.
    modified: Option<(bool, u64, u32)>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl SourceFingerprint {
    pub fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok().map(|time| {
                let (before_epoch, duration) = match time.duration_since(UNIX_EPOCH) {
                    Ok(duration) => (false, duration),
                    Err(error) => (true, error.duration()),
                };
                (before_epoch, duration.as_secs(), duration.subsec_nanos())
            }),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct EmptyFileCache {
    version: u32,
    files: HashMap<PathBuf, SourceFingerprint>,
    #[serde(skip)]
    retained_bytes: usize,
}

impl EmptyFileCache {
    pub fn new() -> Self {
        Self {
            version: EMPTY_SCAN_VERSION,
            ..Self::default()
        }
    }

    pub fn is_current(&self, path: &Path, fingerprint: SourceFingerprint) -> bool {
        self.version == EMPTY_SCAN_VERSION
            && fingerprint.modified.is_some()
            && self.files.get(path) == Some(&fingerprint)
    }

    pub fn insert(&mut self, path: PathBuf, fingerprint: SourceFingerprint) {
        if fingerprint.modified.is_none() || self.files.contains_key(&path) {
            return;
        }
        // Estimate owned path and hash-entry storage; no transcript text is held.
        let bytes = path.capacity()
            + std::mem::size_of::<PathBuf>()
            + std::mem::size_of::<SourceFingerprint>()
            + 2 * std::mem::size_of::<usize>();
        if self.files.len() >= MAX_EMPTY_FILES
            || bytes > MAX_EMPTY_METADATA_BYTES.saturating_sub(self.retained_bytes)
        {
            return;
        }
        self.retained_bytes += bytes;
        self.files.insert(path, fingerprint);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.files.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint() -> SourceFingerprint {
        SourceFingerprint::from_metadata(&tempfile::tempfile().unwrap().metadata().unwrap())
    }

    #[test]
    fn cache_bounds_entry_count_and_owned_metadata() {
        let fingerprint = fingerprint();
        let mut count_limited = EmptyFileCache::new();
        for number in 0..MAX_EMPTY_FILES + 1 {
            count_limited.insert(PathBuf::from(format!("/short/{number}.jsonl")), fingerprint);
        }
        assert_eq!(count_limited.len(), MAX_EMPTY_FILES);
        assert!(count_limited.retained_bytes <= MAX_EMPTY_METADATA_BYTES);

        let mut bytes_limited = EmptyFileCache::new();
        for number in 0..12 {
            bytes_limited.insert(
                PathBuf::from(format!("/{}-{number}", "x".repeat(1024 * 1024))),
                fingerprint,
            );
        }
        assert!(bytes_limited.len() < 12);
        assert!(bytes_limited.retained_bytes <= MAX_EMPTY_METADATA_BYTES);
        let previous_len = bytes_limited.len();
        bytes_limited.insert(
            PathBuf::from("x".repeat(MAX_EMPTY_METADATA_BYTES + 1)),
            fingerprint,
        );
        assert_eq!(bytes_limited.len(), previous_len);
    }

    #[test]
    fn unknown_policy_and_unavailable_mtime_are_not_reused() {
        let path = PathBuf::from("/session.jsonl");
        let fingerprint = fingerprint();
        let mut cache = EmptyFileCache::new();
        cache.insert(path.clone(), fingerprint);
        assert!(cache.is_current(&path, fingerprint));
        cache.version += 1;
        assert!(!cache.is_current(&path, fingerprint));
        let no_mtime = SourceFingerprint {
            modified: None,
            ..fingerprint
        };
        let mut cache = EmptyFileCache::new();
        cache.insert(path.clone(), no_mtime);
        assert_eq!(cache.len(), 0);
        assert!(!cache.is_current(&path, no_mtime));
    }
}
