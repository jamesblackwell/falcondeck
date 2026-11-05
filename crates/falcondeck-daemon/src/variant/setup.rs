//! Optional per-project provisioning. Configuration lives outside the checkout:
//! `git config falcondeck.worktreeSetup /absolute/path/to/setup.json`.
use std::path::{Component, Path};

use serde::Deserialize;
use tokio::fs;
#[cfg(not(target_os = "macos"))]
use tokio::process::Command;

use super::run_git;
use crate::error::DaemonError;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Setup {
    pub sparse_exclude: Vec<String>,
    pub dependency_roots: Vec<String>,
    pub sparse_hint: String,
}

fn relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

pub(super) async fn load(project: &str) -> Result<Setup, DaemonError> {
    let Ok(path) = run_git(project, &["config", "--get", "falcondeck.worktreeSetup"]).await else {
        return Ok(Setup::default());
    };
    let path = Path::new(path.trim());
    if !path.is_absolute() {
        return Err(DaemonError::BadRequest(
            "falcondeck.worktreeSetup must be an absolute JSON path".into(),
        ));
    }
    let bytes = fs::read(path)
        .await
        .map_err(|e| DaemonError::Rpc(format!("read worktree setup: {e}")))?;
    let setup: Setup = serde_json::from_slice(&bytes)
        .map_err(|e| DaemonError::BadRequest(format!("invalid worktree setup: {e}")))?;
    if setup.sparse_exclude.iter().any(|p| !relative(p))
        || setup
            .dependency_roots
            .iter()
            .any(|p| p != "." && !relative(p))
    {
        return Err(DaemonError::BadRequest(
            "worktree setup paths must be repository-relative directories".into(),
        ));
    }
    Ok(setup)
}

pub(super) async fn provision(project: &str, destination: &Path) -> Result<(), DaemonError> {
    let setup = load(project).await?;
    let dest = destination.to_string_lossy();
    if !setup.sparse_exclude.is_empty() {
        // Include maximal subtrees outside excluded paths. Cone mode also keeps
        // files in their ancestors, so reports/development and root gates remain.
        let tree = run_git(&dest, &["ls-tree", "-r", "-d", "--name-only", "-z", "HEAD"]).await?;
        let mut include: Vec<&str> = Vec::new();
        for dir in tree.split('\0').filter(|d| !d.is_empty()) {
            if setup
                .sparse_exclude
                .iter()
                .any(|e| dir == e || dir.starts_with(&format!("{e}/")))
            {
                continue;
            }
            if setup
                .sparse_exclude
                .iter()
                .any(|e| e.starts_with(&format!("{dir}/")))
            {
                continue;
            }
            if !include.iter().any(|p| dir.starts_with(&format!("{p}/"))) {
                include.push(dir);
            }
        }
        run_git(&dest, &["sparse-checkout", "init", "--cone"]).await?;
        let mut args = vec!["sparse-checkout", "set", "--cone", "--"];
        args.extend(include);
        run_git(&dest, &args).await?;
    }
    run_git(&dest, &["reset", "--hard", "HEAD"]).await?;
    for root in &setup.dependency_roots {
        if let Err(error) = clone_dependencies(Path::new(project), destination, root).await {
            // No full-copy fallback: on unsupported filesystems leave deps
            // absent, exactly like a cold checkout, for the usual install.
            tracing::info!(%root, %error, "warm dependencies unavailable; install normally in the isolated copy");
        }
    }
    Ok(())
}

pub(crate) async fn hint(project: &str, destination: &str) -> Option<String> {
    let setup = load(project).await.ok()?;
    if setup.sparse_exclude.is_empty() {
        return None;
    }
    // Only hint for a sparse checkout, including after a user adds paths back.
    run_git(destination, &["sparse-checkout", "list"])
        .await
        .ok()?;
    Some(format!(
        "This isolated checkout uses Git cone-mode sparse checkout. Omitted by project configuration: {}. If an input directory is missing, restore it with `git sparse-checkout add <directory>` (or `git sparse-checkout disable` for the full tree). {}",
        setup.sparse_exclude.join(", "),
        setup.sparse_hint
    ))
}

