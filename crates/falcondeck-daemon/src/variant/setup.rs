//! Dependency sharing and project setup for new variants.
//!
//! A bare worktree has no installed dependencies, so every variant used to
//! end up with its own `node_modules` once the agent ran an install (about
//! 3 GB for Quizgecko: `frontend` plus `mobile-expo`). After creating or
//! restoring a variant the daemon now does one of two things:
//!
//! 1. Runs the project's own setup script when the checkout carries one
//!    (`.falcondeck/setup-worktree.sh`, else Codex's
//!    `.codex/scripts/setup-worktree.sh`). The script owns dependency handling.
//! 2. Otherwise, or when the script fails, symlinks `node_modules` from the
//!    project folder, but only where sharing is provably equivalent.
//!
//! The rules and rationale are in `docs/WORKTREES.md`. Everything here is
//! best-effort: a variant without shared dependencies still works, the agent
//! just installs its own.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::{fs, io::AsyncWriteExt, process::Command, time::timeout};

use super::run_git;

/// Project-provided setup scripts, in precedence order, relative to the
/// variant root. Run through `bash`, so the executable bit is irrelevant.
const SETUP_SCRIPTS: &[&str] = &[
    ".falcondeck/setup-worktree.sh",
    ".codex/scripts/setup-worktree.sh",
];

const SCRIPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Files that decide what an install produces. A shared `node_modules` is
/// only equivalent while every one of these matches the project folder.
const MANIFESTS: &[&str] = &[
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
];

const MAX_PACKAGE_DIRS: usize = 32;

const EXCLUDE_HEADER: &str = "# FalconDeck: dependency links shared into isolated copies";

/// Prepares a freshly created or restored variant. Never fails the caller.
pub(super) async fn prepare(project_path: &str, destination: &Path, slug: &str) {
    prepare_with_timeout(project_path, destination, slug, SCRIPT_TIMEOUT).await;
}

async fn prepare_with_timeout(
    project_path: &str,
    destination: &Path,
    slug: &str,
    script_timeout: Duration,
) {
    let scripted = match find_script(destination) {
        Some(script) => run_script(&script, project_path, destination, slug, script_timeout).await,
        None => false,
    };

    let dirs = package_dirs(destination).await;
    if !scripted {
        let project = PathBuf::from(project_path);
        let target = destination.to_path_buf();
        let candidates = dirs.clone();
        let linked = tokio::task::spawn_blocking(move || {
            link_shared_dependencies(&project, &target, &candidates)
        })
        .await
        .unwrap_or_default();
        if !linked.is_empty() {
            tracing::info!(variant = %destination.display(), ?linked, "shared dependencies into isolated copy");
        }
    }
    exclude_dependency_links(project_path, destination, &dirs).await;
}

fn find_script(destination: &Path) -> Option<PathBuf> {
    SETUP_SCRIPTS
        .iter()
        .map(|relative| destination.join(relative))
        .find(|path| path.is_file())
}

/// Runs a project setup script in the variant. True only on a clean exit; any
/// other outcome lets the built-in linking fill the gap.
///
/// The script runs in its own process group and the whole group is killed on
/// any unsuccessful outcome. Killing just `bash` would leave a delegated
/// installer running, and it could then write through the dependency links the
/// fallback creates into the project folder's install.
async fn run_script(
    script: &Path,
    project_path: &str,
    destination: &Path,
    slug: &str,
    limit: Duration,
) -> bool {
    let mut command = Command::new("bash");
    command
        .arg(script)
        .current_dir(destination)
        .env("FALCONDECK_PROJECT_PATH", project_path)
        .env("FALCONDECK_VARIANT_PATH", destination)
        .env("FALCONDECK_VARIANT_SLUG", slug)
        // The Codex script reads these two.
        .env("CODEX_ROOT_PATH", project_path)
        .env("CODEX_WORKTREE_PATH", destination)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(script = %script.display(), %error, "variant setup script could not run");
            return false;
        }
    };
    let group = child.id();
    let succeeded = match timeout(limit, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => true,
        Ok(Ok(output)) => {
            tracing::warn!(
                script = %script.display(),
                code = ?output.status.code(),
                stderr = %tail(&output.stderr),
                "variant setup script failed; falling back to built-in dependency sharing"
            );
            false
        }
        Ok(Err(error)) => {
            tracing::warn!(script = %script.display(), %error, "variant setup script could not run");
            false
        }
        Err(_) => {
            tracing::warn!(
                script = %script.display(),
                seconds = limit.as_secs_f32(),
                "variant setup script timed out; falling back to built-in dependency sharing"
            );
            false
        }
    };
    if !succeeded {
        kill_process_group(group);
    }
    succeeded
}

