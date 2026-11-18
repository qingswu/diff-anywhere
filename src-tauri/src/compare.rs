use crate::endpoint::{self, Endpoint, Entry, Kind};
use crate::filter::Filter;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::Instant;

/// Max file size loaded into the diff view.
const READ_LIMIT: u64 = 32 << 20;

/// In Smart mode, larger files are compared by size + date only.
const SMART_CONTENT_LIMIT: u64 = 64 << 20;

/// Extensions that are almost never text. Smart mode doesn't read these.
const BINARY_EXTS: &[&str] = &[
    // images / media
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "tif", "tiff", "psd", "heic", "avif",
    "mp3", "mp4", "m4a", "m4v", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "aac",
    // archives / packages
    "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war", "whl", "egg",
    "deb", "rpm", "apk", "dmg", "iso", "img", "pkg", "msi", "crx", "nupkg",
    // compiled / native
    "exe", "dll", "so", "dylib", "a", "lib", "o", "obj", "ko", "class", "pyc", "pyo", "pyd",
    "wasm", "bin", "dat", "elf", "out",
    // data / ML
    "db", "sqlite", "sqlite3", "mdb", "parquet", "arrow", "feather", "avro", "orc", "pkl", "pickle",
    "npy", "npz", "h5", "hdf5", "pt", "pth", "ckpt", "safetensors", "onnx", "pb", "tflite",
    "gguf", "ggml", "engine", "plan", "trt", "tfrecord", "lmdb", "idx",
    // documents / fonts
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "key", "pages", "numbers",
    "ttf", "otf", "woff", "woff2", "eot",
];

fn is_binary_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    // Versioned shared libs like libfoo.so.1.2
    if name.contains(".so.") {
        return true;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => BINARY_EXTS.contains(&ext),
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Same,
    Changed,
    LeftOnly,
    RightOnly,
    /// Same size; contents still to be verified with `verify`.
    Pending,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// Text files: verify contents. Binary types / huge files: size + date only.
    Smart,
    /// Verify contents of every equal-size pair.
    Content,
    /// Size and modification time only (no file reads).
    Quick,
}

#[derive(Serialize)]
pub struct Item {
    pub path: String,
    pub is_dir: bool,
    pub status: Status,
    pub left: Option<Entry>,
    pub right: Option<Entry>,
    /// Binary type or too large to diff: the UI shows size/date instead of a text diff.
    pub binary: bool,
}

#[derive(Serialize)]
pub struct Timings {
    pub probe_ms: u128,
    pub list_ms: u128,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Dir {
        left: String,
        right: String,
        items: Vec<Item>,
        timings: Timings,
    },
    File {
        left: String,
        right: String,
        left_entry: Option<Entry>,
        right_entry: Option<Entry>,
        binary: bool,
    },
}

fn both<A: Send, B: Send>(a: impl FnOnce() -> A + Send, b: impl FnOnce() -> B + Send) -> (A, B) {
    std::thread::scope(|s| {
        let hb = s.spawn(b);
        let ra = a();
        (ra, hb.join().expect("worker panicked"))
    })
}

