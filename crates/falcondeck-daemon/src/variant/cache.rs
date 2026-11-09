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

fn forbidden(path: &Path) -> bool {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    matches!(name.as_str(), ".git" | ".hg" | ".svn")
        || name.starts_with(".env")
        || name.ends_with("-wal")
        || name.ends_with("-shm")
        || matches!(
            path.extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("db" | "db3" | "sqlite" | "sqlite3" | "sql" | "mdb" | "rdb" | "pem" | "key")
        )
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
            "CACHEDIR.TAG" => {
                std::fs::read(path)?.starts_with(b"Signature: 8a477f597d28d172789f06886806bc55")
            }
            ".rustc_info.json" => {
                serde_json::from_slice::<serde_json::Value>(&std::fs::read(path)?)
                    .is_ok_and(|v| v["rustc_fingerprint"].is_u64())
            }
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
    let bytes = std::fs::read(path)?;
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
    if forbidden(path) {
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
        std::fs::File::open(path)?.read_exact(&mut header[..n])?;
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

// A supported pnpm Node shim must match the generated template byte-for-byte
// apart from blank lines, point at a manifest-declared binary in this install,
// and only add module paths inside it. Extra authored shell content is retained.
const PNPM_NODE_SHIM: &str = include_str!("pnpm-node-shim.template");
fn generated_shim(root: &Path, logical_root: &Path, shim: &Path) -> std::io::Result<bool> {
    let m = std::fs::symlink_metadata(shim)?;
    if !m.is_file() || m.len() > 16384 {
        return Ok(false);
    }
    let text = std::fs::read_to_string(shim)?;
    let Some(target) = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|s| s.strip_prefix("# cmd-shim-target="))
    else {
        return Ok(false);
    };
    let Ok(relative) = Path::new(target).strip_prefix(logical_root) else {
        return Ok(false);
    };
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Ok(false);
    }
    let physical = root.join(relative);
    let physical = std::fs::canonicalize(physical)?;
    if !physical.starts_with(root) || !physical.is_file() {
        return Ok(false);
    }
    let command = shim.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let mut declared = false;
    for package in physical
        .parent()
        .unwrap()
        .ancestors()
        .take_while(|p| p.starts_with(root) && *p != root)
    {
        let Ok(bytes) = std::fs::read(package.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return Ok(false);
        };
        let bin = if let Some(path) = manifest["bin"].as_str() {
            (manifest["name"].as_str().and_then(|s| s.rsplit('/').next()) == Some(command))
                .then_some(path)
        } else {
            manifest["bin"].get(command).and_then(|v| v.as_str())
        };
        if let Some(bin) = bin.filter(|s| !Path::new(s).is_absolute()) {
            declared = std::fs::canonicalize(package.join(bin))
                .is_ok_and(|p| p == physical && p.starts_with(package));
        }
        break;
    }
    if !declared {
        return Ok(false);
    }
    let depth = shim
        .parent()
        .unwrap()
        .strip_prefix(root)
        .unwrap()
        .components()
        .count();
    let rel = format!("{}{}", "../".repeat(depth), relative.to_string_lossy());
    let mut expected = PNPM_NODE_SHIM
        .replace("@TARGET@", target)
        .replace("@RELATIVE@", &rel);
    if let Some(paths) = text.lines().find_map(|l| {
        l.trim()
            .strip_prefix("export NODE_PATH=\"")
            .and_then(|s| s.strip_suffix('"'))
    }) {
        if paths.contains(['$', '`', '"', '\n', '\r'])
            || paths.split(':').any(|p| {
                let p = Path::new(p);
                !p.starts_with(logical_root)
                    || p.components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
            })
        {
            return Ok(false);
        }
        expected = expected.replace("@NODE_PATH@", paths);
    } else {
        let start = expected.find("if [ -z \"$NODE_PATH\" ]; then").unwrap();
        let end = start + expected[start..].find("\nfi\n").unwrap() + 4;
        expected.replace_range(start..end, "");
    }
    let normalize = |s: &str| {
        s.lines()
            .filter(|l| !l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(normalize(&text) == normalize(&expected))
}
// Hoisted dependency and executable folders contain links to installed packages,
// never independent authored directories. Scope folders only group those links.
fn installed_links(root: &Path, logical_root: &Path, directory: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            if !std::fs::canonicalize(entry.path()).is_ok_and(|p| p.starts_with(root)) {
                return Ok(false);
            }
        } else if kind.is_dir()
            && (entry.file_name().to_string_lossy().starts_with('@') || entry.file_name() == ".bin")
        {
            if !installed_links(root, logical_root, &entry.path())? {
                return Ok(false);
            }
        } else if directory.file_name().is_some_and(|n| n == ".bin") && kind.is_file() {
            if !generated_shim(root, logical_root, &entry.path())? {
                return Ok(false);
            }
        } else {
            return Ok(false);
        }
    }
    Ok(true)
}
fn installed_node_modules(
    root: &Path,
    source: &Path,
    input_source: &Path,
) -> std::io::Result<bool> {
    if !input_source
        .parent()
        .is_some_and(|p| p.join("package.json").is_file())
    {
        return Ok(false);
    }
    let installed = std::fs::read(root.join(".package-lock.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    let npm = installed
        .as_ref()
        .and_then(|v| v.get("packages"))
        .and_then(|v| v.as_object());
    let pnpm = std::fs::read(root.join(".pnpm/lock.yaml")).ok();
    let mut parent = input_source.parent();
    let mut lock_matches = false;
    while let Some(p) = parent {
        if p.join(".git").exists() || p == input_source.parent().unwrap() {
            if let (Some(saved), Ok(actual)) = (&pnpm, std::fs::read(p.join("pnpm-lock.yaml"))) {
                lock_matches = *saved == actual;
            }
        }
        if lock_matches || p.join(".git").exists() {
            break;
        }
        parent = p.parent();
    }
    if npm.is_none() && !lock_matches {
        return Ok(false);
    }
    let mut packages = Vec::new();
    for e in std::fs::read_dir(root)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".bin" {
            if !installed_links(root, source, &e.path())? {
                return Ok(false);
            }
            continue;
        }
        if matches!(
            name.as_str(),
            ".package-lock.json" | ".modules.yaml" | ".pnpm-workspace-state-v1.json"
        ) {
            continue;
        }
        if name == ".pnpm" && lock_matches {
            continue;
        }
        if name.starts_with('@') && e.file_type()?.is_dir() {
            for child in std::fs::read_dir(e.path())? {
                let c = child?;
                packages.push((
                    format!("{name}/{}", c.file_name().to_string_lossy()),
                    c.path(),
                ));
            }
        } else {
            packages.push((name, e.path()));
        }
    }
    if lock_matches {
        for entry in std::fs::read_dir(root.join(".pnpm"))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "node_modules" {
                if !installed_links(root, source, &entry.path())? {
                    return Ok(false);
                }
                continue;
            }
            if name == "lock.yaml" {
                continue;
            }
            if !entry.file_type()?.is_dir()
                || !name.contains('@')
                || !entry.path().join("node_modules").is_dir()
            {
                return Ok(false);
            }
            let mut manifests = Vec::new();
            for child in std::fs::read_dir(entry.path().join("node_modules"))? {
                let child = child?;
                if child.file_type()?.is_symlink() {
                    continue;
                }
                if child.file_name().to_string_lossy().starts_with('@') {
                    for scoped in std::fs::read_dir(child.path())? {
                        let scoped = scoped?;
                        if !scoped.file_type()?.is_symlink() {
                            manifests.push(scoped.path().join("package.json"));
                        }
                    }
                } else {
                    manifests.push(child.path().join("package.json"));
                }
            }
            if manifests.is_empty() {
                return Ok(false);
            }
            for manifest in manifests {
                let value: serde_json::Value = serde_json::from_slice(&std::fs::read(manifest)?)?;
                let (Some(package), Some(version)) =
                    (value["name"].as_str(), value["version"].as_str())
                else {
                    return Ok(false);
                };
                let encoded = format!("{}@{version}", package.replace('/', "+"));
                if !name.starts_with(&encoded) {
                    return Ok(false);
                }
                let lock = String::from_utf8_lossy(pnpm.as_ref().unwrap());
                if !lock.contains(&format!("{package}@{version}"))
                    && !lock.contains(&format!("{package}/{version}"))
                {
                    return Ok(false);
                }
            }
        }
    }
    for (name, path) in packages {
        let manifest = std::fs::read(path.join("package.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        let Some(manifest) = manifest else {
            return Ok(false);
        };
        if manifest.get("name").and_then(|s| s.as_str()) != Some(name.as_str()) {
            return Ok(false);
        }
        let npm_proof = npm.is_some_and(|p| p.contains_key(&format!("node_modules/{name}")));
        let pnpm_proof = lock_matches
            && std::fs::canonicalize(&path).is_ok_and(|p| p.starts_with(root.join(".pnpm")));
        if !npm_proof && !pnpm_proof {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn validate(checkout: &Path, relative: &str) -> Result<(), String> {
    validate_at(
        checkout,
        relative,
        &checkout.join(relative.trim_end_matches('/')),
    )
}
pub(crate) fn quarantine_contents_safe(path: &Path, rust: bool) -> Result<(), String> {
    if safe_contents(path, path, rust).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err("Non-cache content in quarantine".into())
    }
}
pub(crate) fn validate_at(checkout: &Path, relative: &str, physical: &Path) -> Result<(), String> {
    validate_locations(checkout, checkout, relative, physical)
}
pub(crate) fn validate_locations(
    physical_checkout: &Path,
    logical_checkout: &Path,
    relative: &str,
    physical: &Path,
) -> Result<(), String> {
    if !known_location(relative) {
        return Err("Not an exact supported cache location".into());
    }
    let source = logical_checkout.join(relative.trim_end_matches('/'));
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
                || !std::fs::read(path.join("CACHEDIR.TAG"))
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
        } else if !installed_node_modules(&path, &source, &input_source)? {
            return Ok(false);
        }
        safe_contents(&path, &path, rust)
    })()
    .map_err(|e| e.to_string())?;
    if valid {
        Ok(())
    } else {
        Err("Cache proof missing, or nested Git/database/private/authored content found".into())
    }
}

