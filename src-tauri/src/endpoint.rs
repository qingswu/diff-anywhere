//! An endpoint is one side of a comparison: a local path or `host:/path` over SSH.
//!
//! SSH goes through the system `ssh` binary, so `~/.ssh/config`, keys, the agent,
//! ProxyJump etc. all work as in a terminal. A shared control connection
//! (ControlMaster) keeps repeated commands fast.

use crate::filter::Filter;
use serde::Serialize;
use md5::{Digest, Md5};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub enum Endpoint {
    Local(PathBuf),
    Ssh { host: String, path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct Child {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: f64,
}

/// Parse `"/local/path"`, `"~/x"`, `"C:\\x"`, `"host:/path"`, `"user@host:path"`.
pub fn parse(s: &str) -> Result<Endpoint, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("path is empty".into());
    }
    let b = s.as_bytes();
    let win_drive = cfg!(windows)
        && b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b.len() == 2 || b[2] == b'\\' || b[2] == b'/');
    if !win_drive && !s.starts_with(['/', '.', '~', '\\']) {
        if let Some(idx) = s.find(':') {
            let host = &s[..idx];
            if !host.is_empty() && !host.contains(['/', '\\']) {
                let path = &s[idx + 1..];
                let path = if path.is_empty() { "." } else { path };
                return Ok(Endpoint::Ssh {
                    host: host.to_string(),
                    path: path.to_string(),
                });
            }
        }
    }
    Ok(Endpoint::Local(expand_tilde(s)))
}

fn expand_tilde(s: &str) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (s, home) {
        ("~", Some(h)) => PathBuf::from(h),
        (s, Some(h)) if s.starts_with("~/") => PathBuf::from(h).join(&s[2..]),
        _ => PathBuf::from(s),
    }
}

/// Single-quote for POSIX sh.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Quote a remote path, keeping a leading `~` expandable.
fn rq(path: &str) -> String {
    if path == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("\"$HOME\"/{}", sq(rest))
    } else {
        sq(path)
    }
}

fn ssh(host: &str, script: &str, stdin: Option<Vec<u8>>) -> Result<Output, String> {
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    #[cfg(unix)]
    cmd.args([
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPath=/tmp/diffanywhere-%C",
        "-o",
        "ControlPersist=600",
    ]);
    // On Windows, don't flash a console window for every ssh call from the GUI app.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Run through `sh -c` so the remote login shell (fish, csh, ...) doesn't matter.
    cmd.arg("--").arg(host).arg(format!("sh -c {}", sq(script)));
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to run ssh: {e}"))?;
    let writer = stdin.map(|data| {
        let mut pipe = child.stdin.take().expect("stdin piped");
        std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        })
    });
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    if out.status.code() == Some(255) {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "ssh {host}: {}",
            if err.is_empty() { "connection failed".into() } else { err }
        ));
    }
    Ok(out)
}

fn ssh_err(host: &str, out: &Output, what: &str) -> String {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() {
        format!("{host}: {what} failed (exit {:?})", out.status.code())
    } else {
        format!("{host}: {err}")
    }
}