/// SIGKILLs the process group led by `leader`, which `run_script` spawned
/// with `process_group(0)`, so the group id is the leader's pid.
fn kill_process_group(leader: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = leader.and_then(|id| libc::pid_t::try_from(id).ok()) {
        // SAFETY: plain syscall on a group this function's caller created.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = leader;
}

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let start = text.len().saturating_sub(400);
    let start = (start..=text.len())
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(text.len());
    text[start..].to_string()
}

/// Directories (relative to the variant root, `""` for the root) holding a
/// tracked `package.json`: the places a `node_modules` can belong to.
async fn package_dirs(destination: &Path) -> Vec<String> {
    let Ok(listing) = run_git(
        &destination.to_string_lossy(),
        &["ls-files", "-z", "--", ":(glob)**/package.json"],
    )
    .await
    else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = listing
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .filter(|entry| !entry.split('/').any(|segment| segment == "node_modules"))
        .map(|entry| {
            entry
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_string())
                .unwrap_or_default()
        })
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs.truncate(MAX_PACKAGE_DIRS);
    dirs
}

fn node_modules_path(dir: &str) -> String {
    if dir.is_empty() {
        "node_modules".to_string()
    } else {
        format!("{dir}/node_modules")
    }
}

/// Symlinks `node_modules` from the project folder wherever it is safe.
/// Returns the links created, as variant-relative paths.
fn link_shared_dependencies(project: &Path, destination: &Path, dirs: &[String]) -> Vec<String> {
    let workspace_roots: Vec<&str> = dirs
        .iter()
        .filter(|dir| is_workspace_root(&destination.join(dir.as_str())))
        .map(String::as_str)
        .collect();

    let mut linked = Vec::new();
    for dir in dirs {
        // An install at a workspace root also manages the packages beneath
        // it, so none of that tree is shared.
        if workspace_roots
            .iter()
            .any(|root| root.is_empty() || dir == root || dir.starts_with(&format!("{root}/")))
        {
            continue;
        }
        match link_one(project, destination, dir) {
            Ok(Some(link)) => linked.push(link),
            Ok(None) => {}
            Err(reason) => {
                tracing::info!(
                    variant = %destination.display(),
                    dir = %node_modules_path(dir),
                    %reason,
                    "left dependencies unshared; the agent will install its own"
                );
            }
        }
    }
    linked
}

/// True when an install in `dir` also manages other packages: npm, yarn and
/// bun declare `"workspaces"` in `package.json`; pnpm lists members under
/// `packages:` in `pnpm-workspace.yaml`. A pnpm file that is settings-only or
/// lists just `.` (Quizgecko's `mobile-expo`) is a single package.
fn is_workspace_root(dir: &Path) -> bool {
    let declared = std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|manifest| manifest.get("workspaces").is_some());
    declared
        || std::fs::read_to_string(dir.join("pnpm-workspace.yaml"))
            .is_ok_and(|text| pnpm_workspace_has_members(&text))
}

/// Reads the `packages:` list of a `pnpm-workspace.yaml` without a YAML
/// parser: block (`- "apps/*"`) or flow (`[apps/*]`) entries, ignoring `.`
/// (the root itself) and `!` exclusions.
fn pnpm_workspace_has_members(yaml: &str) -> bool {
    let mut in_packages = false;
    let mut entries: Vec<String> = Vec::new();
    for raw in yaml.lines() {
        let line = raw.split('#').next().unwrap_or("");
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            in_packages = line.trim_end().starts_with("packages:");
            if in_packages {
                let rest = line.trim_end()["packages:".len()..].trim();
                entries.extend(rest.trim_matches(['[', ']']).split(',').map(str::to_string));
            }
        } else if in_packages && let Some(item) = line.trim().strip_prefix('-') {
            entries.push(item.to_string());
        }
    }
    entries
        .iter()
        .map(|entry| entry.trim().trim_matches(['"', '\'']).trim())
        .any(|entry| !entry.is_empty() && !entry.starts_with('!') && entry != "." && entry != "./")
}