/// Probe + list both sides and classify by metadata. Never reads file contents:
/// pairs that need a content check come back as `Pending` for `verify`.
pub fn run(left: &str, right: &str, filters: &str, method: Method) -> Result<Outcome, String> {
    let t0 = Instant::now();
    let mut l = endpoint::parse(left)?;
    let mut r = endpoint::parse(right)?;
    let filter = Filter::new(filters)?;

    let (lk, rk) = both(|| l.kind(), || r.kind());
    let (lk, rk) = (lk?, rk?);
    let probe_ms = t0.elapsed().as_millis();
    let missing = |e: &Endpoint| format!("not found: {}", e.label());
    match (lk, rk) {
        (Kind::Missing, _) => return Err(missing(&l)),
        (_, Kind::Missing) => return Err(missing(&r)),
        (Kind::Dir, Kind::Dir) => {}
        // File vs folder: compare against the file of the same name inside the folder.
        (Kind::File, Kind::Dir) => r = r.join(&l.file_name().ok_or("bad file name")?),
        (Kind::Dir, Kind::File) => l = l.join(&r.file_name().ok_or("bad file name")?),
        (Kind::File, Kind::File) => {}
    }
    if lk != Kind::Dir || rk != Kind::Dir {
        let (ls, rs) = both(|| l.stat(), || r.stat());
        let (le, re) = (ls.unwrap_or(None), rs.unwrap_or(None));
        let big = [&le, &re].iter().any(|e| e.as_ref().is_some_and(|e| e.size > READ_LIMIT));
        let name = l.file_name().unwrap_or_default();
        return Ok(Outcome::File {
            left: l.label(),
            right: r.label(),
            binary: big || is_binary_path(&name),
            left_entry: le,
            right_entry: re,
        });
    }

    let t1 = Instant::now();
    let (la, ra) = both(|| l.list(&filter), || r.list(&filter));
    let (la, ra) = (la?, ra?);
    let list_ms = t1.elapsed().as_millis();

    let paths: BTreeSet<&String> = la.keys().chain(ra.keys()).collect();
    let mut items = Vec::with_capacity(paths.len());
    for p in paths {
        let le = la.get(p).cloned();
        let re = ra.get(p).cloned();
        let (status, is_dir) = match (&le, &re) {
            (Some(a), None) => (Status::LeftOnly, a.is_dir),
            (None, Some(b)) => (Status::RightOnly, b.is_dir),
            (Some(a), Some(b)) if a.is_dir && b.is_dir => (Status::Same, true),
            (Some(a), Some(b)) if a.is_dir != b.is_dir || a.size != b.size => (Status::Changed, false),
            (Some(a), Some(b)) => {
                let same_time = (a.mtime - b.mtime).abs() < 1.0;
                let by_content = match method {
                    Method::Content => true,
                    Method::Quick => false,
                    Method::Smart => a.size <= SMART_CONTENT_LIMIT && !is_binary_path(p),
                };
                let status = if a.size == 0 {
                    Status::Same
                } else if by_content {
                    Status::Pending
                } else if same_time {
                    Status::Same
                } else {
                    Status::Changed
                };
                (status, false)
            }
            (None, None) => unreachable!(),
        };
        let big = [&le, &re].iter().any(|e| e.as_ref().is_some_and(|e| e.size > READ_LIMIT));
        items.push(Item {
            binary: !is_dir && (big || is_binary_path(p)),
            path: p.clone(),
            is_dir,
            status,
            left: le,
            right: re,
        });
    }

    Ok(Outcome::Dir {
        left: l.label(),
        right: r.label(),
        items,
        timings: Timings { probe_ms, list_ms },
    })
}

/// Content-check a batch of relative paths on both sides (hashed where the files live).
/// Returns `Same` / `Changed` for each path, in order.
pub fn verify(left: &str, right: &str, paths: &[String]) -> Result<Vec<Status>, String> {
    let l = endpoint::parse(left)?;
    let r = endpoint::parse(right)?;
    // File mode: a single empty path means "the endpoints themselves".
    if paths.len() == 1 && paths[0].is_empty() {
        let ((lp, ln), (rp, rn)) = (l.split(), r.split());
        let (lh, rh) = both(|| lp.hash(&[ln.as_str()]), || rp.hash(&[rn.as_str()]));
        let same = matches!((lh?.get(&ln), rh?.get(&rn)), (Some(a), Some(b)) if a == b);
        return Ok(vec![if same { Status::Same } else { Status::Changed }]);
    }
    let rels: Vec<&str> = paths.iter().map(String::as_str).collect();
    let (lh, rh) = both(|| l.hash(&rels), || r.hash(&rels));
    let (lh, rh) = (lh?, rh?);
    Ok(paths
        .iter()
        .map(|p| match (lh.get(p), rh.get(p)) {
            (Some(a), Some(b)) if a == b => Status::Same,
            _ => Status::Changed,
        })
        .collect())
}

