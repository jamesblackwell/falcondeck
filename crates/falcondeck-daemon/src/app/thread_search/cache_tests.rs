use super::*;

fn reset_source_reads() {
    SOURCE_READS.with(|reads| reads.set((0, 0)));
    SOURCE_READ_HOOK.with(|hook| hook.borrow_mut().take());
}

fn source_reads() -> (usize, u64) {
    SOURCE_READS.with(std::cell::Cell::get)
}

#[test]
fn unchanged_files_without_user_excerpts_are_not_reread_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("no-user-messages.jsonl");
    std::fs::write(
        &path,
        serde_json::json!({
            "type": "assistant",
            "message": {"content": "x".repeat(1024 * 1024)},
        })
        .to_string(),
    )
    .unwrap();
    let roots = vec![directory.path().to_path_buf()];
    reset_source_reads();
    let first = rescan_roots(&roots, &ThreadSearchIndex::default());
    assert!(first.sessions.is_empty());
    let cold_reads = source_reads();
    assert_eq!(cold_reads.0, 1);
    assert!(cold_reads.1 > 1024 * 1024);

    let persisted = serde_json::to_string(&first).unwrap();
    assert!(
        persisted.len() < 1024,
        "only file metadata should be persisted"
    );
    let restored: ThreadSearchIndex = serde_json::from_str(&persisted).unwrap();
    reset_source_reads();
    let second = rescan_roots(&roots, &restored);
    assert!(second.sessions.is_empty());
    assert_eq!(
        source_reads(),
        (0, 0),
        "unchanged negative results must survive restart"
    );
}

fn write_record(path: &Path, kind: &str, text: &str) {
    std::fs::write(
        path,
        format!("{}\n", serde_json::json!({"type":kind,"content":text})),
    )
    .unwrap();
}

fn cold_empty(root: &Path, path: &Path) -> ThreadSearchIndex {
    write_record(path, "assistant", "hidden");
    let index = rescan_roots(&[root.to_path_buf()], &ThreadSearchIndex::default());
    assert!(index.sessions.is_empty());
    assert_eq!(index.empty_files.len(), 1);
    index
}

#[test]
fn appended_prompt_invalidates_persisted_empty_result() {
    use std::io::Write;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let first = cold_empty(directory.path(), &path);
    let first: ThreadSearchIndex =
        serde_json::from_str(&serde_json::to_string(&first).unwrap()).unwrap();
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap(),
        "{}",
        serde_json::json!({"type":"user","content":"fix login"})
    )
    .unwrap();
    reset_source_reads();
    let second = rescan_roots(&[directory.path().to_path_buf()], &first);
    assert_eq!(source_reads().0, 1);
    assert_eq!(second.empty_files.len(), 0);
    assert_eq!(second.sessions["session"].opening, ["fix login"]);
    assert_eq!(
        search(
            &second,
            &[SearchableThread {
                thread_id: "thread".into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
            }],
            "login",
            10
        )
        .len(),
        1
    );
}

#[test]
fn truncation_and_replacement_refresh_empty_results() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let first = cold_empty(directory.path(), &path);
    std::fs::write(&path, "").unwrap();
    let truncated = rescan_roots(&[directory.path().to_path_buf()], &first);
    assert_eq!(truncated.empty_files.len(), 0);
    let replacement = directory.path().join("replacement");
    write_record(&replacement, "user", "new request");
    std::fs::rename(replacement, &path).unwrap();
    let second = rescan_roots(&[directory.path().to_path_buf()], &first);
    assert_eq!(second.sessions["session"].opening, ["new request"]);
}

