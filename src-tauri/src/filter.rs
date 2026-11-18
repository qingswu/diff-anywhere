//! Exclude filters with gitignore-like semantics.
//!
//! Patterns are separated by commas, semicolons or newlines:
//! - `node_modules`, `*.log`, `.git`  -> no slash: matches that name at any depth
//! - `build/out`, `/dist`             -> contains a slash: matched against the path
//!                                       relative to the compared root
//! - a trailing `/` is accepted (`target/`) and simply ignored
//! Anything inside an excluded directory is excluded as well.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

pub struct Filter {
    set: GlobSet,
    /// Name-only patterns. Remote `find` uses them to prune early.
    pub names: Vec<String>,
    empty: bool,
}

impl Filter {
    pub fn new(spec: &str) -> Result<Self, String> {
        let mut b = GlobSetBuilder::new();
        let mut names = Vec::new();
        let mut count = 0;
        for raw in spec.split([',', ';', '\n']) {
            let p = raw.trim();
            if p.is_empty() || p.starts_with('#') {
                continue;
            }
            let p = p.trim_end_matches('/').trim_start_matches("./");
            let anchored = p.starts_with('/');
            let p = p.trim_start_matches('/');
            if p.is_empty() {
                continue;
            }
            let glob = if !anchored && !p.contains('/') {
                names.push(p.to_string());
                format!("**/{p}")
            } else {
                p.to_string()
            };
            let g = GlobBuilder::new(&glob)
                .literal_separator(true)
                .build()
                .map_err(|e| format!("bad filter pattern '{p}': {e}"))?;
            b.add(g);
            count += 1;
        }
        Ok(Filter {
            set: b.build().map_err(|e| e.to_string())?,
            names,
            empty: count == 0,
        })
    }

    /// Is this exact relative path excluded (ignores ancestors)?
    pub fn is_excluded(&self, rel: &str) -> bool {
        !self.empty && self.set.is_match(rel)
    }

    /// Is this path or any of its parent directories excluded?
    pub fn is_excluded_deep(&self, rel: &str) -> bool {
        if self.empty {
            return false;
        }
        rel.match_indices('/').any(|(i, _)| self.set.is_match(&rel[..i])) || self.set.is_match(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantics() {
        let f = Filter::new("node_modules, *.log; /dist\nsrc/gen/").unwrap();
        assert!(f.is_excluded("node_modules"));
        assert!(f.is_excluded("a/b/node_modules"));
        assert!(f.is_excluded_deep("a/node_modules/x/y.js"));
        assert!(f.is_excluded("x.log"));
        assert!(f.is_excluded("deep/x.log"));
        assert!(f.is_excluded("dist"));
        assert!(!f.is_excluded("a/dist"));
        assert!(f.is_excluded_deep("src/gen/file.rs"));
        assert!(!f.is_excluded_deep("src/main.rs"));
        assert_eq!(f.names, vec!["node_modules", "*.log"]);
        assert!(!Filter::new("").unwrap().is_excluded("anything"));
    }
}
