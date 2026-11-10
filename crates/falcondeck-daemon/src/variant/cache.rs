//! One conservative cache policy shared by cache cleanup and checkout reclamation.
//! A familiar directory name is only a candidate; installed/generated structure
//! and a recursive content check must both pass before ignored data is disposable.
use std::{io::Read, path::Path};

pub(crate) const LOCATIONS: &[&str] = &[
    "node_modules",
    "frontend/node_modules",
    "target",
    "frontend/target",
];

pub(crate) fn known_location(relative: &str) -> bool {
    LOCATIONS.contains(&relative.trim_end_matches('/'))
}

fn forbidden_reason(path: &Path) -> Option<&'static str> {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(name.as_str(), ".git" | ".hg" | ".svn") {
        Some("Nested repository metadata")
    } else if name.starts_with(".env") {
        Some("Private environment/configuration")
    } else if name.ends_with("-wal")
        || name.ends_with("-shm")
        || matches!(
            ext.as_str(),
            "db" | "db3" | "sqlite" | "sqlite3" | "sql" | "mdb" | "rdb"
        )
    {
        Some("Database/data file")
    } else if matches!(ext.as_str(), "pem" | "key") {
        Some("Private key or credential file")
    } else {
        None
    }
}
fn forbidden(path: &Path) -> bool {
    forbidden_reason(path).is_some()
}

