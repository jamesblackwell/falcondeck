//! Short-lived local history of dictation recordings.
//!
//! A transcript can come back wrong — the wrong model, a provider outage, a
//! mumbled sentence — and the audio is gone the moment it is pasted. Keeping
//! recordings for a few hours lets the writer retry with a different model
//! instead of saying the whole thing again. Nothing leaves this computer: the
//! audio stays in the same temporary directory the recorder already writes to
//! and is deleted once its retention window closes.

use std::{
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

pub const RECORDING_PREFIX: &str = "falcondeck-dictation-";
pub const RECORDING_EXTENSION: &str = "m4a";
const HISTORY_FILE: &str = "falcondeck-dictation-history.json";
/// Retention is the real bound; this only stops a runaway index file from an
/// unusually chatty day.
const MAX_ENTRIES: usize = 200;
/// Recordings are 32 kbps mono AAC, so a second of speech is about 4 kB. The
/// duration is only ever shown as a rough "how long was that" label.
const BYTES_PER_SECOND: f64 = 4_000.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationHistoryEntry {
    /// The recording's file stem, which the native recorder makes unique.
    pub id: String,
    pub path: String,
    pub recorded_at_ms: u64,
    pub duration_seconds: f64,
    pub bytes: u64,
    /// "system" or "open_router" — which engine produced this transcript.
    pub provider: String,
    pub model: Option<String>,
    pub text: Option<String>,
    pub error: Option<String>,
    /// False once the audio itself is gone (discarded, or cleared by macOS),
    /// which is what tells the UI a retry is no longer possible.
    #[serde(default)]
    pub audio_available: bool,
}

static ENTRIES: LazyLock<Mutex<Option<Vec<DictationHistoryEntry>>>> =
    LazyLock::new(|| Mutex::new(None));

fn index_path(temp_dir: &Path) -> PathBuf {
    temp_dir.join(HISTORY_FILE)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn file_recorded_at_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or_else(now_ms)
}

/// A recording this module is allowed to delete. The index is only ever
/// written by us, but it lives in a world-writable temporary directory, so
/// every path is re-checked before it reaches `remove_file`.
fn owns_recording(temp_dir: &Path, path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    path.parent() == Some(temp_dir)
        && name.starts_with(RECORDING_PREFIX)
        && path.extension().and_then(|value| value.to_str()) == Some(RECORDING_EXTENSION)
}

fn remove_recording(temp_dir: &Path, path: &Path) {
    if owns_recording(temp_dir, path) {
        let _ = std::fs::remove_file(path);
    }
}

fn load(temp_dir: &Path) -> Vec<DictationHistoryEntry> {
    std::fs::read(index_path(temp_dir))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Vec<DictationHistoryEntry>>(&raw).ok())
        .unwrap_or_default()
}

fn save(temp_dir: &Path, entries: &[DictationHistoryEntry]) {
    let path = index_path(temp_dir);
    match serde_json::to_vec(entries) {
        Ok(raw) => {
            let _ = std::fs::write(path, raw);
        }
        Err(_) => {
            // Losing the index only costs history, never audio; the recordings
            // are still pruned by the next successful write.
        }
    }
}

/// Drops entries past their retention window, deleting their audio with them,
/// and refreshes what is still on disk. `retention_hours` of zero keeps
/// nothing at all.
fn prune_entries(temp_dir: &Path, entries: &mut Vec<DictationHistoryEntry>, retention_hours: u32) {
    let cutoff = now_ms().saturating_sub(u64::from(retention_hours) * 60 * 60 * 1000);
    entries.retain_mut(|entry| {
        let path = PathBuf::from(&entry.path);
        if retention_hours == 0 || entry.recorded_at_ms < cutoff {
            remove_recording(temp_dir, &path);
            return false;
        }
        entry.audio_available = path.is_file();
        true
    });
    if entries.len() > MAX_ENTRIES {
        let overflow = entries.len() - MAX_ENTRIES;
        for entry in entries.drain(..overflow) {
            remove_recording(temp_dir, Path::new(&entry.path));
        }
    }
}