async fn matching_inputs(source: &Path, destination: &Path) -> bool {
    let mut locks = 0;
    for name in [
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        ".npmrc",
        "pnpm-workspace.yaml",
    ] {
        match (
            fs::read(source.join(name)).await,
            fs::read(destination.join(name)).await,
        ) {
            (Ok(a), Ok(b)) if a == b => {
                if name.ends_with("lock.yaml")
                    || name.ends_with("lock.json")
                    || name == "yarn.lock"
                    || name == "npm-shrinkwrap.json"
                {
                    locks += 1;
                }
            }
            (Err(a), Err(b))
                if a.kind() == std::io::ErrorKind::NotFound
                    && b.kind() == std::io::ErrorKind::NotFound => {}
            _ => return false,
        }
    }
    locks > 0
}

/// Reject escaping links and binary source-checkout paths. Textual paths in
/// generated shims are relocated after cloning. Only node_modules is traversed; links are never followed.
fn portable_tree(path: &Path, tree: &Path, source: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.file_type()?;
        if meta.is_symlink() {
            let link = std::fs::read_link(entry.path())?;
            if link.is_absolute() {
                return Ok(false);
            }
            let mut resolved = entry.path().parent().unwrap_or(tree).to_path_buf();
            for c in link.components() {
                match c {
                    Component::ParentDir => {
                        resolved.pop();
                    }
                    Component::Normal(p) => resolved.push(p),
                    Component::CurDir => {}
                    _ => return Ok(false),
                }
            }
            if !resolved.starts_with(tree) {
                return Ok(false);
            }
        } else if meta.is_dir() {
            if !portable_tree(&entry.path(), tree, source)? {
                return Ok(false);
            }
        } else if meta.is_file() {
            let bytes = std::fs::read(entry.path())?;
            let needle = source.as_os_str().as_encoded_bytes();
            if bytes.windows(needle.len()).any(|w| w == needle)
                && std::str::from_utf8(&bytes).is_err()
            {
                return Ok(false);
            }
        } else {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn clone_dependencies(source: &Path, destination: &Path, root: &str) -> Result<(), String> {
    let from = source.join(root);
    let to = destination.join(root);
    if !matching_inputs(&from, &to).await
        || (root != "." && !matching_inputs_optional_root(source, destination).await)
    {
        return Err("lockfile/package inputs absent or mismatched".into());
    }
    // A warm folder alone does not prove the install matches today's lockfile.
    // pnpm records the installed lock; other managers use their normal install
    // until an equally reliable receipt is available.
    let (Ok(lock), Ok(installed)) = (
        fs::read(from.join("pnpm-lock.yaml")).await,
        fs::read(from.join("node_modules/.pnpm/lock.yaml")).await,
    ) else {
        return Err("no verifiable installed pnpm lock; install normally".into());
    };
    if lock != installed {
        return Err("warm installed lock is stale".into());
    }
    let modules = from.join("node_modules");
    if !modules.is_dir() || to.join("node_modules").exists() {
        return Err("no warm dependencies or target already exists".into());
    }
    let source = source.to_owned();
    let source_check = source.clone();
    let modules_check = modules.clone();
    let safe = tokio::task::spawn_blocking(move || {
        portable_tree(&modules_check, &modules_check, &source_check)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !safe {
        return Err("dependencies contain escaping links or source-checkout paths".into());
    }
    let staging = to.join(format!(".falcondeck-deps-{}", uuid::Uuid::new_v4()));
    let result = clone_tree(&modules, &staging).await;
    if result.is_ok() {
        let stage = staging.clone();
        let dest = destination.to_owned();
        let relocate = tokio::task::spawn_blocking(move || relocate_paths(&stage, &source, &dest))
            .await
            .map_err(|e| e.to_string())?;
        if let Err(error) = relocate {
            let _ = fs::remove_dir_all(&staging).await;
            return Err(error.to_string());
        }
        // The source may have changed while clonefile walked the tree.
        if !matching_inputs(&from, &to).await
            || fs::read(staging.join(".pnpm/lock.yaml")).await.ok() != Some(lock)
        {
            let _ = fs::remove_dir_all(&staging).await;
            return Err("warm inputs changed during cloning".into());
        }
        if let Err(error) = fs::rename(&staging, to.join("node_modules")).await {
            let _ = fs::remove_dir_all(&staging).await;
            return Err(error.to_string());
        }
    } else {
        let _ = fs::remove_dir_all(&staging).await;
    }
    result
}

async fn matching_inputs_optional_root(source: &Path, destination: &Path) -> bool {
    for name in [
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "pnpm-workspace.yaml",
        ".npmrc",
    ] {
        match (
            fs::read(source.join(name)).await,
            fs::read(destination.join(name)).await,
        ) {
            (Ok(a), Ok(b)) if a == b => {}
            (Err(a), Err(b))
                if a.kind() == std::io::ErrorKind::NotFound
                    && b.kind() == std::io::ErrorKind::NotFound => {}
            _ => return false,
        }
    }
    true
}

fn relocate_paths(path: &Path, source: &Path, destination: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            relocate_paths(&entry.path(), source, destination)?;
        } else if kind.is_file() {
            let bytes = std::fs::read(entry.path())?;
            let needle = source.as_os_str().as_encoded_bytes();
            if bytes.windows(needle.len()).any(|w| w == needle) {
                let text = String::from_utf8(bytes).map_err(std::io::Error::other)?;
                std::fs::write(
                    entry.path(),
                    text.replace(
                        source.to_string_lossy().as_ref(),
                        destination.to_string_lossy().as_ref(),
                    ),
                )?;
            }
        }
    }
    Ok(())
}

async fn clone_tree(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (source, target) = (source.to_owned(), target.to_owned());
        let cleanup = target.clone();
        let result = tokio::task::spawn_blocking(move || clone_apfs(&source, &target))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string());
        if result.is_err() {
            let _ = fs::remove_dir_all(cleanup).await;
        }
        return result;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let output = Command::new("cp")
            .args(["--reflink=always", "-R"])
            .arg(source)
            .arg(target)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into_owned())
        }
    }
}

