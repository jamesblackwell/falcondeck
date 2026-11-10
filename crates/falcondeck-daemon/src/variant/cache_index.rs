//! Read-only pnpm content receipts. Unsupported/missing receipts never authorize
//! deletion. No package code, package-manager script or network request executes.
use serde_json::{Map, Value};
use std::{collections::HashMap, path::Path};

// Bounded subset of MessagePack + msgpackr's documented record extension:
// https://github.com/kriszyp/msgpackr#record-structure-extension-definition
// Unknown extensions fail closed. Records are local to one package receipt.
struct Decoder<'a> {
    bytes: &'a [u8],
    at: usize,
    records: HashMap<u8, Vec<String>>,
    nodes: usize,
    remaining: usize,
}
impl<'a> Decoder<'a> {
    // Charge before allocating, including every expanded record key. The node
    // allowance covers Value/container overhead and vector growth as well as
    // the string bytes charged separately. Input size alone cannot bound
    // msgpackr record expansion.
    fn charge(&mut self, bytes: usize) -> Option<()> {
        self.remaining = self.remaining.checked_sub(bytes)?;
        Some(())
    }
    fn record_fields(&mut self, id: u8, depth: usize) -> Option<Value> {
        let keys = self.records.get(&id)?;
        let bytes = keys
            .iter()
            .try_fold(keys.len().checked_mul(128)?, |n, k| n.checked_add(k.len()))?;
        self.charge(bytes)?;
        let keys = self.records.get(&id)?.clone();
        self.fields(keys, depth)
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let v = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(v)
    }
    fn num(&mut self, n: usize) -> Option<u64> {
        Some(
            self.take(n)?
                .iter()
                .fold(0, |v, b| (v << 8) | u64::from(*b)),
        )
    }
    fn fields(&mut self, keys: Vec<String>, depth: usize) -> Option<Value> {
        let mut m = Map::new();
        for k in keys {
            if m.insert(k, self.read(depth + 1)?).is_some() {
                return None;
            }
        }
        Some(Value::Object(m))
    }
    fn read(&mut self, depth: usize) -> Option<Value> {
        self.charge(128)?;
        self.nodes += 1;
        if depth > 64 || self.nodes > 1_000_000 {
            return None;
        }
        let b = self.num(1)? as u8;
        if self.records.contains_key(&b) {
            return self.record_fields(b, depth);
        }
        match b {
            0..=127 => Some(b.into()),
            224..=255 => Some((b as i8 as i64).into()),
            0xa0..=0xbf | 0xd9..=0xdb => {
                let n = if b <= 0xbf {
                    usize::from(b - 0xa0)
                } else {
                    self.num(1usize << (b - 0xd9))? as usize
                };
                self.charge(n)?;
                Some(std::str::from_utf8(self.take(n)?).ok()?.into())
            }
            0x90..=0x9f | 0xdc | 0xdd => {
                let n = if b <= 0x9f {
                    usize::from(b - 0x90)
                } else {
                    self.num(if b == 0xdc { 2 } else { 4 })? as usize
                };
                if n > 100_000 {
                    return None;
                }
                let mut a = Vec::new();
                for _ in 0..n {
                    a.push(self.read(depth + 1)?)
                }
                Some(a.into())
            }
            0x80..=0x8f | 0xde | 0xdf => {
                let n = if b <= 0x8f {
                    usize::from(b - 0x80)
                } else {
                    self.num(if b == 0xde { 2 } else { 4 })? as usize
                };
                if n > 100_000 {
                    return None;
                }
                let mut m = Map::new();
                for _ in 0..n {
                    self.charge(128)?;
                    let Value::String(k) = self.read(depth + 1)? else {
                        return None;
                    };
                    if m.insert(k, self.read(depth + 1)?).is_some() {
                        return None;
                    }
                }
                Some(m.into())
            }
            0xc0 | 0xc1 => Some(Value::Null),
            0xc2 => Some(false.into()),
            0xc3 => Some(true.into()),
            0xcc..=0xcf => Some(self.num(1usize << (b - 0xcc))?.into()),
            0xd0..=0xd3 => {
                let n = 1usize << (b - 0xd0);
                let v = self.num(n)?;
                Some(((v << (64 - n * 8)) as i64 >> (64 - n * 8)).into())
            }
            0xca => {
                let v = f32::from_bits(self.num(4)? as u32) as f64;
                serde_json::Number::from_f64(v).map(Value::Number)
            }
            0xcb => serde_json::Number::from_f64(f64::from_bits(self.num(8)?)).map(Value::Number),
            0xd4 => {
                let t = self.num(1)?;
                let id = self.num(1)? as u8;
                if t == 0 {
                    return Some(Value::Null);
                }
                if t != 0x72 || !(0x40..=0x7f).contains(&id) {
                    return None;
                }
                let Value::Array(values) = self.read(depth + 1)? else {
                    return None;
                };
                let keys = values
                    .into_iter()
                    .map(|v| match v {
                        Value::String(k) => Some(k),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()?;
                self.records.insert(id, keys);
                self.record_fields(id, depth)
            }
            _ => None,
        }
    }
}
pub(super) fn decode(bytes: &[u8]) -> Option<Value> {
    if bytes.len() > 16 * 1024 * 1024 {
        return None;
    }
    let mut d = Decoder {
        bytes,
        at: 0,
        records: HashMap::new(),
        nodes: 0,
        remaining: 64 * 1024 * 1024,
    };
    let v = d.read(0)?;
    (d.at == bytes.len()).then_some(v)
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}
pub(super) fn open_nofollow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}
pub(super) fn open_regular(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::MetadataExt;
    let before = std::fs::symlink_metadata(path)?;
    if !before.is_file() {
        return Err(std::io::Error::other("Nonregular cache input retained"));
    }
    let file = open_nofollow(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(std::io::Error::other("Cache input identity changed"));
    }
    Ok(file)
}
pub(super) fn bounded_read(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = open_regular(path)?;
    if file.metadata()?.len() > limit as u64 {
        return Err(std::io::Error::other("Receipt exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(std::io::Error::other("Receipt exceeds size limit"));
    }
    Ok(bytes)
}
pub(super) type Catalog = HashMap<String, Vec<Value>>;
// Limit retained decoded receipts across the entire store as well as within
// each input. JSON indices do not expand records but still need this bound.
fn retain(catalog: &mut Catalog, key: String, value: Value, remaining: &mut usize) -> bool {
    fn cost(v: &Value) -> Option<usize> {
        let extra = match v {
            Value::String(s) => s.len(),
            Value::Array(a) => a.iter().try_fold(0usize, |n, v| n.checked_add(cost(v)?))?,
            Value::Object(m) => m.iter().try_fold(0usize, |n, (k, v)| {
                n.checked_add(128)?
                    .checked_add(k.len())?
                    .checked_add(cost(v)?)
            })?,
            _ => 0,
        };
        128usize.checked_add(extra)
    }
    let Some(bytes) = cost(&value).and_then(|n| n.checked_add(key.len() + 128)) else {
        return false;
    };
    let Some(left) = remaining.checked_sub(bytes) else {
        return false;
    };
    *remaining = left;
    catalog.entry(key).or_default().push(value);
    true
}
pub(super) fn load(modules: &Path) -> Catalog {
    let mut out = Catalog::new();
    let mut remaining = 128 * 1024 * 1024;
    let Ok(text) = bounded_read(&modules.join(".modules.yaml"), 1024 * 1024)
        .and_then(|b| String::from_utf8(b).map_err(std::io::Error::other))
    else {
        return out;
    };
    let json = serde_json::from_str::<Value>(&text).ok();
    let store = json
        .as_ref()
        .and_then(|j| j["storeDir"].as_str())
        .map(str::to_owned)
        .or_else(|| {
            text.lines().find_map(|l| {
                l.strip_prefix("storeDir:")
                    .map(|s| s.trim().trim_matches(['\'', '"']).to_owned())
            })
        });
    let Some(store) = store.filter(|s| Path::new(s).is_absolute()) else {
        return out;
    };
    let store = Path::new(&store);
    // pnpm <=10 uses JSON indices. Bound both count and individual inputs.
    if let Ok(groups) = std::fs::read_dir(store.join("index")) {
        let mut count = 0;
        let mut total_bytes = 0usize;
        for group in groups.flatten() {
            if let Ok(files) = std::fs::read_dir(group.path()) {
                for f in files.flatten() {
                    count += 1;
                    if count > 20_000 {
                        return out;
                    }
                    if f.metadata()
                        .is_ok_and(|m| m.is_file() && m.len() < 16 * 1024 * 1024)
                    {
                        if let Ok(b) = bounded_read(&f.path(), 16 * 1024 * 1024) {
                            total_bytes += b.len();
                            if total_bytes > 128 * 1024 * 1024 {
                                return out;
                            }
                            if let Ok(v) = serde_json::from_slice::<Value>(&b) {
                                if let (Some(n), Some(ver)) =
                                    (v["name"].as_str(), v["version"].as_str())
                                {
                                    if !retain(&mut out, format!("{n}@{ver}"), v, &mut remaining) {
                                        return out;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let db = store.join("index.db");
    if !db.is_file() {
        return out;
    }
    // immutable=1 prevents sidecar creation and writes. A stale WAL view can
    // only withhold proof: every actual file must still match a stored digest.
    let Ok(mut uri) = reqwest::Url::from_file_path(db) else {
        return out;
    };
    uri.query_pairs_mut()
        .append_pair("immutable", "1")
        .append_pair("mode", "ro");
    use std::io::Read;
    let Ok(mut child)=std::process::Command::new("nice").args(["-n","10","/usr/bin/sqlite3","-init","/dev/null","-readonly","-json",uri.as_str(),"SELECT key,hex(data) AS bytes FROM package_index WHERE length(data)<=16777216 LIMIT 20000;"])
        .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).spawn() else{return out};
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(128 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => {}
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let Ok(Ok(bytes)) = reader.join() else {
        return out;
    };
    if !status.is_some_and(|s| s.success()) || bytes.len() > 128 * 1024 * 1024 {
        return out;
    }
    let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&bytes) else {
        return out;
    };
    for row in rows {
        let Some(key) = row["key"]
            .as_str()
            .and_then(|s| s.split_once('\t').map(|(_, p)| p))
        else {
            continue;
        };
        let Some(v) = row["bytes"]
            .as_str()
            .and_then(unhex)
            .and_then(|b| decode(&b))
        else {
            continue;
        };
        if v["files"].is_object() {
            if !retain(&mut out, key.into(), v, &mut remaining) {
                return out;
            }
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_reads_refuse_pipes_and_symlinks_without_waiting_for_a_writer() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let t = tempfile::tempdir().unwrap();
        let fifo = t.path().join(".modules.yaml");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let path = fifo.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(bounded_read(&path, 1024).is_err());
        });
        assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap());
        assert!(load(t.path()).is_empty());
        let regular = t.path().join("regular");
        std::fs::write(&regular, "receipt").unwrap();
        let link = t.path().join("link");
        symlink(&regular, &link).unwrap();
        assert!(bounded_read(&link, 1024).is_err());
        assert_eq!(bounded_read(&regular, 1024).unwrap(), b"receipt");
        assert!(bounded_read(&regular, 1).is_err());
    }
    #[test]
    fn many_individual_receipts_share_one_catalog_budget() {
        let mut catalog = Catalog::new();
        let mut remaining = 4096;
        let mut accepted = 0;
        for _ in 0..1000 {
            if retain(
                &mut catalog,
                "package@1".into(),
                serde_json::json!({"files":{"a":"digest"}}),
                &mut remaining,
            ) {
                accepted += 1;
            }
        }
        assert!((1..10).contains(&accepted));
        assert_eq!(catalog["package@1"].len(), accepted);
    }
    #[test]
    fn record_references_cannot_amplify_small_input_beyond_decoded_budget() {
        // A short encoded array expands the same 64-KiB key 2,000 times.
        let mut bytes = vec![0xdc, 0x07, 0xd0, 0xd4, 0x72, 0x40, 0x91, 0xda, 0xff, 0xff];
        bytes.extend(std::iter::repeat_n(b'x', 65_535));
        bytes.push(0xc0);
        for _ in 1..2_000 {
            bytes.extend([0x40, 0xc0]);
        }
        assert!(bytes.len() < 70_000);
        assert!(decode(&bytes).is_none());
        // Ordinary repeated records still decode and retain their fields.
        assert_eq!(
            decode(b"\x92\xd4r\x40\x91\xa1a\x01\x40\x02"),
            Some(serde_json::json!([{"a":1},{"a":2}]))
        );
    }
    #[test]
    fn bounded_records_and_malformed_inputs() {
        let b = b"\xd4r\x40\x92\xa1a\xa1b\x01\xa1x";
        assert_eq!(decode(b), Some(serde_json::json!({"a":1,"b":"x"})));
        assert!(decode(&b[..b.len() - 1]).is_none());
        assert!(decode(b"\xd4r\x40\x91\x40").is_none());
        assert!(decode(b"\xd4x\x40").is_none());
    }
}

#[cfg(test)]
pub(crate) fn test_catalog(modules: &Path, store: &Path) {
    use sha2::{Digest, Sha512};
    use std::os::unix::fs::MetadataExt;
    std::fs::create_dir_all(store.join("index/00")).unwrap();
    fn files(root: &Path, p: &Path, out: &mut Map<String, Value>) {
        let m = std::fs::symlink_metadata(p).unwrap();
        if m.file_type().is_symlink() {
            return;
        }
        if m.is_dir() {
            for e in std::fs::read_dir(p).unwrap() {
                files(root, &e.unwrap().path(), out)
            }
        } else {
            let b = std::fs::read(p).unwrap();
            out.insert(p.strip_prefix(root).unwrap().to_string_lossy().into(),serde_json::json!({"size":m.len(),"mode":m.mode()&0o7777,"digest":format!("{:x}",Sha512::digest(b))}));
        }
    }
    fn packages(p: &Path, store: &Path) {
        let m = std::fs::symlink_metadata(p).unwrap();
        if !m.is_dir() || m.file_type().is_symlink() {
            return;
        }
        let manifest = p.join("package.json");
        if let Ok(b) = std::fs::read(&manifest) {
            if let Ok(mut v) = serde_json::from_slice::<Value>(&b) {
                if v["name"].is_string() {
                    if !v["version"].is_string() {
                        v["version"] = "1.0.0".into();
                        std::fs::write(&manifest, serde_json::to_vec(&v).unwrap()).unwrap()
                    }
                    let mut f = Map::new();
                    files(p, p, &mut f);
                    let index = serde_json::json!({"name":v["name"],"version":v["version"],"algo":"sha512","files":f});
                    std::fs::write(
                        store
                            .join("index/00")
                            .join(format!("{}.json", uuid::Uuid::new_v4())),
                        serde_json::to_vec(&index).unwrap(),
                    )
                    .unwrap();
                    return;
                }
            }
        }
        for e in std::fs::read_dir(p).unwrap() {
            packages(&e.unwrap().path(), store)
        }
    }
    packages(modules, store);
    std::fs::write(
        modules.join(".modules.yaml"),
        serde_json::to_vec(&serde_json::json!({"storeDir":store})).unwrap(),
    )
    .unwrap();
}