fn lock() -> std::sync::MutexGuard<'static, Option<Vec<DictationHistoryEntry>>> {
    match ENTRIES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn with_entries<T>(
    temp_dir: &Path,
    retention_hours: u32,
    action: impl FnOnce(&mut Vec<DictationHistoryEntry>) -> T,
) -> T {
    let mut guard = lock();
    let entries = guard.get_or_insert_with(|| load(temp_dir));
    prune_entries(temp_dir, entries, retention_hours);
    let result = action(entries);
    prune_entries(temp_dir, entries, retention_hours);
    save(temp_dir, entries);
    result
}

/// Files a finished recording. Returns false when history is switched off (or
/// the recording is not one of ours), which tells the caller the audio is its
/// own to delete.
pub fn record(
    temp_dir: &Path,
    path: &Path,
    provider: &str,
    model: Option<String>,
    text: Option<String>,
    error: Option<String>,
    retention_hours: u32,
) -> bool {
    if retention_hours == 0 || !owns_recording(temp_dir, path) || !path.is_file() {
        return false;
    }
    let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    let bytes = std::fs::metadata(path)
        .map(|value| value.len())
        .unwrap_or(0);
    let entry = DictationHistoryEntry {
        id: id.to_string(),
        path: path.to_string_lossy().into_owned(),
        recorded_at_ms: file_recorded_at_ms(path),
        duration_seconds: bytes as f64 / BYTES_PER_SECOND,
        bytes,
        provider: provider.to_string(),
        model,
        text,
        error,
        audio_available: true,
    };
    with_entries(temp_dir, retention_hours, |entries| {
        // A retry re-files the same recording; keep one row per recording so
        // the list reads as "what I said", not "what I attempted".
        match entries.iter_mut().find(|existing| existing.id == entry.id) {
            Some(existing) => {
                existing.provider = entry.provider;
                existing.model = entry.model;
                existing.text = entry.text;
                existing.error = entry.error;
                existing.bytes = entry.bytes;
                existing.duration_seconds = entry.duration_seconds;
                existing.audio_available = true;
            }
            None => entries.push(entry),
        }
    });
    true
}

/// Records the outcome of a retry against an entry that already exists.
pub fn record_retry(
    temp_dir: &Path,
    id: &str,
    model: Option<String>,
    text: Option<String>,
    error: Option<String>,
    retention_hours: u32,
) -> Option<DictationHistoryEntry> {
    with_entries(temp_dir, retention_hours, |entries| {
        let entry = entries.iter_mut().find(|entry| entry.id == id)?;
        entry.model = model;
        entry.text = text;
        entry.error = error;
        Some(entry.clone())
    })
}

/// Newest first, which is the order a writer looks for a recording in.
pub fn entries(temp_dir: &Path, retention_hours: u32) -> Vec<DictationHistoryEntry> {
    with_entries(temp_dir, retention_hours, |entries| {
        let mut visible = entries.clone();
        visible.sort_by(|left, right| right.recorded_at_ms.cmp(&left.recorded_at_ms));
        visible
    })
}

pub fn find(temp_dir: &Path, retention_hours: u32, id: &str) -> Option<DictationHistoryEntry> {
    with_entries(temp_dir, retention_hours, |entries| {
        entries.iter().find(|entry| entry.id == id).cloned()
    })
}

pub fn delete(temp_dir: &Path, retention_hours: u32, id: &str) -> bool {
    with_entries(temp_dir, retention_hours, |entries| {
        let Some(index) = entries.iter().position(|entry| entry.id == id) else {
            return false;
        };
        let entry = entries.remove(index);
        remove_recording(temp_dir, Path::new(&entry.path));
        true
    })
}

pub fn clear(temp_dir: &Path) -> usize {
    let mut guard = lock();
    let entries = guard.get_or_insert_with(|| load(temp_dir));
    let removed = std::mem::take(entries);
    for entry in &removed {
        remove_recording(temp_dir, Path::new(&entry.path));
    }
    save(temp_dir, entries);
    removed.len()
}