fn to_secs(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

impl Endpoint {
    pub fn label(&self) -> String {
        match self {
            Endpoint::Local(p) => p.display().to_string(),
            Endpoint::Ssh { host, path } => format!("{host}:{path}"),
        }
    }

    /// The endpoint for `rel` beneath this one (`rel` empty = itself).
    pub fn join(&self, rel: &str) -> Endpoint {
        if rel.is_empty() {
            return self.clone();
        }
        match self {
            Endpoint::Local(p) => Endpoint::Local(p.join(rel)),
            Endpoint::Ssh { host, path } => Endpoint::Ssh {
                host: host.clone(),
                path: format!("{}/{}", path.trim_end_matches('/'), rel),
            },
        }
    }

    pub fn file_name(&self) -> Option<String> {
        match self {
            Endpoint::Local(p) => p.file_name().map(|n| n.to_string_lossy().into_owned()),
            Endpoint::Ssh { path, .. } => path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty() && *s != "~")
                .map(String::from),
        }
    }

    pub fn kind(&self) -> Result<Kind, String> {
        match self {
            Endpoint::Local(p) => Ok(match std::fs::metadata(p) {
                Ok(m) if m.is_dir() => Kind::Dir,
                Ok(_) => Kind::File,
                Err(_) => Kind::Missing,
            }),
            Endpoint::Ssh { host, path } => {
                let p = rq(path);
                let script =
                    format!("if [ -d {p} ]; then echo d; elif [ -e {p} ]; then echo f; else echo n; fi");
                let out = ssh(host, &script, None)?;
                match String::from_utf8_lossy(&out.stdout).trim() {
                    "d" => Ok(Kind::Dir),
                    "f" => Ok(Kind::File),
                    "n" => Ok(Kind::Missing),
                    _ => Err(ssh_err(host, &out, "stat")),
                }
            }
        }
    }

    /// Recursively list a directory: relative path (with `/`) -> entry.
    pub fn list(&self, filter: &Filter) -> Result<BTreeMap<String, Entry>, String> {
        match self {
            Endpoint::Local(root) => Ok(list_local(root, filter)),
            Endpoint::Ssh { host, path } => list_remote(host, path, filter),
        }
    }

    /// Size and mtime of a single file (`None` if it doesn't exist).
    pub fn stat(&self) -> Result<Option<Entry>, String> {
        match self {
            Endpoint::Local(p) => Ok(std::fs::metadata(p).ok().map(|m| Entry {
                is_dir: m.is_dir(),
                size: if m.is_dir() { 0 } else { m.len() },
                mtime: to_secs(m.modified()),
            })),
            Endpoint::Ssh { host, path } => {
                let p = rq(path);
                let script = format!(
                    "[ -e {p} ] || exit 0\n\
                     if find {p} -maxdepth 0 -printf '' >/dev/null 2>&1; then find {p} -maxdepth 0 -printf '%y\t%s\t%T@\\n'\n\
                     else stat -f '%Sp\t%z\t%m' {p}; fi"
                );
                let out = ssh(host, &script, None)?;
                let text = String::from_utf8_lossy(&out.stdout);
                let mut f = text.trim().split('\t');
                match (f.next(), f.next(), f.next()) {
                    (Some(t), Some(size), Some(mtime)) if !t.is_empty() => Ok(Some(Entry {
                        is_dir: t.starts_with('d'),
                        size: size.parse().unwrap_or(0),
                        mtime: mtime.parse().unwrap_or(0.0),
                    })),
                    _ if out.status.success() => Ok(None),
                    _ => Err(ssh_err(host, &out, "stat")),
                }
            }
        }
    }

    /// Split into (parent directory, file name).
    pub fn split(&self) -> (Endpoint, String) {
        match self {
            Endpoint::Local(p) => (
                Endpoint::Local(p.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))),
                p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ),
            Endpoint::Ssh { host, path } => {
                let (dir, name) = match path.rsplit_once('/') {
                    Some(("", n)) => ("/", n),
                    Some((d, n)) => (d, n),
                    None => (".", path.as_str()),
                };
                (Endpoint::Ssh { host: host.clone(), path: dir.to_string() }, name.to_string())
            }
        }
    }

    /// Read a whole file. `limit` guards against loading huge files into the UI.
    pub fn read(&self, limit: u64) -> Result<Vec<u8>, String> {
        match self {
            Endpoint::Local(p) => {
                let f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
                let mut buf = Vec::new();
                f.take(limit + 1)
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("{}: {e}", p.display()))?;
                if buf.len() as u64 > limit {
                    return Err(format!("file is larger than {} MB", limit >> 20));
                }
                Ok(buf)
            }
            Endpoint::Ssh { host, path } => {
                let script = format!("head -c {} -- {}", limit + 1, rq(path));
                let out = ssh(host, &script, None)?;
                if !out.status.success() {
                    return Err(ssh_err(host, &out, "read"));
                }
                if out.stdout.len() as u64 > limit {
                    return Err(format!("file is larger than {} MB", limit >> 20));
                }
                Ok(out.stdout)
            }
        }
    }

    /// Overwrite (or create) a file, creating parent directories as needed.
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        match self {
            Endpoint::Local(p) => {
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
                }
                // Plain overwrite (not rename) so permissions/ownership/hard links are preserved.
                std::fs::write(p, data).map_err(|e| format!("{}: {e}", p.display()))
            }
            Endpoint::Ssh { host, path } => {
                let p = rq(path);
                let script = format!("d=$(dirname -- {p}) && mkdir -p -- \"$d\" && cat > {p}");
                let out = ssh(host, &script, Some(data))?;
                if !out.status.success() {
                    return Err(ssh_err(host, &out, "write"));
                }
                Ok(())
            }
        }
    }

    /// Direct children of a directory (for path autocomplete). Symlinks to dirs count as dirs.
    pub fn children(&self) -> Result<Vec<Child>, String> {
        let mut out = match self {
            Endpoint::Local(p) => std::fs::read_dir(p)
                .map_err(|e| format!("{}: {e}", p.display()))?
                .flatten()
                .map(|e| Child {
                    name: e.file_name().to_string_lossy().into_owned(),
                    is_dir: std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false),
                })
                .collect::<Vec<_>>(),
            Endpoint::Ssh { host, path } => {
                let script = children_script(path);
                let out = ssh(host, &script, None)?;
                if !out.status.success() {
                    return Err(ssh_err(host, &out, "list"));
                }
                parse_children(&out.stdout)
            }
        };
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    /// MD5 of files relative to this directory (used only to detect changes).
    /// Unreadable files are omitted from the result.
    pub fn hash(&self, rels: &[&str]) -> Result<HashMap<String, String>, String> {
        if rels.is_empty() {
            return Ok(HashMap::new());
        }
        match self {
            Endpoint::Local(root) => Ok(rels
                .iter()
                .filter_map(|r| hash_local(&root.join(r)).map(|h| (r.to_string(), h)))
                .collect()),
            Endpoint::Ssh { host, path } => {
                let mut input = Vec::new();
                for r in rels {
                    input.extend_from_slice(r.as_bytes());
                    input.push(0);
                }
                let out = ssh(host, &hash_script(path), Some(input))?;
                if out.status.code() == Some(3) {
                    return Err(ssh_err(host, &out, "hash"));
                }
                Ok(parse_hashes(&out.stdout))
            }
        }
    }
}

