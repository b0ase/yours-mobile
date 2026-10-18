//! storage.local for bWalletX Desktop: the wallet's chrome.storage.local (password-encrypted keystore, settings) as
//! one JSON object of key → JSON-string in `<app data dir>/storage-local.json`.
//!
//! - Owner-only: the directory is 0700 and the file 0600 (unix).
//! - Atomic: every change batch writes a temp file in the same directory, fsyncs it, renames it over the old file and
//!   fsyncs the directory, so a crash leaves either the old or the new store, never half of one.
//! - Serialised: one mutex around the in-memory map and the write, so concurrent batches cannot interleave.
//!
//! Nothing here can decrypt anything: the keys inside are encrypted by the wallet with the user's password.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const FILE_NAME: &str = "storage-local.json";

pub struct Store {
    path: PathBuf,
    map: Mutex<BTreeMap<String, String>>,
}

impl Store {
    /// Opens (or starts) the store in `dir`. A file that is not valid JSON is kept aside, never overwritten.
    pub fn open(dir: &Path) -> Result<Self, String> {
        create_private_dir(dir)?;
        let path = dir.join(FILE_NAME);
        let map = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<BTreeMap<String, String>>(&bytes) {
                Ok(m) => m,
                Err(e) => {
                    let aside = dir.join(format!("{FILE_NAME}.unreadable-{}", now_secs()));
                    fs::rename(&path, &aside).map_err(|e| e.to_string())?;
                    eprintln!(
                        "[store] {FILE_NAME} unreadable ({e}); kept as {}",
                        aside.display()
                    );
                    BTreeMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self {
            path,
            map: Mutex::new(map),
        })
    }

    pub fn load(&self) -> BTreeMap<String, String> {
        self.map.lock().expect("store lock").clone()
    }

    /// Applies one batch and persists it before returning; the in-memory map only changes if the write succeeded.
    pub fn apply(
        &self,
        sets: BTreeMap<String, String>,
        removes: Vec<String>,
    ) -> Result<(), String> {
        let mut map = self
            .map
            .lock()
            .map_err(|_| "store lock poisoned".to_string())?;
        let mut next = map.clone();
        for key in removes {
            next.remove(&key);
        }
        next.extend(sets);
        write_atomic(
            &self.path,
            &serde_json::to_vec(&next).map_err(|e| e.to_string())?,
        )?;
        *map = next;
        Ok(())
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("store path has no parent")?;
    let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        // The rename itself is durable only once the directory entry is flushed.
        File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_across_reopen_and_applies_removes() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        let mut sets = BTreeMap::new();
        sets.insert("a".into(), "\"1\"".into());
        sets.insert("b".into(), "2".into());
        s.apply(sets, vec![]).unwrap();
        s.apply(BTreeMap::new(), vec!["b".into()]).unwrap();
        let again = Store::open(dir.path()).unwrap().load();
        assert_eq!(again.get("a").map(String::as_str), Some("\"1\""));
        assert!(!again.contains_key("b"));
    }

    #[cfg(unix)]
    #[test]
    fn file_and_dir_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("data");
        let s = Store::open(&sub).unwrap();
        s.apply([("k".to_string(), "v".to_string())].into(), vec![])
            .unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&sub), 0o700);
        assert_eq!(mode(&sub.join(FILE_NAME)), 0o600);
    }

    #[test]
    fn unreadable_file_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), b"not json").unwrap();
        let s = Store::open(dir.path()).unwrap();
        assert!(s.load().is_empty());
        let kept = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("unreadable"));
        assert!(kept);
    }
}