#[derive(Serialize)]
pub struct FileSide {
    pub exists: bool,
    pub binary: bool,
    /// Not valid UTF-8: shown lossily, so it must not be saved back.
    pub lossy: bool,
    pub size: u64,
    pub text: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct FilePair {
    pub left: FileSide,
    pub right: FileSide,
}

fn load(ep: Result<Endpoint, String>, exists: bool) -> FileSide {
    let mut side = FileSide {
        exists,
        binary: false,
        lossy: false,
        size: 0,
        text: String::new(),
        error: None,
    };
    if !exists {
        return side;
    }
    match ep.and_then(|e| e.read(READ_LIMIT)) {
        Ok(bytes) => {
            side.size = bytes.len() as u64;
            side.binary = bytes.iter().take(8000).any(|&b| b == 0);
            if !side.binary {
                side.lossy = std::str::from_utf8(&bytes).is_err();
                side.text = String::from_utf8_lossy(&bytes).into_owned();
            }
        }
        Err(e) => side.error = Some(e),
    }
    side
}

/// Load both sides of a file. `rel` is relative to the compared roots (empty in file mode).
pub fn read_pair(left: &str, right: &str, rel: &str, left_exists: bool, right_exists: bool) -> FilePair {
    let (l, r) = both(
        || load(endpoint::parse(left).map(|e| e.join(rel)), left_exists),
        || load(endpoint::parse(right).map(|e| e.join(rel)), right_exists),
    );
    FilePair { left: l, right: r }
}

/// Save text to `root` joined with `rel` (`rel` empty in file mode).
pub fn write(root: &str, rel: &str, content: String) -> Result<(), String> {
    endpoint::parse(root)?.join(rel).write(content.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_detection() {
        for p in ["a/model.safetensors", "x.PNG", "lib/libc.so.6", "w.pt", "a.tar"] {
            assert!(is_binary_path(p), "{p}");
        }
        for p in ["main.rs", "Makefile", ".bashrc", "data.csv", "notes.txt", "dir.so/file.py", ".png"] {
            assert!(!is_binary_path(p), "{p}");
        }
    }
    use std::fs;

    #[test]
    fn local_dirs() {
        let base = std::env::temp_dir().join(format!("da-test-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        for d in [&a, &b] {
            fs::create_dir_all(d.join("sub")).unwrap();
            fs::create_dir_all(d.join("node_modules")).unwrap();
            fs::write(d.join("same.txt"), "hello").unwrap();
            fs::write(d.join("node_modules/x.js"), "x").unwrap();
        }
        fs::write(a.join("sub/c.txt"), "one").unwrap();
        fs::write(b.join("sub/c.txt"), "two").unwrap();
        fs::write(a.join("only-left.log"), "").unwrap();
        fs::write(b.join("only-right.txt"), "").unwrap();

        let (ls, rs) = (a.to_str().unwrap(), b.to_str().unwrap());
        let out = run(ls, rs, "node_modules", Method::Content).unwrap();
        let Outcome::Dir { items, .. } = out else { panic!() };
        let get = |p: &str| items.iter().find(|i| i.path == p).map(|i| i.status);
        assert_eq!(get("same.txt"), Some(Status::Pending));
        assert_eq!(get("sub/c.txt"), Some(Status::Pending));
        let v = verify(ls, rs, &["same.txt".into(), "sub/c.txt".into(), "nope".into()]).unwrap();
        assert_eq!(v, vec![Status::Same, Status::Changed, Status::Changed]);
        // Quick never reads contents.
        let Outcome::Dir { items, .. } = run(ls, rs, "node_modules", Method::Quick).unwrap() else { panic!() };
        assert!(items.iter().all(|i| i.status != Status::Pending));
        // Smart: text files are content-checked, binary types go by size + date.
        fs::write(a.join("w.safetensors"), "abc").unwrap();
        fs::write(b.join("w.safetensors"), "xyz").unwrap();
        let Outcome::Dir { items, .. } = run(ls, rs, "node_modules", Method::Smart).unwrap() else { panic!() };
        let get = |p: &str| items.iter().find(|i| i.path == p).map(|i| i.status);
        assert_eq!(get("sub/c.txt"), Some(Status::Pending));
        assert_eq!(get("w.safetensors"), Some(Status::Same)); // same size, same mtime (just written)
        assert_eq!(get("only-left.log"), Some(Status::LeftOnly));
        assert_eq!(get("only-right.txt"), Some(Status::RightOnly));
        assert_eq!(get("node_modules"), None);
        assert_eq!(get("node_modules/x.js"), None);

        let (lf, rf) = (a.join("sub/c.txt"), b.join("sub"));
        let out = run(lf.to_str().unwrap(), rf.to_str().unwrap(), "", Method::Content).unwrap();
        let Outcome::File { left_entry, binary, .. } = out else { panic!() };
        assert_eq!(left_entry.map(|e| e.size), Some(3));
        assert!(!binary);
        let v = verify(lf.to_str().unwrap(), b.join("sub/c.txt").to_str().unwrap(), &["".into()]).unwrap();
        assert_eq!(v, vec![Status::Changed]);
        let v = verify(lf.to_str().unwrap(), lf.to_str().unwrap(), &["".into()]).unwrap();
        assert_eq!(v, vec![Status::Same]);

        write(a.to_str().unwrap(), "new/deep/f.txt", "saved".into()).unwrap();
        assert_eq!(fs::read_to_string(a.join("new/deep/f.txt")).unwrap(), "saved");
        fs::remove_dir_all(base).unwrap();
    }
}