fn rust_artifact(root: &Path, path: &Path, header: &[u8]) -> std::io::Result<bool> {
    let relative = path.strip_prefix(root).unwrap();
    let parts = relative
        .iter()
        .map(|s| s.to_string_lossy())
        .collect::<Vec<_>>();
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if parts.len() == 1 {
        return Ok(match name {
            "CACHEDIR.TAG" => super::cache_index::bounded_read(path, 4 * 1024 * 1024)?
                .starts_with(b"Signature: 8a477f597d28d172789f06886806bc55"),
            ".rustc_info.json" => serde_json::from_slice::<serde_json::Value>(
                &super::cache_index::bounded_read(path, 4 * 1024 * 1024)?,
            )
            .is_ok_and(|v| v["rustc_fingerprint"].is_u64()),
            _ => false,
        });
    }
    if !matches!(parts[0].as_ref(), "debug" | "release") {
        return Ok(false);
    }
    // Object/archive/metadata magic identifies compiler output, including
    // extensionless executables. Plain notes and patches have no such proof.
    if header.starts_with(b"rust\0")
        || header.starts_with(b"!<arch>\n")
        || header.starts_with(b"\x7fELF")
        || [
            b"\xcf\xfa\xed\xfe".as_slice(),
            b"\xfe\xed\xfa\xcf",
            b"\xce\xfa\xed\xfe",
            b"\xfe\xed\xfa\xce",
            b"\xca\xfe\xba\xbe",
        ]
        .iter()
        .any(|magic| header.starts_with(magic))
    {
        return Ok(true);
    }
    if parts.len() == 2 && name == ".cargo-lock" {
        return Ok(std::fs::metadata(path)?.len() == 0);
    }
    if std::fs::metadata(path)?.len() > 4 * 1024 * 1024 {
        return Ok(false);
    }
    let bytes = super::cache_index::bounded_read(path, 4 * 1024 * 1024)?;
    if parts.len() == 4 && parts[1] == ".fingerprint" {
        if name == "invoked.timestamp" {
            return Ok(bytes == b"This file has an mtime of when this was started.");
        }
        if name.starts_with("dep-") {
            return Ok(bytes.starts_with(&[1, 0, 0, 0, 255]));
        }
        if name.starts_with("output-") {
            return Ok(bytes
                .split(|b| *b == b'\n')
                .filter(|l| !l.is_empty())
                .all(|line| {
                    serde_json::from_slice::<serde_json::Value>(line)
                        .is_ok_and(|v| v["$message_type"] == "diagnostic")
                }));
        }
        if [
            "lib-",
            "bin-",
            "test-",
            "build-script-",
            "run-build-script-",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
        {
            return Ok(if name.ends_with(".json") {
                serde_json::from_slice::<serde_json::Value>(&bytes)
                    .is_ok_and(|v| v["rustc"].is_u64() && v["deps"].is_array())
            } else {
                bytes.len() == 16 && bytes.iter().all(u8::is_ascii_hexdigit)
            });
        }
    }
    if name.ends_with(".d") && (parts.len() == 2 || (parts.len() == 3 && parts[1] == "deps")) {
        return Ok(std::str::from_utf8(&bytes).is_ok_and(|text| {
            !text.trim().is_empty()
                && text
                    .lines()
                    .filter(|l| !l.is_empty())
                    .all(|line| line.contains(": ") || line.ends_with(':'))
        }));
    }
    Ok(false)
}
fn safe_contents(root: &Path, path: &Path, rust: bool) -> std::io::Result<bool> {
    let m = std::fs::symlink_metadata(path)?;
    if forbidden(path) || !super::storage_metadata::cache_rebuildable(path)? {
        return Ok(false);
    }
    if m.file_type().is_symlink() {
        return Ok(std::fs::canonicalize(path).is_ok_and(|p| p.starts_with(root)));
    }
    if m.is_dir() {
        for entry in std::fs::read_dir(path)? {
            if !safe_contents(root, &entry?.path(), rust)? {
                return Ok(false);
            }
        }
    } else if m.is_file() {
        let mut header = [0; 16];
        let n = m.len().min(16) as usize;
        super::cache_index::open_regular(path)?.read_exact(&mut header[..n])?;
        if &header[..n] == b"SQLite format 3\0" {
            return Ok(false);
        }
        if rust && !rust_artifact(root, path, &header[..n])? {
            return Ok(false);
        }
    } else {
        return Ok(false);
    }
    Ok(true)
}

#[derive(Default, Debug)]
pub(crate) struct Partition {
    /// Relative roots kept privately; no file bytes belong in metadata/logs.
    pub retained: Vec<(std::path::PathBuf, String)>,
    pub rebuildable_bytes: u64,
}
/// Partition an exact cache location. Receipts/manifests identify packages but
/// never prove their contents: every discarded package file needs its original
/// per-file digest and mode. Unknown/edited/added files remain recoverable.
pub(crate) fn partition(
    checkout: &Path,
    relative: &str,
    physical: &Path,
) -> Result<Partition, String> {
    if !known_location(relative) {
        return Err("Not an exact supported cache location".into());
    }
    let m = std::fs::symlink_metadata(physical).map_err(|e| e.to_string())?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err("Cache root is not a real directory".into());
    }
    if relative.ends_with("target") {
        if validate_locations(checkout, checkout, relative, physical).is_ok() {
            return Ok(Partition {
                retained: Vec::new(),
                rebuildable_bytes: allocated(physical).map_err(|e| e.to_string())?,
            });
        }
        return Ok(Partition {
            retained: vec![(
                std::path::PathBuf::new(),
                "Unverified compiler output".into(),
            )],
            rebuildable_bytes: 0,
        });
    }
    let catalog = super::cache_index::load(physical);
    node_partition(physical, &catalog).map_err(|e| e.to_string())
}
fn allocated(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path)?;
    let mut n = m.blocks() * 512;
    if m.is_dir() && !m.file_type().is_symlink() {
        for e in std::fs::read_dir(path)? {
            n += allocated(&e?.path())?
        }
    }
    Ok(n)
}
fn node_partition(
    root: &Path,
    catalog: &super::cache_index::Catalog,
) -> std::io::Result<Partition> {
    use sha2::{Digest, Sha256, Sha512};
    fn walk(
        root: &Path,
        p: &Path,
        catalog: &super::cache_index::Catalog,
        context: Option<(std::path::PathBuf, std::sync::Arc<Vec<serde_json::Value>>)>,
        out: &mut Partition,
    ) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(p)?;
        let rel = p.strip_prefix(root).unwrap();
        if let Some(reason) = forbidden_reason(p).filter(|_| p != root) {
            out.retained.push((rel.into(), reason.into()));
            return Ok(());
        }
        if m.file_type().is_symlink() {
            // Link overrides are configuration too. An internal target alone
            // does not prove the link itself was generated by the installer.
            out.retained
                .push((rel.into(), "Unverified link or generated shim".into()));
            return Ok(());
        }
        if (m.is_dir() || m.is_file())
            && !super::storage_metadata::cache_rebuildable(p).unwrap_or(false)
        {
            out.retained
                .push((rel.into(), "Unverified extended attributes or ACL".into()));
            return Ok(());
        }
        if m.is_dir() {
            // A package can itself be a checkout. Never turn its tracked files
            // into deletions just because their bytes also match an install.
            if [".git", ".hg", ".svn"]
                .iter()
                .any(|name| std::fs::symlink_metadata(p.join(name)).is_ok())
            {
                out.retained
                    .push((rel.into(), "Nested repository checkout".into()));
                return Ok(());
            }
            let context = super::cache_index::bounded_read(&p.join("package.json"), 1024 * 1024)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| {
                    Some(format!(
                        "{}@{}",
                        v["name"].as_str()?,
                        v["version"].as_str()?
                    ))
                })
                .and_then(|key| {
                    catalog
                        .get(&key)
                        .cloned()
                        .map(|indices| (p.to_owned(), std::sync::Arc::new(indices)))
                })
                .or(context);
            let mut any = false;
            for e in std::fs::read_dir(p)? {
                any = true;
                walk(root, &e?.path(), catalog, context.clone(), out)?
            }
            if !any && p != root {
                out.retained
                    .push((rel.into(), "Empty directory without content proof".into()))
            }
            return Ok(());
        }
        if !m.is_file() {
            out.retained
                .push((rel.into(), "Special file requires manual recovery".into()));
            return Ok(());
        }
        let mut f = super::cache_index::open_regular(p)?;
        let mut header = [0; 16];
        let n = f.read(&mut header)?;
        if &header[..n] == b"SQLite format 3\0" {
            out.retained.push((rel.into(), "Database file".into()));
            return Ok(());
        }
        let Some((package, indices)) = context else {
            out.retained.push((
                rel.into(),
                "No per-file install receipt (metadata/generated/local file)".into(),
            ));
            return Ok(());
        };
        let name = p.strip_prefix(&package).unwrap().to_string_lossy();
        let name = name.as_ref();
        let records = indices
            .iter()
            .flat_map(|v| {
                let original = v["files"].get(name).map(|r| (v, r));
                let generated = v["sideEffects"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.values())
                    .filter_map(move |side| side["added"].get(name).map(|r| (v, r)));
                original.into_iter().chain(generated)
            })
            .collect::<Vec<_>>();
        if records.is_empty() {
            out.retained
                .push((rel.into(), "File absent from original package index".into()));
            return Ok(());
        }
        let mut sha512 = Sha512::new();
        let mut sha256 = Sha256::new();
        sha512.update(&header[..n]);
        sha256.update(&header[..n]);
        let mut b = [0; 65536];
        loop {
            let n = f.read(&mut b)?;
            if n == 0 {
                break;
            }
            sha512.update(&b[..n]);
            sha256.update(&b[..n]);
        }
        let a = format!("{:x}", sha512.finalize());
        let b = format!("{:x}", sha256.finalize());
        let unchanged = records.into_iter().any(|(v, r)| {
            let mode = r["mode"]
                .as_u64()
                .is_some_and(|mode| mode & 0o7777 == u64::from(m.mode() & 0o7777));
            let size = r["size"].as_u64() == Some(m.len());
            let digest = match (v["algo"].as_str(), r["digest"].as_str()) {
                (Some("sha512"), Some(d)) => d == a,
                (Some("sha256"), Some(d)) => d == b,
                _ => {
                    use base64::Engine;
                    r["integrity"]
                        .as_str()
                        .and_then(|s| s.strip_prefix("sha512-"))
                        .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
                        .is_some_and(|bytes| {
                            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>() == a
                        })
                }
            };
            mode && size && digest
        });
        let after = f.metadata()?;
        if after.ino() != m.ino() || after.len() != m.len() || after.modified()? != m.modified()? {
            return Err(std::io::Error::other(
                "Cache file changed during verification",
            ));
        }
        if unchanged {
            out.rebuildable_bytes += m.blocks() * 512
        } else {
            out.retained.push((
                rel.into(),
                "Package content or permissions differ from install index".into(),
            ))
        }
        Ok(())
    }
    let mut out = Partition::default();
    walk(root, root, catalog, None, &mut out)?;
    Ok(out)
}
#[cfg(test)]
fn validate(checkout: &Path, relative: &str) -> Result<(), String> {
    validate_at(
        checkout,
        relative,
        &checkout.join(relative.trim_end_matches('/')),
    )
}
#[cfg(test)]
fn validate_at(checkout: &Path, relative: &str, physical: &Path) -> Result<(), String> {
    validate_locations(checkout, checkout, relative, physical)
}
pub(crate) fn validate_locations(
    physical_checkout: &Path,
    _logical_checkout: &Path,
    relative: &str,
    physical: &Path,
) -> Result<(), String> {
    if !known_location(relative) {
        return Err("Not an exact supported cache location".into());
    }
    let input_source = physical_checkout.join(relative.trim_end_matches('/'));
    let path = physical.to_owned();
    let valid = (|| -> std::io::Result<bool> {
        let m = std::fs::symlink_metadata(&path)?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Ok(false);
        }
        if std::fs::read_dir(&path)?.next().is_none() {
            return Ok(true);
        }
        let rust = relative.ends_with("target");
        if rust {
            if !input_source
                .parent()
                .is_some_and(|p| p.join("Cargo.toml").is_file())
                || !path.join(".rustc_info.json").is_file()
                || !super::cache_index::bounded_read(&path.join("CACHEDIR.TAG"), 1024 * 1024)
                    .is_ok_and(|b| b.starts_with(b"Signature: 8a477f597d28d172789f06886806bc55"))
            {
                return Ok(false);
            }
            for e in std::fs::read_dir(&path)? {
                if !matches!(
                    e?.file_name().to_str(),
                    Some(
                        "debug"
                            | "release"
                            | "doc"
                            | ".rustc_info.json"
                            | "CACHEDIR.TAG"
                            | ".rustdoc_fingerprint.json"
                    )
                ) {
                    return Ok(false);
                }
            }
        } else {
            let plan = node_partition(&path, &super::cache_index::load(&path))?;
            return Ok(plan.retained.is_empty());
        }
        safe_contents(&path, &path, rust)
    })()
    .map_err(|e| e.to_string())?;
    if valid {
        Ok(())
    } else {
        if !relative.ends_with("target") {
            let plan = node_partition(&path, &super::cache_index::load(&path))
                .map_err(|e| e.to_string())?;
            if let Some((_, reason)) = plan.retained.first() {
                return Err(format!(
                    "{} item(s) retained: {reason}",
                    plan.retained.len()
                ));
            }
        }
        Err("Unverified compiler output or input receipts".into())
    }
}

