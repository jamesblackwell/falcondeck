//! Bounded, no-follow metadata preservation and cache proof. Attribute values
//! stay in memory/private payloads and never enter Git metadata or logs.
use std::path::Path;

/// Native Darwin ACLs are separate from xattrs. Export the ordered ACEs and ACL
/// flags in Apple's portable binary format, without resolving principal names.
/// Failure to read/serialize or a concurrent identity/security change refuses
/// preservation; an absent ACL is accepted only for a still-existing object.
#[cfg(target_os = "macos")]
pub(super) fn native_acl(path: &Path) -> std::io::Result<Vec<u8>> {
    const COPYFILE_ACL: u32 = 1 << 0;
    const COPYFILE_XATTR: u32 = 1 << 2;
    const COPYFILE_CHECK: u32 = 1 << 16;
    const COPYFILE_NOFOLLOW_SRC: u32 = 1 << 18;
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    unsafe extern "C" {
        fn acl_get_link_np(path: *const libc::c_char, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_size(acl: *mut libc::c_void) -> libc::ssize_t;
        fn acl_copy_ext(
            buf: *mut libc::c_void,
            acl: *mut libc::c_void,
            size: libc::ssize_t,
        ) -> libc::ssize_t;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        fn copyfile(
            from: *const libc::c_char,
            to: *const libc::c_char,
            state: *mut libc::c_void,
            flags: u32,
        ) -> libc::c_int;
    }
    let before = std::fs::symlink_metadata(path)?;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let acl = unsafe { acl_get_link_np(name.as_ptr(), 0x100) }; // ACL_TYPE_EXTENDED, no follow
    let bytes = if acl.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOENT) {
            return Err(error);
        }
        // Darwin also uses ENOENT for an absent ACL. CHECK alone returns zero
        // for missing paths, so lstat identity checks on both sides are required.
        // Request XATTR too, or Darwin reports quarantine metadata via ACL.
        let flags = unsafe {
            copyfile(
                name.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                COPYFILE_CHECK | COPYFILE_ACL | COPYFILE_XATTR | COPYFILE_NOFOLLOW_SRC,
            )
        };
        if flags < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if (flags as u32) & COPYFILE_ACL != 0 {
            return Err(std::io::Error::other("Private ACL changed while reading"));
        }
        Vec::new()
    } else {
        let result = (|| {
            let size = unsafe { acl_size(acl) };
            if size < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if size > 64 * 1024 {
                return Err(std::io::Error::other("Private ACL exceeds limit"));
            }
            let mut bytes = vec![0u8; size as usize];
            let written = unsafe { acl_copy_ext(bytes.as_mut_ptr().cast(), acl, size) };
            if written < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if written != size {
                return Err(std::io::Error::other(
                    "Private ACL serialization changed size",
                ));
            }
            Ok(bytes)
        })();
        unsafe {
            acl_free(acl);
        }
        result?
    };
    let after = std::fs::symlink_metadata(path)?;
    let identity = |m: &std::fs::Metadata| (m.dev(), m.ino(), m.ctime(), m.ctime_nsec());
    if identity(&before) != identity(&after) {
        return Err(std::io::Error::other(
            "Private ACL object changed while reading",
        ));
    }
    Ok(bytes)
}