fn link_one(project: &Path, destination: &Path, dir: &str) -> Result<Option<String>, String> {
    let relative = node_modules_path(dir);
    let source = project.join(&relative);
    let target = destination.join(&relative);

    // Nothing to share, or the variant already has its own (a script or the
    // branch provided it): leave it alone.
    if !source.is_dir() || target.symlink_metadata().is_ok() {
        return Ok(None);
    }
    for name in MANIFESTS {
        if !same_contents(
            &project.join(dir).join(name),
            &destination.join(dir).join(name),
        ) {
            return Err(format!("{name} differs from the project folder"));
        }
    }
    only_internal_links(&source)?;
    let source = std::fs::canonicalize(&source).map_err(|error| error.to_string())?;
    symlink_dir(&source, &target).map_err(|error| format!("could not link: {error}"))?;
    Ok(Some(relative))
}

fn same_contents(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(left), Ok(right)) => left == right,
        (Err(left), Err(right)) => {
            left.kind() == std::io::ErrorKind::NotFound
                && right.kind() == std::io::ErrorKind::NotFound
        }
        _ => false,
    }
}

/// A `node_modules` whose top-level links leave the directory (workspace
/// packages, `file:` dependencies) would resolve into the project folder's
/// source from inside the variant, so tests would run against the wrong
/// code. Links inside it (pnpm's virtual store) are fine. `.bin` holds
/// relative links into the packages and is skipped.
fn only_internal_links(node_modules: &Path) -> Result<(), String> {
    let root = std::fs::canonicalize(node_modules).map_err(|error| error.to_string())?;
    let entries = std::fs::read_dir(node_modules).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            check_link(&root, &entry.path(), &name)?;
        } else if kind.is_dir()
            && name.starts_with('@')
            && let Ok(scoped) = std::fs::read_dir(entry.path())
        {
            for inner in scoped.flatten() {
                if inner.file_type().is_ok_and(|kind| kind.is_symlink()) {
                    let label = format!("{name}/{}", inner.file_name().to_string_lossy());
                    check_link(&root, &inner.path(), &label)?;
                }
            }
        }
    }
    Ok(())
}

fn check_link(root: &Path, link: &Path, label: &str) -> Result<(), String> {
    match std::fs::canonicalize(link) {
        Ok(real) if !real.starts_with(root) => Err(format!(
            "{label} links outside node_modules (workspace or file: dependency)"
        )),
        // Dangling links are already broken in the project folder.
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn symlink_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(not(unix))]
fn symlink_dir(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "dependency links need a Unix filesystem",
    ))
}

/// Keeps symlinked `node_modules` out of `git status`. A `.gitignore` entry
/// written as `node_modules/` matches directories only, so a link would show
/// as untracked, get swept into `git add -A`, and block reclaiming the
/// checkout. `info/exclude` lives in the shared git dir (git has no
/// per-worktree exclude file); an anchored entry for a path that is already
/// ignored in the project folder changes nothing there.
async fn exclude_dependency_links(project_path: &str, destination: &Path, dirs: &[String]) {
    let links: Vec<String> = dirs
        .iter()
        .map(|dir| node_modules_path(dir))
        .filter(|relative| {
            destination
                .join(relative)
                .symlink_metadata()
                .is_ok_and(|meta| meta.file_type().is_symlink())
        })
        .collect();
    if links.is_empty() {
        return;
    }
    let Ok(path) = run_git(
        project_path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    )
    .await
    else {
        return;
    };
    let path = PathBuf::from(path.trim());
    let existing = fs::read_to_string(&path).await.unwrap_or_default();
    let mut additions = String::new();
    if !existing.lines().any(|line| line == EXCLUDE_HEADER) {
        additions.push_str(EXCLUDE_HEADER);
        additions.push('\n');
    }
    for relative in links {
        let entry = format!("/{relative}");
        if !existing.lines().any(|line| line == entry) {
            additions.push_str(&entry);
            additions.push('\n');
        }
    }
    if additions.is_empty() || additions == format!("{EXCLUDE_HEADER}\n") {
        return;
    }
    if !existing.is_empty() && !existing.ends_with('\n') {
        additions.insert(0, '\n');
    }
    let write = async {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        file.write_all(additions.as_bytes()).await
    };
    if let Err(error) = write.await {
        tracing::warn!(path = %path.display(), %error, "failed to exclude dependency links from git status");
    }
}