#[cfg(target_os = "macos")]
fn clone_apfs(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    std::fs::create_dir(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            clone_apfs(&entry.path(), &to)?;
        } else if kind.is_symlink() {
            symlink(std::fs::read_link(entry.path())?, &to)?;
        } else {
            let from = std::ffi::CString::new(entry.path().as_os_str().as_bytes())?;
            let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
            // SAFETY: both paths are NUL-terminated. clonefile fails rather
            // than copying bytes on unsupported volumes or across devices.
            if unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    std::fs::set_permissions(target, std::fs::metadata(source)?.permissions())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variant::{create_in_root, restore};
    use tempfile::tempdir;

    async fn git(path: &Path, args: &[&str]) -> String {
        run_git(path.to_str().unwrap(), args).await.unwrap()
    }

    async fn fixture(path: &Path) {
        git(path, &["init", "-b", "main"]).await;
        git(path, &["config", "user.email", "test@example.com"]).await;
        git(path, &["config", "user.name", "Test"]).await;
        for dir in [
            "data/qbank",
            "data/keep",
            "docs/research",
            "docs/marketing",
            "docs/help-center",
            "docs/reports",
            "docs/development",
            "app/Services/QBank",
            "frontend",
        ] {
            fs::create_dir_all(path.join(dir)).await.unwrap();
            fs::write(path.join(dir).join("file"), "source")
                .await
                .unwrap();
        }
        fs::write(path.join(".gitignore"), "node_modules/\n")
            .await
            .unwrap();
        fs::write(path.join("frontend/package.json"), "{}")
            .await
            .unwrap();
        fs::write(
            path.join("frontend/pnpm-lock.yaml"),
            "lockfileVersion: '9.0'\n",
        )
        .await
        .unwrap();
        git(path, &["add", "."]).await;
        git(path, &["commit", "-m", "fixture"]).await;
    }

    async fn config(project: &Path, path: &Path) {
        fs::write(path, r#"{"sparse_exclude":["data/qbank","docs/research","docs/marketing","docs/help-center"],"dependency_roots":["frontend"],"sparse_hint":"QBank and Curriculum services need data/qbank: git sparse-checkout add data/qbank"}"#).await.unwrap();
        git(
            project,
            &["config", "falcondeck.worktreeSetup", path.to_str().unwrap()],
        )
        .await;
    }

    async fn warm(project: &Path) {
        let modules = project.join("frontend/node_modules");
        fs::create_dir_all(modules.join(".pnpm")).await.unwrap();
        fs::create_dir_all(modules.join(".bin")).await.unwrap();
        fs::copy(
            project.join("frontend/pnpm-lock.yaml"),
            modules.join(".pnpm/lock.yaml"),
        )
        .await
        .unwrap();
        fs::write(
            modules.join(".bin/tool"),
            format!(
                "#!/bin/sh\necho {}/frontend/node_modules/pkg\n",
                project.display()
            ),
        )
        .await
        .unwrap();
        #[cfg(unix)]
        if !modules.join(".bin/link").is_symlink() {
            std::os::unix::fs::symlink("../.pnpm/lock.yaml", modules.join(".bin/link")).unwrap();
        }
    }

    #[tokio::test]
    async fn sparse_creation_restore_and_merge_leave_other_checkouts_full() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        let existing = root.path().join("existing");
        git(
            &project,
            &[
                "worktree",
                "add",
                "-b",
                "existing",
                existing.to_str().unwrap(),
            ],
        )
        .await;
        config(&project, &root.path().join("setup.json")).await;
        warm(&project).await;
        let v = create_in_root(
            project.to_str().unwrap(),
            "sparse",
            &root.path().join("variants"),
        )
        .await
        .unwrap();
        let dest = Path::new(&v.path);
        for excluded in [
            "data/qbank",
            "docs/research",
            "docs/marketing",
            "docs/help-center",
        ] {
            assert!(!dest.join(excluded).exists(), "{excluded}");
        }
        for kept in [
            "docs/reports/file",
            "docs/development/file",
            "data/keep/file",
            "app/Services/QBank/file",
        ] {
            assert!(dest.join(kept).exists(), "{kept}");
        }
        assert!(project.join("data/qbank/file").exists());
        assert!(existing.join("data/qbank/file").exists());
        assert!(git(&project, &["status", "--porcelain"]).await.is_empty());
        assert!(git(&existing, &["status", "--porcelain"]).await.is_empty());
        assert!(
            hint(project.to_str().unwrap(), &v.path)
                .await
                .unwrap()
                .contains("git sparse-checkout add data/qbank")
        );
        git(dest, &["sparse-checkout", "add", "data/qbank"]).await;
        assert!(dest.join("data/qbank/file").exists());
        // A main change outside the sparse tree can still merge from it.
        fs::write(project.join("docs/research/file"), "new research")
            .await
            .unwrap();
        git(&project, &["add", "."]).await;
        git(&project, &["commit", "-m", "research"]).await;
        git(dest, &["merge", "main"]).await;
        assert!(!dest.join("docs/research").exists());
        git(&project, &["worktree", "remove", &v.path]).await;
        assert_eq!(restore(project.to_str().unwrap(), &v).await, Ok(true));
        assert!(!dest.join("data/qbank").exists());
        assert!(dest.join("docs/reports/file").exists());
    }

    #[tokio::test]
    async fn clone_relocates_shims_and_preserves_relative_links() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).await.unwrap();
        fixture(&source).await;
        warm(&source).await;
        let dest = root.path().join("dest");
        git(
            &source,
            &["clone", source.to_str().unwrap(), dest.to_str().unwrap()],
        )
        .await;
        let result = clone_dependencies(&source, &dest, "frontend").await;
        // Some CI filesystems cannot reflink: that is an intentional cold fallback.
        #[cfg(target_os = "macos")]
        assert!(result.is_ok(), "APFS clone failed: {result:?}");
        if result.is_err() {
            assert!(!dest.join("frontend/node_modules").exists());
            return;
        }
        let shim = fs::read_to_string(dest.join("frontend/node_modules/.bin/tool"))
            .await
            .unwrap();
        assert!(shim.contains(dest.to_str().unwrap()));
        assert!(!shim.contains(source.to_str().unwrap()));
        fs::write(
            dest.join("frontend/node_modules/.pnpm/lock.yaml"),
            "changed",
        )
        .await
        .unwrap();
        assert_ne!(
            fs::read(dest.join("frontend/node_modules/.pnpm/lock.yaml"))
                .await
                .unwrap(),
            fs::read(source.join("frontend/node_modules/.pnpm/lock.yaml"))
                .await
                .unwrap()
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(dest.join("frontend/node_modules/.bin/link")).unwrap(),
            Path::new("../.pnpm/lock.yaml")
        );
    }

    #[tokio::test]
    async fn absent_stale_and_mismatched_dependencies_fall_back_without_installing() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).await.unwrap();
        fixture(&source).await;
        let dest = root.path().join("dest");
        git(
            &source,
            &["clone", source.to_str().unwrap(), dest.to_str().unwrap()],
        )
        .await;
        assert!(
            clone_dependencies(&source, &dest, "frontend")
                .await
                .is_err()
        );
        warm(&source).await;
        fs::write(
            source.join("frontend/node_modules/.pnpm/lock.yaml"),
            "stale",
        )
        .await
        .unwrap();
        assert!(
            clone_dependencies(&source, &dest, "frontend")
                .await
                .unwrap_err()
                .contains("stale")
        );
        warm(&source).await;
        fs::write(dest.join("frontend/package.json"), "mismatch")
            .await
            .unwrap();
        assert!(
            clone_dependencies(&source, &dest, "frontend")
                .await
                .unwrap_err()
                .contains("mismatched")
        );
        assert!(!dest.join("frontend/node_modules").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn escaping_dependency_links_fall_back() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).await.unwrap();
        fixture(&source).await;
        warm(&source).await;
        std::os::unix::fs::symlink(&source, source.join("frontend/node_modules/escape")).unwrap();
        let dest = root.path().join("dest");
        git(
            &source,
            &["clone", source.to_str().unwrap(), dest.to_str().unwrap()],
        )
        .await;
        assert!(
            clone_dependencies(&source, &dest, "frontend")
                .await
                .unwrap_err()
                .contains("escaping")
        );
        assert!(!dest.join("frontend/node_modules").exists());
    }

    #[tokio::test]
    async fn clone_failure_leaves_no_partial_dependencies() {
        let root = tempdir().unwrap();
        let target = root.path().join("clone");
        assert!(
            clone_tree(&root.path().join("absent"), &target)
                .await
                .is_err()
        );
        assert!(!target.exists());
    }
}

