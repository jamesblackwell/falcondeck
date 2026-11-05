//! Optional per-project provisioning. Configuration lives outside the checkout:
//! `git config --local falcondeck.worktreeSetup /absolute/path/to/setup.json`.
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;
#[cfg(not(target_os = "macos"))]
use tokio::process::Command;

use super::run_git;
use crate::error::DaemonError;

#[derive(Default, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Setup {
    pub sparse_exclude: Vec<String>,
    pub dependency_roots: Vec<String>,
    pub sparse_hint: String,
    #[serde(skip)]
    pub patterns: Option<String>,
}

fn relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

pub(super) async fn load(project: &str) -> Result<Setup, DaemonError> {
    let Ok(path) = run_git(
        project,
        &["config", "--local", "--get", "falcondeck.worktreeSetup"],
    )
    .await
    else {
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

pub(super) async fn provision(
    project: &str,
    destination: &Path,
    setup: &Setup,
) -> Result<(), DaemonError> {
    let dest = destination.to_string_lossy();
    if let Some(patterns) = &setup.patterns {
        let mut args = vec!["sparse-checkout", "set", "--no-cone", "--"];
        args.extend(patterns.lines());
        run_git(&dest, &args).await?;
    } else if !setup.sparse_exclude.is_empty() {
        let patterns = exclusion_patterns(&setup.sparse_exclude);
        let mut args = vec!["sparse-checkout", "set", "--no-cone", "--"];
        args.extend(patterns.lines());
        run_git(&dest, &args).await?;
    } else {
        // A source worktree's sparse settings must not leak into a full variant.
        run_git(&dest, &["sparse-checkout", "disable"]).await?;
    }
    run_git(&dest, &["reset", "--hard", "HEAD"]).await?;
    let _ = project;
    Ok(())
}

fn exclusion_patterns(excluded: &[String]) -> String {
    let mut patterns = String::from("/*\n");
    for path in excluded {
        let escaped: String = path
            .chars()
            .flat_map(|c| {
                if "\\*?[]!# ".contains(c) {
                    vec!['\\', c]
                } else {
                    vec![c]
                }
            })
            .collect();
        patterns.push_str(&format!("!/{escaped}/\n"));
    }
    patterns
}

pub(super) async fn dependencies(project: &str, destination: &Path, setup: &Setup) -> Vec<String> {
    let mut messages = Vec::new();
    for root in &setup.dependency_roots {
        if let Err(error) = clone_dependencies(Path::new(project), destination, root).await {
            messages.push(format!(
                "{root}: {error}. Run the project's normal dependency install."
            ));
        }
    }
    messages
}

#[derive(Serialize, Deserialize)]
struct Recipe {
    setup: Setup,
    patterns: Option<String>,
}

async fn recipe_path(project: &str, slug: &str) -> Result<std::path::PathBuf, DaemonError> {
    if !relative(slug) || slug.contains('/') {
        return Err(DaemonError::BadRequest("invalid variant slug".into()));
    }
    let common = run_git(
        project,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    Ok(Path::new(common.trim())
        .join("falcondeck-variants")
        .join(format!("{slug}.json")))
}

pub(super) async fn restore_setup(project: &str, slug: &str) -> Result<Setup, DaemonError> {
    let path = recipe_path(project, slug).await?;
    match fs::read(path).await {
        Ok(bytes) => {
            let recipe: Recipe = serde_json::from_slice(&bytes)
                .map_err(|e| DaemonError::Rpc(format!("invalid saved worktree setup: {e}")))?;
            let mut setup = recipe.setup;
            setup.patterns = recipe.patterns;
            // No patterns means this variant was full, regardless of new project defaults.
            setup.sparse_exclude.clear();
            Ok(setup)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Legacy variants predate sparse provisioning. Missing metadata is
            // not permission to change their originally full checkout.
            let mut setup = load(project).await?;
            setup.sparse_exclude.clear();
            Ok(setup)
        }
        Err(e) => Err(DaemonError::Rpc(e.to_string())),
    }
}

pub(super) async fn save_setup(
    project: &str,
    slug: &str,
    destination: &Path,
    setup: Setup,
) -> Result<(), DaemonError> {
    let dest = destination.to_string_lossy();
    let sparse = run_git(
        &dest,
        &["config", "--worktree", "--bool", "core.sparseCheckout"],
    )
    .await
    .unwrap_or_default();
    let patterns = if sparse.trim() == "true" {
        let path = run_git(
            &dest,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/sparse-checkout",
            ],
        )
        .await?;
        Some(
            fs::read_to_string(path.trim())
                .await
                .map_err(|e| DaemonError::Rpc(e.to_string()))?,
        )
    } else {
        None
    };
    let path = recipe_path(project, slug).await?;
    let bytes = serde_json::to_vec(&Recipe { setup, patterns })
        .map_err(|e| DaemonError::Rpc(e.to_string()))?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| DaemonError::Rpc("invalid setup path".into()))?,
    )
    .await
    .map_err(|e| DaemonError::Rpc(e.to_string()))?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes)
        .await
        .map_err(|e| DaemonError::Rpc(e.to_string()))?;
    fs::rename(tmp, path)
        .await
        .map_err(|e| DaemonError::Rpc(e.to_string()))
}