fn list_local(root: &Path, filter: &Filter) -> BTreeMap<String, Entry> {
    let mut out = BTreeMap::new();
    let rel_of = |p: &Path| -> String {
        let r = p.strip_prefix(root).unwrap_or(p).to_string_lossy();
        if cfg!(windows) { r.replace('\\', "/") } else { r.into_owned() }
    };
    let walker = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !filter.is_excluded(&rel_of(e.path())));
    for e in walker.flatten() {
        let Ok(md) = e.metadata() else { continue };
        let is_dir = md.is_dir();
        out.insert(
            rel_of(e.path()),
            Entry {
                is_dir,
                size: if is_dir { 0 } else { md.len() },
                mtime: to_secs(md.modified()),
            },
        );
    }
    out
}

fn list_remote(host: &str, path: &str, filter: &Filter) -> Result<BTreeMap<String, Entry>, String> {
    let out = ssh(host, &list_script(path, filter), None)?;
    if out.status.code() == Some(3) || (!out.status.success() && out.stdout.is_empty()) {
        return Err(ssh_err(host, &out, "list"));
    }
    Ok(parse_listing(&out.stdout, filter))
}

fn list_script(path: &str, filter: &Filter) -> String {
    // Prune name-only excludes inside `find` so big dirs like node_modules never leave the server.
    let prune = if filter.names.is_empty() {
        String::new()
    } else {
        let names: Vec<String> = filter.names.iter().map(|n| format!("-name {}", sq(n))).collect();
        format!("\\( {} \\) -prune -o", names.join(" -o "))
    };
    // GNU find has -printf; BSD/macOS falls back to stat -f.
    // Field separators are literal tab characters: BSD stat doesn't understand "\t".
    format!(
        "cd -- {dir} || exit 3\n\
         if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then\n\
           find . -mindepth 1 {prune} -printf '%y\t%s\t%T@\t%P\\n'\n\
         else\n\
           find . -mindepth 1 {prune} -exec stat -f '%Sp\t%z\t%m\t%N' {{}} +\n\
         fi",
        dir = rq(path),
    )
}

fn parse_listing(stdout: &[u8], filter: &Filter) -> BTreeMap<String, Entry> {
    let mut map = BTreeMap::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let mut parts = line.splitn(4, '\t');
        let (Some(t), Some(size), Some(mtime), Some(name)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let rel = name.strip_prefix("./").unwrap_or(name);
        if rel.is_empty() || filter.is_excluded_deep(rel) {
            continue;
        }
        let is_dir = t.starts_with('d');
        map.insert(
            rel.to_string(),
            Entry {
                is_dir,
                size: if is_dir { 0 } else { size.parse().unwrap_or(0) },
                mtime: mtime.parse().unwrap_or(0.0),
            },
        );
    }
    map
}