#[cfg(test)]
mod measurement {
    use super::*;

    /// Opt-in, read-only source repository. All writes and deletion are confined
    /// to a throwaway shared clone under the system temporary directory.
    #[tokio::test]
    #[ignore]
    async fn measure_fresh_variant() {
        let source = std::env::var("FALCONDECK_MEASURE_PROJECT").expect("measurement source");
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        run_git(
            &source,
            &[
                "clone",
                "--shared",
                "--no-checkout",
                &source,
                project.to_str().unwrap(),
            ],
        )
        .await
        .unwrap();
        let baseline_before = crate::variant::available_disk(root.path()).await.unwrap();
        run_git(project.to_str().unwrap(), &["reset", "--hard", "HEAD"])
            .await
            .unwrap();
        let copy = tokio::process::Command::new("python3")
            .args([
                "-c",
                "import shutil,sys; shutil.copytree(sys.argv[1],sys.argv[2],symlinks=True)",
            ])
            .arg(Path::new(&source).join("frontend/node_modules"))
            .arg(project.join("frontend/node_modules"))
            .output()
            .await
            .unwrap();
        assert!(
            copy.status.success(),
            "{}",
            String::from_utf8_lossy(&copy.stderr)
        );
        let stage = project.join("frontend/node_modules");
        let orig = Path::new(&source).to_owned();
        let dest = project.clone();
        tokio::task::spawn_blocking(move || relocate_paths(&stage, &orig, &dest))
            .await
            .unwrap()
            .unwrap();
        let baseline_after = crate::variant::available_disk(root.path()).await.unwrap();
        let config = root.path().join("setup.json");
        fs::write(&config, r#"{"sparse_exclude":["data/qbank","docs/research","docs/marketing","docs/help-center"],"dependency_roots":["frontend"],"sparse_hint":"QBank and Curriculum import data/qbank; git sparse-checkout add data/qbank"}"#).await.unwrap();
        run_git(
            project.to_str().unwrap(),
            &[
                "config",
                "falcondeck.worktreeSetup",
                config.to_str().unwrap(),
            ],
        )
        .await
        .unwrap();
        let optimized_before = crate::variant::available_disk(root.path()).await.unwrap();
        let v = crate::variant::create_in_root(
            project.to_str().unwrap(),
            "measure",
            &root.path().join("variants"),
        )
        .await
        .unwrap();
        let optimized_after = crate::variant::available_disk(root.path()).await.unwrap();
        assert!(
            Path::new(&v.path)
                .join("frontend/node_modules/.pnpm/lock.yaml")
                .exists(),
            "must measure a cloned install, not a cold fallback"
        );
        assert!(!Path::new(&v.path).join("data/qbank").exists());
        let source_path = project.to_string_lossy().as_bytes().to_vec();
        let shim = fs::read(Path::new(&v.path).join("frontend/node_modules/.bin/tsc"))
            .await
            .unwrap();
        assert!(!shim.windows(source_path.len()).any(|w| w == source_path));
        println!(
            "MEASUREMENT baseline_before={baseline_before} baseline_after={baseline_after} baseline_cost={} optimized_before={optimized_before} optimized_after={optimized_after} optimized_cost={}",
            baseline_before as i128 - baseline_after as i128,
            optimized_before as i128 - optimized_after as i128
        );
        // Only this throwaway clone owns the registration. No real variants or
        // source repository refs/config/index are ever changed.
        run_git(project.to_str().unwrap(), &["worktree", "remove", &v.path])
            .await
            .unwrap();
        drop(root);
    }
}