/// Inspect collapsed ignored entries without allowing arbitrary nested names.
pub(crate) fn roots_covering(entry: &str) -> impl Iterator<Item = &'static str> {
    let entry = entry.trim_end_matches('/').to_owned();
    LOCATIONS
        .iter()
        .copied()
        .filter(move |p| *p == entry || entry.starts_with(&format!("{p}/")))
}
pub(crate) fn ancestor_of_cache(entry: &str) -> bool {
    let prefix = format!("{}/", entry.trim_end_matches('/'));
    LOCATIONS.iter().any(|p| p.starts_with(&prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(validate(root, "node_modules").is_ok());
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
        assert!(validate(root, "node_modules").is_ok());
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
    fn generated_pnpm_node_shims_are_bound_to_declared_binaries_and_exact_template() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("node_modules");
        let package = root.join("example");
        let bins = root.join(".bin");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir(&bins).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"example","bin":{"example":"cli.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("cli.js"), "#!/usr/bin/env node\n").unwrap();
        let target = package.join("cli.js").to_string_lossy().into_owned();
        let content = PNPM_NODE_SHIM
            .replace("@TARGET@", &target)
            .replace("@RELATIVE@", "../example/cli.js")
            .replace("@NODE_PATH@", root.to_str().unwrap());
        let shim = bins.join("example");
        std::fs::write(&shim, &content).unwrap();
        assert!(installed_links(&root, &root, &bins).unwrap());
        std::fs::write(&shim, format!("{content}echo unique authored work\n")).unwrap();
        assert!(!installed_links(&root, &root, &bins).unwrap());
        std::fs::write(&shim, &content).unwrap();
        std::fs::rename(&shim, bins.join("unknown")).unwrap();
        assert!(!installed_links(&root, &root, &bins).unwrap());
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
