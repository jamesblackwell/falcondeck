//! Private persistence for cloud configuration and job artifacts.

use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

use serde::{Serialize, de::DeserializeOwned};

use crate::error::DaemonError;

fn storage_error() -> DaemonError {
    // Paths, OS errors, and serde errors may contain private source or credentials.
    DaemonError::Process("Cloud storage could not be read or written safely".into())
}

pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, DaemonError> {
    let Some(mut file) = private_file::open_read(path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| storage_error())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| storage_error())
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), DaemonError> {
    let bytes = serde_json::to_vec(value).map_err(|_| storage_error())?;
    private_file::replace(path, &bytes)
}

#[cfg(unix)]
mod private_file {
    use super::*;
    use std::{
        ffi::CString,
        fs::{DirBuilder, OpenOptions},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            },
        },
    };

    fn filename(path: &Path) -> Result<CString, DaemonError> {
        CString::new(path.file_name().ok_or_else(storage_error)?.as_bytes())
            .map_err(|_| storage_error())
    }

    fn parent(path: &Path, create: bool) -> Result<Option<File>, DaemonError> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(storage_error)?;
        match std::fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(storage_error()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
                return Ok(None);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(parent)
                    .map_err(|_| storage_error())?;
            }
            Err(_) => return Err(storage_error()),
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)
            .map_err(|_| storage_error())?;
        let metadata = directory.metadata().map_err(|_| storage_error())?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(storage_error());
        }
        // Apply permissions through the verified descriptor, never through a path
        // that could have become a symlink since the ownership check.
        directory
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|_| storage_error())?;
        Ok(Some(directory))
    }

    fn check_file(file: &File) -> Result<(), DaemonError> {
        let metadata = file.metadata().map_err(|_| storage_error())?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err(storage_error());
        }
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| storage_error())
    }

    pub(super) fn open_read(path: &Path) -> Result<Option<File>, DaemonError> {
        let Some(directory) = parent(path, false)? else {
            return Ok(None);
        };
        let name = filename(path)?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(storage_error())
            };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        check_file(&file)?;
        Ok(Some(file))
    }

    pub(super) fn replace(path: &Path, bytes: &[u8]) -> Result<(), DaemonError> {
        let directory = parent(path, true)?.ok_or_else(storage_error)?;
        let name = filename(path)?;
        // Validate any existing destination without following symlinks. Hard
        // links are rejected so tightening permissions cannot affect another file.
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            let metadata = unsafe { metadata.assume_init() };
            if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
                || metadata.st_uid != unsafe { libc::geteuid() }
                || metadata.st_nlink != 1
            {
                return Err(storage_error());
            }
        } else if std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
            return Err(storage_error());
        }
        let temp_name = CString::new(format!(".cloud-{}.tmp", uuid::Uuid::new_v4()))
            .map_err(|_| storage_error())?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(storage_error());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let result = (|| {
            file.write_all(bytes).map_err(|_| storage_error())?;
            file.sync_all().map_err(|_| storage_error())?;
            if unsafe {
                libc::renameat(
                    directory.as_raw_fd(),
                    temp_name.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                )
            } != 0
            {
                return Err(storage_error());
            }
            directory.sync_all().map_err(|_| storage_error())
        })();
        // After rename this is a harmless ENOENT; on failure it removes the
        // incomplete private artifact without touching the prior destination.
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), temp_name.as_ptr(), 0);
        }
        result
    }
}

#[cfg(not(unix))]
mod private_file {
    use super::*;

    // Cloud credentials require owner-only file permissions. Until the Windows
    // ACL implementation exists, fail closed instead of writing public secrets.
    pub(super) fn open_read(_path: &Path) -> Result<Option<File>, DaemonError> {
        Err(storage_error())
    }
    pub(super) fn replace(_path: &Path, _bytes: &[u8]) -> Result<(), DaemonError> {
        Err(storage_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persists_and_replaces_private_json() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cloud/settings.json");
        assert_eq!(read_json::<serde_json::Value>(&path).unwrap(), None);
        write_json(&path, &json!({"token": "first-secret"})).unwrap();
        write_json(&path, &json!({"token": "second-secret"})).unwrap();
        assert_eq!(
            read_json::<serde_json::Value>(&path).unwrap(),
            Some(json!({"token": "second-secret"}))
        );
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn corrupt_json_does_not_expose_private_content() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("secret-path.json");
        std::fs::write(&path, br#"{"private-token": "secret-value""#).unwrap();
        let error = read_json::<serde_json::Value>(&path)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret"));
        assert!(!error.contains(root.path().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_hardlinks_without_changing_referenced_permissions() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside.json");
        std::fs::write(&outside, b"{}").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
        let storage = root.path().join("cloud");
        std::fs::create_dir(&storage).unwrap();
        let path = storage.join("settings.json");
        symlink(&outside, &path).unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
        assert!(write_json(&path, &json!({})).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&outside, &path).unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
        assert!(write_json(&path, &json!({})).is_err());
        assert_eq!(
            std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let linked_directory = root.path().join("linked-cloud");
        symlink(&storage, &linked_directory).unwrap();
        assert!(write_json(&linked_directory.join("another.json"), &json!({})).is_err());
    }
}