pub(crate) async fn hint(project: &str, destination: &str) -> Option<String> {
    let active = run_git(
        destination,
        &["config", "--worktree", "--bool", "core.sparseCheckout"],
    )
    .await
    .ok()?;
    if active.trim() != "true" {
        return None;
    }
    let slug = Path::new(destination).file_name()?.to_str()?;
    let setup = restore_setup(project, slug).await.ok()?;
    Some(format!(
        "This checkout uses Git exclusion-based sparse checkout. If an input directory is missing, include it with `git sparse-checkout add /<directory>/`, or use `git sparse-checkout disable` for the full tree. {}",
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
fn portable_tree(path: &Path, tree: &Path, sources: &[PathBuf]) -> std::io::Result<bool> {
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
            if !portable_tree(&entry.path(), tree, sources)? {
                return Ok(false);
            }
        } else if meta.is_file() {
            let bytes = std::fs::read(entry.path())?;
            if sources.iter().any(|source| {
                memchr::memmem::find(&bytes, source.as_os_str().as_encoded_bytes()).is_some()
            }) && std::str::from_utf8(&bytes).is_err()
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
    let source_root = fs::canonicalize(source).await.map_err(|e| e.to_string())?;
    let destination_root = fs::canonicalize(destination)
        .await
        .map_err(|e| e.to_string())?;
    let from_real = fs::canonicalize(&from).await.map_err(|e| e.to_string())?;
    let to_real = fs::canonicalize(&to).await.map_err(|e| e.to_string())?;
    if !from_real.starts_with(&source_root) || !to_real.starts_with(&destination_root) {
        return Err("dependency root escapes its checkout".into());
    }
    let ignored = if root == "." {
        "node_modules/".to_string()
    } else {
        format!("{root}/node_modules/")
    };
    if run_git(
        destination.to_string_lossy().as_ref(),
        &["check-ignore", "-q", "--", &ignored],
    )
    .await
    .is_err()
    {
        return Err("node_modules is not ignored in the destination checkout".into());
    }

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
    let modules_real = fs::canonicalize(&modules)
        .await
        .map_err(|e| e.to_string())?;
    if !modules_real.starts_with(&source_root) {
        return Err("warm node_modules escapes its checkout".into());
    }
    let mut sources = vec![source.to_owned()];
    if sources[0] != source_root {
        sources.push(source_root);
    }
    let source_check = sources.clone();
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
    // Keep private install staging out of git add -A and the file browser.
    // A UI commit may run while dependencies are still being cloned.
    let staging = dependency_staging_path(destination).await?;
    let result = clone_tree(&modules, &staging).await;
    if result.is_ok() {
        let stage = staging.clone();
        let dest = destination.to_owned();
        let relocate = tokio::task::spawn_blocking(move || relocate_paths(&stage, &sources, &dest))
            .await
            .map_err(|e| e.to_string())?;
        if let Err(error) = relocate {
            let _ = fs::remove_dir_all(&staging).await;
            return Err(error.to_string());
        }
        // The source may have changed while clonefile walked the tree.
        if !matching_inputs(&from, &to).await
            || (root != "." && !matching_inputs_optional_root(source, destination).await)
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

async fn dependency_staging_path(destination: &Path) -> Result<PathBuf, String> {
    let git_dir = run_git(
        destination.to_string_lossy().as_ref(),
        &["rev-parse", "--absolute-git-dir"],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(Path::new(git_dir.trim()).join(format!("falcondeck-deps-{}", uuid::Uuid::new_v4())))
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

fn relocate_paths(path: &Path, sources: &[PathBuf], destination: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            relocate_paths(&entry.path(), sources, destination)?;
        } else if kind.is_file() {
            let bytes = std::fs::read(entry.path())?;
            if sources.iter().any(|source| {
                memchr::memmem::find(&bytes, source.as_os_str().as_encoded_bytes()).is_some()
            }) {
                let mut text = String::from_utf8(bytes).map_err(std::io::Error::other)?;
                for source in sources {
                    text = relocate_text(
                        &text,
                        source.to_string_lossy().as_ref(),
                        destination.to_string_lossy().as_ref(),
                    );
                }
                std::fs::write(entry.path(), text)?;
            }
        }
    }
    Ok(())
}

fn relocate_text(text: &str, source: &str, destination: &str) -> String {
    let mut out = String::new();
    let mut consumed = 0;
    for (index, _) in text.match_indices(source) {
        let end = index + source.len();
        let before = text[..index].chars().next_back();
        let after = text[end..].chars().next();
        let boundary = |c: char| c.is_whitespace() || "\"'=:([]);".contains(c);
        if (before.is_none_or(boundary) || text[..index].ends_with("file://"))
            && after.is_none_or(|c| c == '/' || boundary(c))
        {
            out.push_str(&text[consumed..index]);
            out.push_str(destination);
            consumed = end;
        }
    }
    out.push_str(&text[consumed..]);
    out
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
            .kill_on_drop(true)
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
        fs::write(path, r#"{"sparse_exclude":["data/qbank","docs/research","docs/marketing","docs/help-center"],"dependency_roots":["frontend"],"sparse_hint":"QBank and Curriculum services need data/qbank: git sparse-checkout add /data/qbank/"}"#).await.unwrap();
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
                .contains("git sparse-checkout add /data/qbank/")
        );
        git(dest, &["sparse-checkout", "add", "/data/qbank/"]).await;
        assert!(dest.join("data/qbank/file").exists());
        // A main change outside the sparse tree can still merge from it.
        fs::write(project.join("docs/research/file"), "new research")
            .await
            .unwrap();
        git(&project, &["add", "."]).await;
        git(&project, &["commit", "-m", "research"]).await;
        git(dest, &["merge", "main"]).await;
        assert!(!dest.join("docs/research").exists());
        let _ = crate::variant::wait_dependencies(&v.path).await;
        let recipe = restore_setup(project.to_str().unwrap(), &v.slug)
            .await
            .unwrap();
        save_setup(project.to_str().unwrap(), &v.slug, dest, recipe)
            .await
            .unwrap();
        git(&project, &["worktree", "remove", &v.path]).await;
        assert_eq!(restore(project.to_str().unwrap(), &v).await, Ok(true));
        assert!(dest.join("data/qbank/file").exists());
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
    #[tokio::test]
    async fn exclusion_sparse_allows_new_folders_add_commit_merge_and_preserves_added_paths() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        config(&project, &root.path().join("setup.json")).await;
        let v = create_in_root(
            project.to_str().unwrap(),
            "new-folders",
            &root.path().join("variants"),
        )
        .await
        .unwrap();
        let path = Path::new(&v.path);
        for name in ["docs/new-design/note", "data/new-input/value"] {
            fs::create_dir_all(path.join(name).parent().unwrap())
                .await
                .unwrap();
            fs::write(path.join(name), "new work").await.unwrap();
        }
        git(path, &["add", "docs/new-design"]).await;
        let commit = crate::ship::commit_checkout(&v.path, "new folders")
            .await
            .unwrap();
        let _ = commit;
        assert!(git(path, &["status", "--porcelain"]).await.is_empty());
        fs::create_dir_all(project.join("docs/new-upstream"))
            .await
            .unwrap();
        fs::write(project.join("docs/new-upstream/file"), "upstream")
            .await
            .unwrap();
        git(&project, &["add", "."]).await;
        git(&project, &["commit", "-m", "new upstream directory"]).await;
        git(
            path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "merge",
                "--no-edit",
                "main",
            ],
        )
        .await;
        assert!(path.join("docs/new-upstream/file").exists());
        assert!(!path.join("data/qbank").exists());
        git(path, &["sparse-checkout", "add", "/data/qbank/"]).await;
        assert!(path.join("data/qbank/file").exists());
        let saved = restore_setup(project.to_str().unwrap(), &v.slug)
            .await
            .unwrap();
        save_setup(project.to_str().unwrap(), &v.slug, path, saved)
            .await
            .unwrap();
        git(&project, &["worktree", "remove", &v.path]).await;
        assert_eq!(restore(project.to_str().unwrap(), &v).await, Ok(true));
        assert!(path.join("data/qbank/file").exists());
        assert!(path.join("docs/new-upstream/file").exists());
    }

    #[tokio::test]
    async fn full_variant_stays_full_when_project_defaults_change() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        let v = create_in_root(
            project.to_str().unwrap(),
            "full",
            &root.path().join("variants"),
        )
        .await
        .unwrap();
        config(&project, &root.path().join("setup.json")).await;
        git(&project, &["worktree", "remove", &v.path]).await;
        restore(project.to_str().unwrap(), &v).await.unwrap();
        assert!(Path::new(&v.path).join("data/qbank/file").exists());
    }

    #[tokio::test]
    async fn global_setup_configuration_is_ignored() {
        if let Ok(project) = std::env::var("FALCONDECK_SCOPE_TEST_PROJECT") {
            assert!(load(&project).await.unwrap().sparse_exclude.is_empty());
            return;
        }
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        let global = root.path().join("global.gitconfig");
        fs::write(
            &global,
            "[falcondeck]\nworktreeSetup = /nonexistent/global-setup.json\n",
        )
        .await
        .unwrap();
        let child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "variant::setup::tests::global_setup_configuration_is_ignored",
            ])
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("FALCONDECK_SCOPE_TEST_PROJECT", &project)
            .output()
            .await
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
        assert!(String::from_utf8_lossy(&child.stdout).contains("running 1 test"));
    }

    #[test]
    fn relocation_does_not_rewrite_another_checkout_with_the_same_prefix() {
        assert_eq!(
            relocate_text(
                "/repo/quizgecko/node_modules:/repo/quizgecko-old/node_modules",
                "/repo/quizgecko",
                "/repo/variant"
            ),
            "/repo/variant/node_modules:/repo/quizgecko-old/node_modules"
        );
    }
    #[tokio::test]
    async fn new_full_checkout_does_not_change_a_sparse_main_checkout() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        git(
            &project,
            &["sparse-checkout", "set", "--no-cone", "/*", "!/data/qbank/"],
        )
        .await;
        assert!(!project.join("data/qbank").exists());
        let v = create_in_root(
            project.to_str().unwrap(),
            "full-default",
            &root.path().join("variants"),
        )
        .await
        .unwrap();
        assert!(Path::new(&v.path).join("data/qbank/file").exists());
        assert!(!project.join("data/qbank").exists());
        assert!(git(&project, &["status", "--porcelain"]).await.is_empty());
    }

    #[tokio::test]
    async fn legacy_full_checkout_does_not_inherit_new_sparse_defaults_on_restore() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        let dest = root.path().join("legacy");
        git(
            &project,
            &[
                "worktree",
                "add",
                "-b",
                "falcondeck/legacy",
                dest.to_str().unwrap(),
            ],
        )
        .await;
        config(&project, &root.path().join("setup.json")).await;
        git(&project, &["worktree", "remove", dest.to_str().unwrap()]).await;
        let v = falcondeck_core::ThreadVariant {
            slug: "legacy".into(),
            path: dest.to_string_lossy().into_owned(),
            branch: "falcondeck/legacy".into(),
            kind: falcondeck_core::ThreadVariantKind::Worktree,
            base_branch: Some("main".into()),
        };
        restore(project.to_str().unwrap(), &v).await.unwrap();
        assert!(dest.join("data/qbank/file").exists());
        let _ = crate::variant::wait_dependencies(&v.path).await;
    }
    #[tokio::test]
    async fn dependency_staging_cannot_be_committed_by_add_all() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        fixture(&project).await;
        let v = create_in_root(
            project.to_str().unwrap(),
            "staging",
            &root.path().join("variants"),
        )
        .await
        .unwrap();
        let stage = dependency_staging_path(Path::new(&v.path)).await.unwrap();
        fs::create_dir(&stage).await.unwrap();
        fs::write(stage.join("huge-dependency.js"), "private clone data")
            .await
            .unwrap();
        assert!(
            git(Path::new(&v.path), &["status", "--porcelain"])
                .await
                .is_empty()
        );
        fs::write(Path::new(&v.path).join("frontend/file"), "authored change")
            .await
            .unwrap();
        crate::ship::commit_checkout(&v.path, "authored change only")
            .await
            .unwrap();
        assert!(
            !git(Path::new(&v.path), &["ls-files"])
                .await
                .contains("huge-dependency")
        );
    }
}

#[cfg(test)]
mod measurement {
    use super::*;

    /// Synthetic physical-copy baseline, NOT representative of pnpm APFS imports.
    /// It cannot establish marginal savings over existing real variants.
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
        tokio::task::spawn_blocking(move || relocate_paths(&stage, &[orig], &dest))
            .await
            .unwrap()
            .unwrap();
        let baseline_after = crate::variant::available_disk(root.path()).await.unwrap();
        let config = root.path().join("setup.json");
        fs::write(&config, r#"{"sparse_exclude":["data/qbank","docs/research","docs/marketing","docs/help-center"],"dependency_roots":["frontend"],"sparse_hint":"QBank and Curriculum import data/qbank; git sparse-checkout add /data/qbank/"}"#).await.unwrap();
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
        let _ = crate::variant::wait_dependencies(&v.path).await;
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