#[cfg(test)]
mod tests {
    use super::super::{create_in_root, remove};
    use super::*;
    use tempfile::{TempDir, tempdir};

    struct Project {
        _dir: TempDir,
        variants: TempDir,
        path: PathBuf,
    }

    impl Project {
        fn str(&self) -> &str {
            self.path.to_str().unwrap()
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.path.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }

        fn install(&self, dir: &str, package: &str) {
            self.write(
                &format!("{}/{package}/index.js", node_modules_path(dir)),
                "module.exports = 1;\n",
            );
        }

        async fn variant(&self, slug: &str) -> falcondeck_core::ThreadVariant {
            create_in_root(self.str(), slug, self.variants.path())
                .await
                .unwrap()
        }
    }

    async fn project(files: &[(&str, &str)]) -> Project {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let cwd = path.to_str().unwrap().to_string();
        let cwd = cwd.as_str();
        run_git(cwd, &["init", "-b", "main"]).await.unwrap();
        run_git(cwd, &["config", "user.email", "t@example.com"])
            .await
            .unwrap();
        run_git(cwd, &["config", "user.name", "Test"])
            .await
            .unwrap();
        let project = Project {
            _dir: dir,
            variants: tempdir().unwrap(),
            path,
        };
        // Trailing slash on purpose: it does not match a symlink.
        project.write(".gitignore", "node_modules/\nvendor/\n.env\n");
        for (relative, contents) in files {
            project.write(relative, contents);
        }
        run_git(cwd, &["add", "."]).await.unwrap();
        run_git(cwd, &["commit", "-m", "initial"]).await.unwrap();
        project
    }