#[cfg(unix)]
#[test]
fn same_size_edits_preserving_mtime_and_atomic_replacements_invalidate() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    for replace in [false, true] {
        let first = cold_empty(directory.path(), &path);
        let before = std::fs::metadata(&path).unwrap();
        // Padding keeps byte length identical even though the envelope changed.
        let mut user = serde_json::json!({"type":"user","content":"fix bug"}).to_string();
        user.extend(std::iter::repeat_n(
            ' ',
            before.len() as usize - user.len() - 1,
        ));
        user.push('\n');
        let destination = if replace {
            directory.path().join("replacement")
        } else {
            path.clone()
        };
        std::fs::write(&destination, user).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&destination)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
        if replace {
            std::fs::rename(destination, &path).unwrap();
        }
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        reset_source_reads();
        let second = rescan_roots(&[directory.path().to_path_buf()], &first);
        assert_eq!(source_reads().0, 1);
        assert_eq!(second.sessions["session"].opening, ["fix bug"]);
    }
}

#[test]
fn root_changes_moves_and_deletions_prune_metadata() {
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    let path = first_root.path().join("same-id.jsonl");
    let first = cold_empty(first_root.path(), &path);
    let new_path = second_root.path().join("same-id.jsonl");
    write_record(&new_path, "user", "other root");
    let other = rescan_roots(&[second_root.path().to_path_buf()], &first);
    assert_eq!(other.empty_files.len(), 0);
    assert_eq!(other.sessions["same-id"].opening, ["other root"]);
    let moved_path = first_root.path().join("moved.jsonl");
    std::fs::rename(&path, &moved_path).unwrap();
    reset_source_reads();
    let moved = rescan_roots(&[first_root.path().to_path_buf()], &first);
    assert_eq!(source_reads().0, 1);
    assert_eq!(moved.empty_files.len(), 1);
    assert!(!moved.empty_files.is_current(
        &path,
        SourceFingerprint::from_metadata(&std::fs::metadata(&moved_path).unwrap())
    ));
    std::fs::remove_file(moved_path).unwrap();
    let deleted = rescan_roots(&[first_root.path().to_path_buf()], &moved);
    assert_eq!(deleted.empty_files.len(), 0);
}

#[test]
fn negative_entry_does_not_hide_another_file_with_same_session_id() {
    let directory = tempfile::tempdir().unwrap();
    let first_dir = directory.path().join("one");
    let second_dir = directory.path().join("two");
    std::fs::create_dir_all(&first_dir).unwrap();
    std::fs::create_dir_all(&second_dir).unwrap();
    let first = cold_empty(directory.path(), &first_dir.join("shared.jsonl"));
    write_record(&second_dir.join("shared.jsonl"), "user", "visible");
    let second = rescan_roots(&[directory.path().to_path_buf()], &first);
    assert_eq!(second.sessions["shared"].opening, ["visible"]);
    assert_eq!(second.empty_files.len(), 1);
}

#[test]
fn older_index_keeps_positive_cache_without_empty_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("positive.jsonl");
    write_record(&path, "user", "existing prompt");
    let first = rescan_roots(
        &[directory.path().to_path_buf()],
        &ThreadSearchIndex::default(),
    );
    let mut persisted = serde_json::to_value(&first).unwrap();
    persisted.as_object_mut().unwrap().remove("empty_files");
    let older: ThreadSearchIndex = serde_json::from_value(persisted).unwrap();
    reset_source_reads();
    let second = rescan_roots(&[directory.path().to_path_buf()], &older);
    assert_eq!(source_reads(), (0, 0));
    assert_eq!(second.sessions["positive"], first.sessions["positive"]);
}

#[test]
fn malformed_and_filtered_records_can_be_cached_without_text() {
    let directory = tempfile::tempdir().unwrap();
    let sources = [
        "{partial",
        r#"{"type":"user","isMeta":true,"content":"hidden"}"#,
        r#"{"type":"user","content":[{"type":"tool_result","content":"hidden"}]}"#,
        r#"{"type":"session_meta","payload":{"cwd":"/fixture"}}"#,
        r#"{"type":"user","content":"<system-reminder>context</system-reminder>"}"#,
    ];
    for (number, source) in sources.iter().enumerate() {
        std::fs::write(directory.path().join(format!("{number}.jsonl")), source).unwrap();
    }
    let first = rescan_roots(
        &[directory.path().to_path_buf()],
        &ThreadSearchIndex::default(),
    );
    assert_eq!(first.empty_files.len(), sources.len());
    assert!(first.sessions.is_empty());
    reset_source_reads();
    let second = rescan_roots(&[directory.path().to_path_buf()], &first);
    assert_eq!(source_reads(), (0, 0));
    assert_eq!(second.empty_files.len(), sources.len());
}