pub(crate) fn ancestor_of_cache(entry: &str) -> bool {
    let prefix = format!("{}/", entry.trim_end_matches('/'));
    LOCATIONS.iter().any(|p| p.starts_with(&prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_manifest_pipe_is_retained_without_blocking_cache_partition() {
        use std::os::unix::ffi::OsStrExt;
        let t = tempfile::tempdir().unwrap();
        let modules = t.path().join("node_modules");
        let package = modules.join("example");
        std::fs::create_dir_all(&package).unwrap();
        let fifo =
            std::ffi::CString::new(package.join("package.json").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let root = t.path().to_owned();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(partition(&root, "node_modules", &root.join("node_modules")));
        });
        let plan = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(plan.rebuildable_bytes, 0);
        assert!(
            plan.retained
                .iter()
                .any(|(p, _)| p == Path::new("example/package.json"))
        );
    }
    #[test]
    fn package_checkout_keeps_its_tracked_files_even_when_install_digests_match() {
        let t = tempfile::tempdir().unwrap();
        let modules = t.path().join("node_modules");
        let package = modules.join("example");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"example","version":"1"}"#,
        )
        .unwrap();
        std::fs::write(package.join("index.js"), "unchanged dependency").unwrap();
        super::super::cache_index::test_catalog(&modules, &t.path().join("store"));
        std::fs::create_dir(package.join(".git")).unwrap();
        let plan = partition(t.path(), "node_modules", &modules).unwrap();
        assert_eq!(plan.rebuildable_bytes, 0);
        assert!(
            plan.retained
                .iter()
                .any(|(p, why)| p == Path::new("example") && why == "Nested repository checkout")
        );
    }
    #[test]
    fn built_package_files_require_matching_side_effect_content_receipts() {
        use sha2::{Digest, Sha512};
        use std::os::unix::fs::MetadataExt;
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("example");
        std::fs::create_dir(&p).unwrap();
        std::fs::write(
            p.join("package.json"),
            r#"{"name":"example","version":"1"}"#,
        )
        .unwrap();
        std::fs::write(p.join("native.node"), "verified build product").unwrap();
        let file = p.join("native.node");
        let m = std::fs::metadata(&file).unwrap();
        let record = serde_json::json!({"digest":format!("{:x}",Sha512::digest(std::fs::read(&file).unwrap())),"mode":m.mode()&0o7777,"size":m.len()});
        let catalog = std::collections::HashMap::from([(
            "example@1".into(),
            vec![
                serde_json::json!({"algo":"sha512","files":{},"sideEffects":{"platform":{"added":{"native.node":record}}}}),
            ],
        )]);
        let plan = node_partition(t.path(), &catalog).unwrap();
        assert!(
            !plan
                .retained
                .iter()
                .any(|(path, _)| path == Path::new("example/native.node"))
        );
        std::fs::write(&file, "local native binary edit").unwrap();
        let plan = node_partition(t.path(), &catalog).unwrap();
        assert!(
            plan.retained
                .iter()
                .any(|(path, _)| path == Path::new("example/native.node"))
        );
    }
    #[test]
    fn package_digests_do_not_authorize_private_extended_attributes() {
        let t = tempfile::tempdir().unwrap();
        let modules = t.path().join("node_modules");
        let pkg = modules.join("example");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"example","version":"1"}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("index.js"), "unchanged package bytes").unwrap();
        super::super::cache_index::test_catalog(&modules, &t.path().join("store"));
        assert!(
            !partition(t.path(), "node_modules", &modules)
                .unwrap()
                .retained
                .iter()
                .any(|(p, _)| p == Path::new("example/index.js"))
        );
        super::super::storage_metadata::set_attribute(
            &pkg.join("index.js"),
            b"user.falcondeck.private-notes",
            Some(b"PRIVATE_FIXTURE_NOTES"),
        )
        .unwrap();
        assert!(
            partition(t.path(), "node_modules", &modules)
                .unwrap()
                .retained
                .iter()
                .any(|(p, _)| p == Path::new("example/index.js"))
        );
        super::super::storage_metadata::set_attribute(
            &pkg,
            b"user.falcondeck.private-config",
            Some(b"PRIVATE_FIXTURE_CONFIG"),
        )
        .unwrap();
        let plan = partition(t.path(), "node_modules", &modules).unwrap();
        assert!(plan.retained.iter().any(|(p, _)| p == Path::new("example")));
        assert_eq!(plan.rebuildable_bytes, 0);
    }
    #[test]
    fn edited_and_added_package_files_are_retained_even_with_backdated_mtimes() {
        let t = tempfile::tempdir().unwrap();
        let modules = t.path().join("node_modules");
        let pkg = modules.join("example");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(t.path().join("package.json"), "{}").unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"example","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("index.js"), "original package bytes").unwrap();
        std::fs::write(
            modules.join(".package-lock.json"),
            r#"{"packages":{"node_modules/example":{}}}"#,
        )
        .unwrap();
        super::super::cache_index::test_catalog(&modules, &t.path().join("store"));
        let original = partition(t.path(), "node_modules", &modules).unwrap();
        assert!(original.rebuildable_bytes > 0);
        assert!(
            !original
                .retained
                .iter()
                .any(|(p, _)| p == Path::new("example/index.js"))
        );
        for (name, bytes) in [
            ("index.js", "edited while debugging"),
            ("notes.txt", "only copy of authored notes"),
        ] {
            let file = pkg.join(name);
            std::fs::write(&file, bytes).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
                .unwrap();
            let proof = partition(t.path(), "node_modules", &modules).unwrap();
            assert!(
                proof
                    .retained
                    .iter()
                    .any(|(p, _)| p == &Path::new("example").join(name)),
                "{name}"
            );
            assert!(validate(t.path(), "node_modules").is_err());
        }
    }
    #[test]
    fn names_alone_and_unknown_content_never_authorize_cache_removal() {
        let t = tempfile::tempdir().unwrap();
        for name in [
            "build",
            ".cache",
            "vendor",
            "public/vendor",
            "resources/views/vendor",
            "node_modules",
        ] {
            let p = t.path().join(name);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("authored.txt"), "only copy").unwrap();
            assert!(validate(t.path(), name).is_err(), "{name}");
        }
    }
    #[test]
    fn installed_dependency_proof_still_refuses_git_and_databases() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        let modules = root.join("node_modules");
        std::fs::create_dir_all(modules.join("example")).unwrap();
        std::fs::write(
            modules.join(".package-lock.json"),
            r#"{"packages":{"node_modules/example":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            modules.join("example/package.json"),
            r#"{"name":"example"}"#,
        )
        .unwrap();
        assert!(validate(root, "node_modules").is_err());
        super::super::cache_index::test_catalog(&modules, &root.join("store"));
        assert!(
            partition(root, "node_modules", &modules)
                .unwrap()
                .rebuildable_bytes
                > 0
        );
        for (name, bytes) in [
            (".git", b"gitdir: elsewhere".as_slice()),
            ("local.sqlite", b"data".as_slice()),
            ("hidden.data", b"SQLite format 3\0".as_slice()),
        ] {
            let p = modules.join("example").join(name);
            std::fs::write(&p, bytes).unwrap();
            assert!(validate(root, "node_modules").is_err(), "{name}");
            std::fs::remove_file(p).unwrap();
        }
        std::fs::create_dir(modules.join("local-work")).unwrap();
        assert!(validate(root, "node_modules").is_err());
    }
    #[test]
    fn hoisted_pnpm_content_requires_verified_package_links() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let modules = root.join("node_modules");
        let package = modules.join(".pnpm/example@1.0.0/node_modules/example");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir(modules.join(".pnpm/node_modules")).unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), "example@1.0.0").unwrap();
        std::fs::write(modules.join(".pnpm/lock.yaml"), "example@1.0.0").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"example","version":"1.0.0"}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(
            ".pnpm/example@1.0.0/node_modules/example",
            modules.join("example"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            "../example@1.0.0/node_modules/example",
            modules.join(".pnpm/node_modules/example"),
        )
        .unwrap();
        assert!(validate(root, "node_modules").is_err());
        super::super::cache_index::test_catalog(&modules, &root.join("store"));
        assert!(
            partition(root, "node_modules", &modules)
                .unwrap()
                .rebuildable_bytes
                > 0
        );
        let local = modules.join(".pnpm/node_modules/local-work");
        std::fs::create_dir(&local).unwrap();
        std::fs::write(local.join("draft.ts"), "unique authored work").unwrap();
        assert!(validate(root, "node_modules").is_err());
        std::fs::remove_dir_all(local).unwrap();
        std::fs::create_dir(modules.join(".bin")).unwrap();
        std::fs::write(modules.join(".bin/draft.ts"), "unique authored work").unwrap();
        assert!(validate(root, "node_modules").is_err());
    }
    #[test]
    fn generated_and_authored_shims_both_remain_recoverable_without_content_receipts() {
        let t = tempfile::tempdir().unwrap();
        let modules = t.path().join("node_modules");
        std::fs::create_dir_all(modules.join(".bin")).unwrap();
        std::fs::write(
            modules.join(".bin/example"),
            "#!/bin/sh\nnode ../example/cli.js\n",
        )
        .unwrap();
        let proof = partition(t.path(), "node_modules", &modules).unwrap();
        assert!(
            proof
                .retained
                .iter()
                .any(|(p, _)| p == Path::new(".bin/example"))
        );
        std::fs::write(
            modules.join(".bin/example"),
            "echo only-copy-authored-work\n",
        )
        .unwrap();
        let proof = partition(t.path(), "node_modules", &modules).unwrap();
        assert!(
            proof
                .retained
                .iter()
                .any(|(p, _)| p == Path::new(".bin/example"))
        );
    }
    #[test]
    fn rust_target_accepts_known_artifacts_and_retains_unproven_notes_and_patches() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let target = root.join("target");
        std::fs::create_dir_all(target.join("debug/deps")).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname='fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        std::fs::write(
            target.join(".rustc_info.json"),
            r#"{"rustc_fingerprint":1}"#,
        )
        .unwrap();
        std::fs::write(
            target.join("CACHEDIR.TAG"),
            "Signature: 8a477f597d28d172789f06886806bc55",
        )
        .unwrap();
        std::fs::write(target.join("debug/deps/libexample.rmeta"), b"rust\0\0\0\n").unwrap();
        assert!(validate(root, "target").is_ok());
        for name in ["fix.patch", "notes", "draft.sql", "saved.bin"] {
            let file = target.join("debug").join(name);
            std::fs::write(&file, "authored work").unwrap();
            assert!(validate(root, "target").is_err(), "{name}");
            std::fs::remove_file(file).unwrap();
        }
    }
}