    fn is_link(path: &Path) -> bool {
        path.symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_symlink())
    }

    const FRONTEND: &[(&str, &str)] = &[
        ("frontend/package.json", "{\"name\":\"frontend\"}\n"),
        ("frontend/package-lock.json", "{\"lockfileVersion\":3}\n"),
    ];

    #[tokio::test]
    async fn links_node_modules_instead_of_copying_them() {
        let project = project(FRONTEND).await;
        project.install("frontend", "left-pad");

        let variant = project.variant("share001").await;
        let link = Path::new(&variant.path).join("frontend/node_modules");

        assert!(is_link(&link), "node_modules must be a symlink");
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            std::fs::canonicalize(project.path.join("frontend/node_modules")).unwrap()
        );
        assert!(link.join("left-pad/index.js").is_file());
        assert_eq!(
            run_git(&variant.path, &["status", "--porcelain"])
                .await
                .unwrap(),
            "",
            "a dependency link must not appear in git status"
        );
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn excluding_links_is_idempotent_across_variants() {
        let project = project(FRONTEND).await;
        project.install("frontend", "left-pad");

        let first = project.variant("idem0001").await;
        let second = project.variant("idem0002").await;

        let exclude = std::fs::read_to_string(project.path.join(".git/info/exclude")).unwrap();
        assert_eq!(
            exclude
                .lines()
                .filter(|line| *line == "/frontend/node_modules")
                .count(),
            1,
            "exclude file: {exclude}"
        );
        remove(project.str(), &first).await;
        remove(project.str(), &second).await;
    }

    #[tokio::test]
    async fn removing_a_variant_keeps_the_project_dependencies() {
        let project = project(FRONTEND).await;
        project.install("frontend", "left-pad");

        let variant = project.variant("keep0001").await;
        remove(project.str(), &variant).await;

        assert!(!Path::new(&variant.path).exists());
        assert!(
            project
                .path
                .join("frontend/node_modules/left-pad/index.js")
                .is_file(),
            "deleting a variant must never delete the shared directory"
        );
    }

    #[tokio::test]
    async fn skips_sharing_when_the_lockfile_differs() {
        let project = project(FRONTEND).await;
        project.install("frontend", "left-pad");
        // An uncommitted upgrade in the project folder: HEAD has the old lock.
        project.write("frontend/package-lock.json", "{\"lockfileVersion\":99}\n");

        let variant = project.variant("lock0001").await;

        assert!(
            !Path::new(&variant.path)
                .join("frontend/node_modules")
                .exists()
        );
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn skips_workspace_roots_and_everything_beneath_them() {
        let project = project(&[
            ("package.json", "{\"workspaces\":[\"apps/*\"]}\n"),
            ("apps/web/package.json", "{\"name\":\"web\"}\n"),
        ])
        .await;
        project.install("", "react");
        project.install("apps/web", "vite");

        let variant = project.variant("work0001").await;
        let root = Path::new(&variant.path);

        assert!(!root.join("node_modules").exists());
        assert!(!root.join("apps/web/node_modules").exists());
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn skips_pnpm_workspace_roots_but_shares_self_only_pnpm_packages() {
        let workspace = project(&[
            ("package.json", "{\"name\":\"root\"}\n"),
            ("pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n"),
            ("apps/web/package.json", "{\"name\":\"web\"}\n"),
        ])
        .await;
        workspace.install("", "react");
        workspace.install("apps/web", "vite");
        let variant = workspace.variant("pnws0001").await;
        let root = Path::new(&variant.path);
        assert!(!root.join("node_modules").exists());
        assert!(!root.join("apps/web/node_modules").exists());
        remove(workspace.str(), &variant).await;

        // Quizgecko's mobile-expo: settings plus `packages: - .`.
        let single = project(&[
            ("mobile/package.json", "{\"name\":\"mobile\"}\n"),
            (
                "mobile/pnpm-workspace.yaml",
                "packages:\n  - .\n\noverrides:\n  fast-uri: ^3.1.5\n",
            ),
        ])
        .await;
        single.install("mobile", "expo");
        let variant = single.variant("pnws0002").await;
        assert!(is_link(
            &Path::new(&variant.path).join("mobile/node_modules")
        ));
        remove(single.str(), &variant).await;
    }

    #[test]
    fn pnpm_workspace_members_are_read_from_block_and_flow_lists() {
        assert!(pnpm_workspace_has_members("packages:\n  - 'apps/*'\n"));
        assert!(pnpm_workspace_has_members("packages: [\"a\", \"b\"]\n"));
        assert!(pnpm_workspace_has_members(
            "packages:\n  - .\n  - sub # note\n"
        ));
        assert!(!pnpm_workspace_has_members("packages:\n  - .\n"));
        assert!(!pnpm_workspace_has_members("packages: ['.']\n"));
        assert!(!pnpm_workspace_has_members("packages:\n  - '!ignored'\n"));
        assert!(!pnpm_workspace_has_members("minimumReleaseAge: 1\n"));
        // A list under a different key is not the member list.
        assert!(!pnpm_workspace_has_members(
            "onlyBuiltDependencies:\n  - protobufjs\n"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn skips_node_modules_that_link_out_to_project_source() {
        let project = project(FRONTEND).await;
        project.install("frontend", "left-pad");
        project.write("frontend/shared/index.js", "// source\n");
        let scope = project.path.join("frontend/node_modules/@acme");
        std::fs::create_dir_all(&scope).unwrap();
        std::os::unix::fs::symlink("../../shared", scope.join("shared")).unwrap();

        let variant = project.variant("escp0001").await;

        assert!(
            !Path::new(&variant.path)
                .join("frontend/node_modules")
                .exists()
        );
        remove(project.str(), &variant).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shares_pnpm_style_node_modules_with_internal_links() {
        let project = project(FRONTEND).await;
        project.install("frontend", ".pnpm/axios@1/node_modules/axios");
        std::os::unix::fs::symlink(
            ".pnpm/axios@1/node_modules/axios",
            project.path.join("frontend/node_modules/axios"),
        )
        .unwrap();

        let variant = project.variant("pnpm0001").await;

        assert!(is_link(
            &Path::new(&variant.path).join("frontend/node_modules")
        ));
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn never_links_composer_vendor() {
        let project = project(&[("composer.json", "{}\n")]).await;
        project.write("vendor/autoload.php", "<?php\n");

        let variant = project.variant("php00001").await;

        assert!(
            !Path::new(&variant.path).join("vendor").exists(),
            "composer autoloaders resolve app code relative to vendor/'s real path"
        );
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn leaves_projects_without_dependencies_alone() {
        let project = project(FRONTEND).await;

        let variant = project.variant("none0001").await;

        assert!(
            !Path::new(&variant.path)
                .join("frontend/node_modules")
                .exists()
        );
        let exclude =
            std::fs::read_to_string(project.path.join(".git/info/exclude")).unwrap_or_default();
        assert!(!exclude.contains("node_modules"), "exclude file: {exclude}");
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn runs_the_project_script_and_skips_built_in_linking() {
        let project = project(&[
            FRONTEND[0],
            FRONTEND[1],
            (
                ".falcondeck/setup-worktree.sh",
                "set -e\n\
                 mkdir -p frontend/node_modules\n\
                 echo own > frontend/node_modules/own\n\
                 printf '%s\\n' \"$(pwd -P)\" \"$FALCONDECK_PROJECT_PATH\" \"$FALCONDECK_VARIANT_PATH\" \
                   \"$FALCONDECK_VARIANT_SLUG\" \"$CODEX_ROOT_PATH\" \"$CODEX_WORKTREE_PATH\" > setup.out\n",
            ),
        ])
        .await;
        project.install("frontend", "left-pad");

        let variant = project.variant("scrp0001").await;
        let root = Path::new(&variant.path);

        assert!(
            !is_link(&root.join("frontend/node_modules")),
            "a successful script owns dependency handling"
        );
        let recorded = std::fs::read_to_string(root.join("setup.out")).unwrap();
        let recorded: Vec<&str> = recorded.lines().collect();
        assert_eq!(
            recorded,
            vec![
                std::fs::canonicalize(root).unwrap().to_str().unwrap(),
                project.str(),
                variant.path.as_str(),
                "scrp0001",
                project.str(),
                variant.path.as_str(),
            ]
        );
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn honours_the_codex_script_and_prefers_the_falcondeck_one() {
        let codex = "touch ran-codex\n";
        let falcondeck = "touch ran-falcondeck\n";

        let only_codex = project(&[(".codex/scripts/setup-worktree.sh", codex)]).await;
        let variant = only_codex.variant("cdx00001").await;
        assert!(Path::new(&variant.path).join("ran-codex").is_file());
        remove(only_codex.str(), &variant).await;

        let both = project(&[
            (".codex/scripts/setup-worktree.sh", codex),
            (".falcondeck/setup-worktree.sh", falcondeck),
        ])
        .await;
        let variant = both.variant("both0001").await;
        let root = Path::new(&variant.path);
        assert!(root.join("ran-falcondeck").is_file());
        assert!(!root.join("ran-codex").exists());
        remove(both.str(), &variant).await;
    }

    #[tokio::test]
    async fn falls_back_to_linking_when_the_script_fails() {
        let project = project(&[
            FRONTEND[0],
            FRONTEND[1],
            (".falcondeck/setup-worktree.sh", "exit 3\n"),
        ])
        .await;
        project.install("frontend", "left-pad");

        let variant = project.variant("fail0001").await;

        assert!(is_link(
            &Path::new(&variant.path).join("frontend/node_modules")
        ));
        remove(project.str(), &variant).await;
    }

    #[tokio::test]
    async fn falls_back_to_linking_when_the_script_hangs() {
        let project = project(&[
            FRONTEND[0],
            FRONTEND[1],
            (".falcondeck/setup-worktree.sh", "exec sleep 30\n"),
        ])
        .await;
        project.install("frontend", "left-pad");

        let root = project.variants.path().join("hang0001");
        run_git(
            project.str(),
            &[
                "worktree",
                "add",
                "-b",
                "hang0001",
                root.to_str().unwrap(),
                "HEAD",
            ],
        )
        .await
        .unwrap();
        let started = std::time::Instant::now();
        prepare_with_timeout(project.str(), &root, "hang0001", Duration::from_millis(200)).await;

        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(is_link(&root.join("frontend/node_modules")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timed_out_script_leaves_no_running_descendants() {
        let project = project(&[(
            ".falcondeck/setup-worktree.sh",
            "sleep 30 &\necho $! > child.pid\nwait\n",
        )])
        .await;
        let root = project.variants.path().join("kill0001");
        run_git(
            project.str(),
            &[
                "worktree",
                "add",
                "-b",
                "kill0001",
                root.to_str().unwrap(),
                "HEAD",
            ],
        )
        .await
        .unwrap();

        prepare_with_timeout(project.str(), &root, "kill0001", Duration::from_millis(500)).await;

        let pid = std::fs::read_to_string(root.join("child.pid"))
            .unwrap()
            .trim()
            .to_string();
        let alive = || {
            std::process::Command::new("kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        for _ in 0..50 {
            if !alive() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("setup descendant {pid} survived the timeout");
    }

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        let text = format!("{}é", "x".repeat(500));
        let out = tail(text.as_bytes());
        assert!(out.ends_with('é'));
        assert!(out.len() <= 402);
    }
}