#[test]
fn failed_reads_are_retried_instead_of_cached_as_empty() {
    for fail_tail in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        write_record(&path, "assistant", "hidden");
        reset_source_reads();
        let fail: Box<dyn FnOnce() -> std::io::Result<()>> =
            Box::new(|| Err(std::io::Error::other("injected read failure")));
        SOURCE_READ_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(if fail_tail {
                // One short record fits in the first head read; fail the tail.
                Box::new(move || {
                    SOURCE_READ_HOOK.with(|hook| *hook.borrow_mut() = Some(fail));
                    Ok(())
                })
            } else {
                fail
            });
        });
        let failed = rescan_roots(
            &[directory.path().to_path_buf()],
            &ThreadSearchIndex::default(),
        );
        assert_eq!(failed.empty_files.len(), 0);
        assert!(failed.sessions.is_empty());
        reset_source_reads();
        let retried = rescan_roots(&[directory.path().to_path_buf()], &failed);
        assert_eq!(source_reads().0, 1);
        assert_eq!(retried.empty_files.len(), 1);
    }
}

#[test]
fn concurrent_source_edit_does_not_persist_a_false_negative() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write_record(&path, "assistant", "hidden");
    reset_source_reads();
    let changed = path.clone();
    SOURCE_READ_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            // Rotation/truncation after the first buffer is read leaves no
            // searchable text, but must not become an unchanged-file result.
            std::fs::write(changed, "{}\n")
        }))
    });
    let first = rescan_roots(
        &[directory.path().to_path_buf()],
        &ThreadSearchIndex::default(),
    );
    assert!(first.sessions.is_empty());
    assert_eq!(first.empty_files.len(), 0);
    write_record(&path, "user", "arrived during scan");
    let second = rescan_roots(&[directory.path().to_path_buf()], &first);
    assert_eq!(second.sessions["session"].opening, ["arrived during scan"]);
}

#[test]
#[ignore = "manual source-I/O and elapsed-time measurement"]
fn measure_large_empty_inventory_rescan() {
    let directory = tempfile::tempdir().unwrap();
    let record =
        serde_json::json!({"type":"assistant","message":{"content":"x".repeat(1024 * 1024)}})
            .to_string();
    for number in 0..64 {
        std::fs::write(
            directory.path().join(format!("session-{number}.jsonl")),
            &record,
        )
        .unwrap();
    }
    let roots = [directory.path().to_path_buf()];
    let first = rescan_roots(&roots, &ThreadSearchIndex::default());
    let persisted = serde_json::to_string(&first).unwrap();
    let restored: ThreadSearchIndex = serde_json::from_str(&persisted).unwrap();
    // Omitting empty metadata reproduces the old persisted cache behavior,
    // isolating the caching improvement from parser changes.
    let uncached: ThreadSearchIndex = serde_json::from_str(r#"{"sessions":{}}"#).unwrap();
    for (label, previous) in [
        ("without negative cache", &uncached),
        ("persisted negative cache", &restored),
    ] {
        reset_source_reads();
        let start = std::time::Instant::now();
        let result = rescan_roots(&roots, previous);
        let elapsed = start.elapsed();
        assert!(result.sessions.is_empty());
        eprintln!(
            "{label}: elapsed={elapsed:?}, opens/bytes={:?}, cache_bytes={}",
            source_reads(),
            persisted.len()
        );
    }
}