fn children_script(path: &str) -> String {
    format!(
        "cd -- {} || exit 3\n\
         for f in * .[!.]* ..?*; do\n\
           [ -e \"$f\" ] || [ -L \"$f\" ] || continue\n\
           if [ -d \"$f\" ]; then printf '%s/\\n' \"$f\"; else printf '%s\\n' \"$f\"; fi\n\
         done",
        rq(path)
    )
}

/// Reads NUL-separated relative paths on stdin, prints "<md5> <path>" lines.
/// GNU/BusyBox `md5sum`, BSD/macOS `md5 -r`, or `openssl md5 -r` as a last resort.
fn hash_script(path: &str) -> String {
    format!(
        "cd -- {} || exit 3\n\
         if command -v md5sum >/dev/null 2>&1; then exec xargs -0 md5sum --\n\
         elif command -v md5 >/dev/null 2>&1; then exec xargs -0 md5 -r --\n\
         else exec xargs -0 openssl md5 -r; fi",
        rq(path)
    )
}

fn parse_hashes(stdout: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        // md5sum: "<h>  <name>" (GNU prefixes "\\" if it escaped the name)
        // md5 -r: "<h> <name>"   openssl -r: "<h> *<name>"
        let line = line.strip_prefix('\\').unwrap_or(line);
        if line.len() < 34 || !line.is_char_boundary(32) {
            continue;
        }
        let (h, rest) = line.split_at(32);
        let Some(rest) = rest.strip_prefix(' ') else { continue };
        let name = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('*')).unwrap_or(rest);
        map.insert(name.to_string(), h.to_ascii_lowercase());
    }
    map
}

fn parse_children(stdout: &[u8]) -> Vec<Child> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| match l.strip_suffix('/') {
            Some(n) => Child { name: n.to_string(), is_dir: true },
            None => Child { name: l.to_string(), is_dir: false },
        })
        .collect()
}

/// Concrete host aliases from ~/.ssh/config (and files it `Include`s); wildcard patterns are skipped.
pub fn ssh_hosts() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return vec![];
    };
    let ssh_dir = PathBuf::from(home).join(".ssh");
    let mut hosts = Vec::new();
    let mut seen_files = std::collections::HashSet::new();
    read_ssh_config(&ssh_dir.join("config"), &ssh_dir, &mut hosts, &mut seen_files);
    let mut uniq = std::collections::HashSet::new();
    hosts.retain(|h| uniq.insert(h.clone()));
    hosts
}