// Linux stores POSIX access/default ACLs as system.posix_acl_* xattrs. Include
// every readable attribute, not just user.*, and fail closed on unsupported
// filesystems, oversized metadata or races. Never emit attribute values.
pub(super) fn attributes(
    path: &Path,
) -> std::io::Result<std::collections::BTreeMap<Vec<u8>, Vec<u8>>> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes())?;
    let list = |buffer: *mut libc::c_char, size| unsafe {
        #[cfg(target_os = "macos")]
        {
            libc::listxattr(path.as_ptr(), buffer, size, libc::XATTR_NOFOLLOW)
        }
        #[cfg(target_os = "linux")]
        {
            libc::llistxattr(path.as_ptr(), buffer, size)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            -1
        }
    };
    let get = |name: &CString, buffer: *mut libc::c_void, size| unsafe {
        #[cfg(target_os = "macos")]
        {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buffer,
                size,
                0,
                libc::XATTR_NOFOLLOW,
            )
        }
        #[cfg(target_os = "linux")]
        {
            libc::lgetxattr(path.as_ptr(), name.as_ptr(), buffer, size)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            -1
        }
    };
    fn size(n: libc::ssize_t) -> std::io::Result<usize> {
        if n < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if n > 1024 * 1024 {
            return Err(std::io::Error::other("Private metadata exceeds limit"));
        }
        Ok(n as usize)
    }
    let mut names = vec![0u8; size(list(std::ptr::null_mut(), 0))?];
    let used = size(list(names.as_mut_ptr().cast(), names.len()))?;
    if used > names.len() {
        return Err(std::io::Error::other("Private metadata changed"));
    }
    names.truncate(used);
    let mut out = std::collections::BTreeMap::new();
    let mut total = names.len();
    for name in names.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let key = CString::new(name)?;
        let n = size(get(&key, std::ptr::null_mut(), 0))?;
        total += n;
        if total > 16 * 1024 * 1024 {
            return Err(std::io::Error::other("Private metadata exceeds limit"));
        }
        let mut value = vec![0u8; n];
        let used = size(get(&key, value.as_mut_ptr().cast(), value.len()))?;
        if used != n {
            return Err(std::io::Error::other("Private metadata changed"));
        }
        out.insert(name.to_vec(), value);
    }
    Ok(out)
}
pub(super) fn set_attribute(path: &Path, name: &[u8], value: Option<&[u8]>) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes())?;
    let name = CString::new(name)?;
    let status = unsafe {
        #[cfg(target_os = "macos")]
        {
            match value {
                Some(v) => libc::setxattr(
                    path.as_ptr(),
                    name.as_ptr(),
                    v.as_ptr().cast(),
                    v.len(),
                    0,
                    libc::XATTR_NOFOLLOW,
                ),
                None => libc::removexattr(path.as_ptr(), name.as_ptr(), libc::XATTR_NOFOLLOW),
            }
        }
        #[cfg(target_os = "linux")]
        {
            match value {
                Some(v) => {
                    libc::lsetxattr(path.as_ptr(), name.as_ptr(), v.as_ptr().cast(), v.len(), 0)
                }
                None => libc::lremovexattr(path.as_ptr(), name.as_ptr()),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            -1
        }
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
pub(super) fn copy_attributes(source: &Path, dest: &Path) -> std::io::Result<()> {
    let original = attributes(source)?;
    let current = attributes(dest)?;
    for name in current.keys().filter(|n| !original.contains_key(*n)) {
        set_attribute(dest, name, None)?;
    }
    for (name, value) in &original {
        if current.get(name) != Some(value) {
            set_attribute(dest, name, Some(value))?;
        }
    }
    if attributes(dest)? != original || attributes(source)? != original {
        return Err(std::io::Error::other(
            "Private metadata copy could not be verified",
        ));
    }
    Ok(())
}

/// Unknown metadata may contain private work or access restrictions even when
/// package bytes match. macOS-generated provenance is regenerated by the OS;
/// it is the only attribute excluded from retention on that platform.
pub(super) fn cache_rebuildable(path: &Path) -> std::io::Result<bool> {
    if attributes(path)?
        .keys()
        .any(|name| !cfg!(target_os = "macos") || name.as_slice() != b"com.apple.provenance")
    {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" {
            fn copyfile(
                from: *const libc::c_char,
                to: *const libc::c_char,
                state: *mut libc::c_void,
                flags: u32,
            ) -> libc::c_int;
        }
        let from = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        // copyfile.h: CHECK returns whether ACLs would be copied; no mutation.
        let result = unsafe {
            copyfile(
                from.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                (1 << 16) | 1 | (1 << 18),
            )
        };
        if result < 0 {
            return Err(std::io::Error::last_os_error());
        }
        return Ok(result & 1 == 0);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(true)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn native_acl_requires_existing_object_and_does_not_follow_links() {
        use std::os::unix::fs::symlink;
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("file");
        std::fs::write(&file, "fixture").unwrap();
        assert!(native_acl(&file).unwrap().is_empty());
        set_attribute(
            &file,
            b"com.apple.quarantine",
            Some(b"0081;00000000;FalconDeckFixture;"),
        )
        .unwrap();
        assert!(native_acl(&file).unwrap().is_empty());
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "user:nobody deny read"])
                .arg(&file)
                .status()
                .unwrap()
                .success()
        );
        assert!(!native_acl(&file).unwrap().is_empty());
        let link = t.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(native_acl(&link).unwrap().is_empty());
        std::fs::remove_file(file).unwrap();
        assert!(native_acl(&link).unwrap().is_empty());
        assert!(native_acl(&t.path().join("missing")).is_err());
    }
    #[test]
    fn cache_proof_keeps_acl_bearing_files_and_directories() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("file");
        std::fs::write(&file, "unchanged package bytes").unwrap();
        for path in [&file, t.path()] {
            assert!(cache_rebuildable(path).unwrap());
            let result = std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone allow read"])
                .arg(path)
                .status()
                .unwrap();
            assert!(result.success());
            assert!(!cache_rebuildable(path).unwrap());
        }
    }
}