/// Deletes recordings on disk that the index does not know about and that are
/// older than the retention window. A crash between writing audio and filing
/// it, or a lost index file, must not leave recordings behind forever — that
/// would break the promise the settings screen makes. The window doubles as
/// the safety margin: an in-flight recording keeps a fresh mtime while it is
/// being written, so a >=1 hour cutoff can never touch it.
fn sweep_orphans(temp_dir: &Path, entries: &[DictationHistoryEntry], retention_hours: u32) {
    if retention_hours == 0 {
        // With history off the native recorder owns deletion, and a failed
        // recording is deliberately retained for the overlay's Retry.
        return;
    }
    let cutoff = now_ms().saturating_sub(u64::from(retention_hours) * 60 * 60 * 1000);
    let known: std::collections::HashSet<&str> =
        entries.iter().map(|entry| entry.id.as_str()).collect();
    let Ok(items) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for item in items.flatten() {
        let path = item.path();
        if !owns_recording(temp_dir, &path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if known.contains(stem) {
            continue;
        }
        // file_recorded_at_ms falls back to "now" when the mtime is
        // unreadable, which keeps an unreadable file rather than deleting it.
        if file_recorded_at_ms(&path) < cutoff {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Applies the current retention window. Called whenever settings change and
/// whenever a recording finishes, so audio never outlives its window just
/// because nobody opened the history list.
pub fn prune(temp_dir: &Path, retention_hours: u32) {
    with_entries(temp_dir, retention_hours, |entries| {
        sweep_orphans(temp_dir, entries, retention_hours);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_GUARD: Mutex<()> = Mutex::new(());

    /// Each test needs its own directory *and* its own view of the cached
    /// index, which is process-global — so they take turns.
    fn fresh_dir(name: &str) -> (PathBuf, std::sync::MutexGuard<'static, ()>) {
        let guard = match TEST_GUARD.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let dir = std::env::temp_dir().join(format!("fd-history-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test directory");
        *lock() = None;
        (dir, guard)
    }

    fn write_recording(dir: &Path, id: &str, bytes: usize) -> PathBuf {
        let path = dir.join(format!("{RECORDING_PREFIX}{id}.{RECORDING_EXTENSION}"));
        std::fs::write(&path, vec![0u8; bytes]).expect("recording");
        path
    }

    #[test]
    fn recording_is_filed_and_listed_newest_first() {
        let (dir, _guard) = fresh_dir("listing");
        let first = write_recording(&dir, "one", 4_000);
        let second = write_recording(&dir, "two", 8_000);
        assert!(record(
            &dir,
            &first,
            "open_router",
            Some("model-a".into()),
            Some("first".into()),
            None,
            6
        ));
        assert!(record(
            &dir,
            &second,
            "system",
            None,
            Some("second".into()),
            None,
            6
        ));

        let listed = entries(&dir, 6);
        assert_eq!(listed.len(), 2);
        assert!(listed[0].recorded_at_ms >= listed[1].recorded_at_ms);
        let one = listed
            .iter()
            .find(|entry| entry.text.as_deref() == Some("first"));
        let one = one.expect("first entry");
        assert_eq!(one.duration_seconds, 1.0);
        assert!(one.audio_available);
    }

    #[test]
    fn retention_of_zero_keeps_nothing_and_leaves_deletion_to_the_caller() {
        let (dir, _guard) = fresh_dir("disabled");
        let path = write_recording(&dir, "one", 1_000);
        assert!(!record(
            &dir,
            &path,
            "system",
            None,
            Some("hi".into()),
            None,
            0
        ));
        // The caller still owns the file when history declines it.
        assert!(path.is_file());
        assert!(entries(&dir, 0).is_empty());
    }

    #[test]
    fn expired_recordings_are_deleted_with_their_entry() {
        let (dir, _guard) = fresh_dir("expiry");
        let path = write_recording(&dir, "one", 1_000);
        record(&dir, &path, "system", None, Some("hi".into()), None, 6);
        // Age the entry past a one-hour window.
        with_entries(&dir, 6, |entries| {
            entries[0].recorded_at_ms -= 2 * 60 * 60 * 1000;
        });
        assert!(entries(&dir, 1).is_empty());
        assert!(!path.is_file(), "expired audio should be deleted");
    }

    #[test]
    fn a_retry_updates_the_existing_row_instead_of_adding_one() {
        let (dir, _guard) = fresh_dir("retry");
        let path = write_recording(&dir, "one", 1_000);
        record(
            &dir,
            &path,
            "open_router",
            Some("model-a".into()),
            None,
            Some("provider outage".into()),
            6,
        );
        let updated = record_retry(
            &dir,
            "falcondeck-dictation-one",
            Some("model-b".into()),
            Some("second time lucky".into()),
            None,
            6,
        )
        .expect("entry");
        assert_eq!(updated.text.as_deref(), Some("second time lucky"));
        assert_eq!(updated.error, None);
        assert_eq!(entries(&dir, 6).len(), 1);
    }

    #[test]
    fn deleting_an_entry_removes_its_audio() {
        let (dir, _guard) = fresh_dir("delete");
        let path = write_recording(&dir, "one", 1_000);
        record(&dir, &path, "system", None, Some("hi".into()), None, 6);
        assert!(delete(&dir, 6, "falcondeck-dictation-one"));
        assert!(!path.is_file());
        assert!(entries(&dir, 6).is_empty());
        assert!(!delete(&dir, 6, "falcondeck-dictation-one"));
    }

    #[test]
    fn clearing_removes_every_recording() {
        let (dir, _guard) = fresh_dir("clear");
        let first = write_recording(&dir, "one", 1_000);
        let second = write_recording(&dir, "two", 1_000);
        record(&dir, &first, "system", None, Some("a".into()), None, 6);
        record(&dir, &second, "system", None, Some("b".into()), None, 6);
        assert_eq!(clear(&dir), 2);
        assert!(!first.is_file() && !second.is_file());
        assert!(entries(&dir, 6).is_empty());
    }

    #[test]
    fn entries_report_audio_that_disappeared_underneath_them() {
        let (dir, _guard) = fresh_dir("missing");
        let path = write_recording(&dir, "one", 1_000);
        record(&dir, &path, "system", None, Some("hi".into()), None, 6);
        std::fs::remove_file(&path).expect("remove");
        let listed = entries(&dir, 6);
        assert_eq!(listed.len(), 1, "the transcript is still worth keeping");
        assert!(!listed[0].audio_available);
    }

    #[test]
    fn prune_sweeps_recordings_the_index_lost_track_of() {
        let (dir, _guard) = fresh_dir("orphans");
        let orphan = write_recording(&dir, "orphan", 1_000);
        let tracked = write_recording(&dir, "tracked", 1_000);
        record(&dir, &tracked, "system", None, Some("hi".into()), None, 6);
        // Age both files past a one-hour window.
        let old = SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        for path in [&orphan, &tracked] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .and_then(|file| file.set_modified(old))
                .expect("set mtime");
        }
        // A one-hour window: the two-hour-old orphan is past it, while the
        // tracked entry (filed minutes ago by the index's clock) is not.
        prune(&dir, 1);
        assert!(!orphan.is_file(), "expired orphan should be deleted");
        assert!(
            tracked.is_file(),
            "indexed recording must survive the sweep"
        );
    }

    #[test]
    fn prune_leaves_fresh_orphans_for_the_recorder() {
        let (dir, _guard) = fresh_dir("fresh-orphan");
        // A file being written right now — an in-flight recording.
        let in_flight = write_recording(&dir, "in-flight", 1_000);
        prune(&dir, 1);
        assert!(in_flight.is_file());
        // With history off the sweep never runs at all.
        let untouched = write_recording(&dir, "retained-failure", 1_000);
        let old = SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&untouched)
            .and_then(|file| file.set_modified(old))
            .expect("set mtime");
        prune(&dir, 0);
        assert!(untouched.is_file());
    }

    #[test]
    fn foreign_files_are_never_recorded_or_deleted() {
        let (dir, _guard) = fresh_dir("foreign");
        let outsider = dir.join("someone-elses-notes.m4a");
        std::fs::write(&outsider, b"not ours").expect("write");
        assert!(!record(&dir, &outsider, "system", None, None, None, 6));
        remove_recording(&dir, &outsider);
        assert!(outsider.is_file());
        // Nor from another directory, even with our own naming.
        let elsewhere = std::env::temp_dir().join(format!("{RECORDING_PREFIX}elsewhere.m4a"));
        std::fs::write(&elsewhere, b"x").expect("write");
        assert!(!record(&dir, &elsewhere, "system", None, None, None, 6));
        assert!(elsewhere.is_file());
        let _ = std::fs::remove_file(elsewhere);
    }
}