fn read_ssh_config(
    file: &Path,
    ssh_dir: &Path,
    hosts: &mut Vec<String>,
    seen: &mut std::collections::HashSet<PathBuf>,
) {
    if !seen.insert(file.to_path_buf()) || seen.len() > 64 {
        return;
    }
    let Ok(text) = std::fs::read_to_string(file) else { return };
    for line in text.lines() {
        let line = line.trim();
        let (key, rest) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, r)) => (k.to_ascii_lowercase(), r.trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
            None => continue,
        };
        match key.as_str() {
            "host" => hosts.extend(
                rest.split_whitespace()
                    .filter(|h| !h.contains(['*', '?', '!']))
                    .map(|h| h.trim_matches('"').to_string()),
            ),
            "include" => {
                for pat in rest.split_whitespace() {
                    let pat = expand_tilde(pat.trim_matches('"'));
                    let pat = if pat.is_absolute() { pat } else { ssh_dir.join(pat) };
                    for f in expand_glob(&pat) {
                        read_ssh_config(&f, ssh_dir, hosts, seen);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Minimal glob expansion for Include paths (wildcards only in the last component).
fn expand_glob(p: &Path) -> Vec<PathBuf> {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains(['*', '?', '[']) {
        return vec![p.to_path_buf()];
    }
    let (Some(dir), Ok(g)) = (p.parent(), globset::Glob::new(&name)) else { return vec![] };
    let m = g.compile_matcher();
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|f| f.file_name().is_some_and(|n| m.is_match(n))).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn hash_local(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_endpoints() {
        assert!(matches!(parse("/tmp/x").unwrap(), Endpoint::Local(_)));
        assert!(matches!(parse("./x").unwrap(), Endpoint::Local(_)));
        #[cfg(windows)]
        assert!(matches!(parse("C:\\x").unwrap(), Endpoint::Local(_)));
        match parse("me@box:/srv/app").unwrap() {
            Endpoint::Ssh { host, path } => assert_eq!((host.as_str(), path.as_str()), ("me@box", "/srv/app")),
            _ => panic!(),
        }
        match parse("box:").unwrap() {
            Endpoint::Ssh { path, .. } => assert_eq!(path, "."),
            _ => panic!(),
        }
        assert_eq!(rq("~/a b"), "\"$HOME\"/'a b'");
        assert_eq!(sq("it's"), "'it'\\''s'");
    }

    #[test]
    fn split_endpoints() {
        let (d, n) = parse("h:/srv/app/x.bin").unwrap().split();
        assert_eq!((d.label(), n.as_str()), ("h:/srv/app".to_string(), "x.bin"));
        let (d, n) = parse("h:/x").unwrap().split();
        assert_eq!((d.label(), n.as_str()), ("h:/".to_string(), "x"));
        let (d, n) = parse("h:x").unwrap().split();
        assert_eq!((d.label(), n.as_str()), ("h:.".to_string(), "x"));
    }

    #[test]
    fn children_parse() {
        let c = parse_children(b"src/\nREADME.md\n.git/\n");
        assert_eq!(c.len(), 3);
        assert!(c[0].is_dir && c[0].name == "src");
        assert!(!c[1].is_dir);
    }

    #[test]
    fn children_script_runs_locally() {
        let base = std::env::temp_dir().join(format!("da-children-{}", std::process::id()));
        std::fs::create_dir_all(base.join("d")).unwrap();
        std::fs::write(base.join(".hidden"), "").unwrap();
        std::fs::write(base.join("a b.txt"), "").unwrap();
        let out = Command::new("sh").arg("-c").arg(children_script(base.to_str().unwrap())).output().unwrap();
        let mut names: Vec<String> = parse_children(&out.stdout)
            .into_iter()
            .map(|c| format!("{}{}", c.name, if c.is_dir { "/" } else { "" }))
            .collect();
        names.sort();
        assert_eq!(names, vec![".hidden", "a b.txt", "d/"]);
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Remote hash script (run through the local `sh`) must agree with the local hasher.
    #[test]
    fn hash_script_matches_local() {
        let base = std::env::temp_dir().join(format!("da-hash-{}", std::process::id()));
        std::fs::create_dir_all(base.join("d")).unwrap();
        std::fs::write(base.join("d/a b.txt"), "hello\n").unwrap();
        std::fs::write(base.join("e.bin"), [0u8, 1, 2, 3]).unwrap();
        let rels = ["d/a b.txt", "e.bin", "missing"];
        let mut input = Vec::new();
        for r in rels { input.extend_from_slice(r.as_bytes()); input.push(0); }
        let mut child = Command::new("sh")
            .arg("-c").arg(hash_script(base.to_str().unwrap()))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let remote = parse_hashes(&child.wait_with_output().unwrap().stdout);
        let local = Endpoint::Local(base.clone()).hash(&rels).unwrap();
        assert_eq!(remote.len(), 2);
        assert_eq!(remote, local);
        assert_eq!(local["d/a b.txt"], "b1946ac92492d2347c6235b4d2611184");
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Runs the remote listing script through the local `sh` (BSD find on macOS, GNU on Linux).
    #[test]
    fn remote_list_script_runs_locally() {
        let base = std::env::temp_dir().join(format!("da-remote-{}", std::process::id()));
        std::fs::create_dir_all(base.join("node_modules")).unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("node_modules/m.js"), "x").unwrap();
        std::fs::write(base.join("sub/it's a file.txt"), "hello").unwrap();
        std::fs::write(base.join("skip.log"), "").unwrap();
        let filter = Filter::new("node_modules, *.log").unwrap();
        let script = list_script(base.to_str().unwrap(), &filter);
        let out = Command::new("sh").arg("-c").arg(&script).output().unwrap();
        let map = parse_listing(&out.stdout, &filter);
        let keys: Vec<&str> = map.keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["sub", "sub/it's a file.txt"]);
        assert!(map["sub"].is_dir);
        assert_eq!(map["sub/it's a file.txt"].size, 5);
        assert!(map["sub/it's a file.txt"].mtime > 1.0e9);
        std::fs::remove_dir_all(base).unwrap();
    }
}
