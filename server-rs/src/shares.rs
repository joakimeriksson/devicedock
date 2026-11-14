//! Host folders shared into the sandbox, chosen in the web page and mounted at /shares/<name>.
//!
//! Docker sets bind mounts only when a container is created, so a change takes effect when the sandbox is recreated
//! (`apply`). /workspace and the home folder are volumes and the root filesystem is read-only, so recreating loses
//! only running processes and /tmp.
//!
//! What may be shared is deliberately narrow: a folder strictly inside the user's home folder, with no hidden folder
//! on the way (~/.ssh, ~/.aws, ~/.docker with the Docker socket, agent logins ...), not ~/Library, and not a folder that
//! contains DeviceDock's own .runtime (bridge and admin tokens). Paths are resolved (symlinks followed) before checking.
//! Only the page, behind its session and CSRF token, can change shares; the sandbox has no route to this API.
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

pub const FILE: &str = ".runtime/shares.json";
pub const LABEL: &str = "devicedock.shares";
pub const MOUNT_ROOT: &str = "/shares";
const MAX_SHARES: usize = 16;
const MAX_LIST: usize = 500;

#[derive(Clone, Debug, PartialEq)]
pub struct Share {
    pub path: PathBuf,
    pub readonly: bool,
}

/// Where shares may come from: the home folder, minus DeviceDock's own secrets.
#[derive(Clone, Debug)]
pub struct Rules {
    pub home: PathBuf,
    pub runtime: Option<PathBuf>,
}

impl Rules {
    pub fn from_env() -> Result<Rules, String> {
        let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).ok_or("HOME is not set")?;
        let home = std::fs::canonicalize(home).map_err(|e| format!("home folder: {e}"))?;
        let runtime = std::fs::canonicalize(".runtime").ok();
        Ok(Rules { home, runtime })
    }

    /// `~/x` for paths in the home folder (what the page shows), the full path otherwise.
    pub fn display(&self, p: &Path) -> String {
        match p.strip_prefix(&self.home) {
            Ok(r) if r.as_os_str().is_empty() => "~".into(),
            Ok(r) => format!("~/{}", r.display()),
            Err(_) => p.display().to_string(),
        }
    }

    fn expand(&self, input: &str) -> Result<PathBuf, String> {
        let s = input.trim();
        let p = if s == "~" {
            self.home.clone()
        } else if let Some(rest) = s.strip_prefix("~/") {
            self.home.join(rest)
        } else {
            PathBuf::from(s)
        };
        if !p.is_absolute() {
            return Err("Use a full path, like ~/work/my-project".into());
        }
        Ok(p)
    }

    /// Resolves a typed or browsed path and returns it if it may be shared.
    pub fn check(&self, input: &str) -> Result<PathBuf, String> {
        let p = self.expand(input)?;
        let canon = std::fs::canonicalize(&p).map_err(|_| format!("Folder not found: {}", input.trim()))?;
        if !canon.is_dir() {
            return Err(format!("Not a folder: {}", self.display(&canon)));
        }
        self.allowed(&canon)?;
        Ok(canon)
    }

    /// The rules on an already resolved path.
    fn allowed(&self, canon: &Path) -> Result<(), String> {
        let Ok(rel) = canon.strip_prefix(&self.home) else {
            return Err(format!("Only folders inside your home folder ({}) can be shared.", self.home.display()));
        };
        if rel.as_os_str().is_empty() {
            return Err("Your whole home folder cannot be shared: it holds your keys and logins. Pick a project folder inside it.".into());
        }
        for (i, c) in rel.components().enumerate() {
            let Component::Normal(c) = c else { return Err("Unexpected path".into()) };
            let c = c.to_string_lossy();
            if c.starts_with('.') {
                return Err(format!("Hidden folders ({c}) are not shared: they usually hold keys, logins or settings."));
            }
            if i == 0 && c == "Library" {
                return Err("~/Library holds app data and logins; it is not shared.".into());
            }
        }
        if self.runtime.as_ref().is_some_and(|r| r.starts_with(canon)) {
            return Err("This folder contains DeviceDock itself and its secrets (.runtime). Share a folder that does not include it.".into());
        }
        // Docker's --mount value is comma separated; refuse rather than risk a misparsed mount.
        let s = canon.to_string_lossy();
        if s.contains(',') || s.contains('"') || s.chars().any(char::is_control) {
            return Err("Folder names with commas, quotes or control characters cannot be shared.".into());
        }
        Ok(())
    }
}

/// Mount name in the sandbox: the folder's own name, made safe and unique.
pub fn names(shares: &[Share]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in shares {
        let base: String = s
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
            .collect();
        let base = base.trim_start_matches(['.', '-']).chars().take(40).collect::<String>();
        let base = if base.is_empty() { "share".to_string() } else { base };
        let mut name = base.clone();
        let mut n = 2;
        while out.contains(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        out.push(name);
    }
    out
}

pub fn load() -> Vec<Share> {
    let Ok(text) = std::fs::read_to_string(FILE) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
    v.get("shares")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let path = s.get("path")?.as_str()?;
                    Some(Share { path: PathBuf::from(path), readonly: s.get("readonly").and_then(Value::as_bool).unwrap_or(false) })
                })
                .take(MAX_SHARES)
                .collect()
        })
        .unwrap_or_default()
}

fn save(shares: &[Share]) -> Result<(), String> {
    crate::sandbox::ensure_runtime_dir().map_err(|e| e.to_string())?;
    let v = json!({"shares": shares.iter().map(|s| json!({"path": s.path, "readonly": s.readonly})).collect::<Vec<_>>()});
    crate::sandbox::write_secret(FILE, &serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())
}

/// Validates the page's list ({shares: [{path, readonly}]}) and stores it. Takes effect at the next (re)create.
pub fn set(rules: &Rules, body: &Value) -> Result<(), String> {
    let list = body.get("shares").and_then(Value::as_array).ok_or("shares must be a list")?;
    if list.len() > MAX_SHARES {
        return Err(format!("At most {MAX_SHARES} shared folders"));
    }
    let mut out: Vec<Share> = Vec::new();
    for s in list {
        let path = s.get("path").and_then(Value::as_str).ok_or("each share needs a path")?;
        let readonly = s.get("readonly").and_then(Value::as_bool).unwrap_or(false);
        let canon = match rules.check(path) {
            Ok(c) => c,
            // A folder that disappeared since it was added may stay on the list (it is skipped when mounting),
            // but only if it was already there: new entries must pass the check.
            Err(e) => match load().into_iter().find(|old| old.path == Path::new(path)) {
                Some(old) => old.path,
                None => return Err(e),
            },
        };
        if out.iter().any(|o| o.path == canon) {
            continue;
        }
        if let Some(o) = out.iter().find(|o| o.path.starts_with(&canon) || canon.starts_with(&o.path)) {
            return Err(format!("{} overlaps {}; share one or the other.", rules.display(&canon), rules.display(&o.path)));
        }
        out.push(Share { path: canon, readonly });
    }
    save(&out)
}

/// The shares that can be mounted now (folder still exists and still passes the rules), with their names.
fn mountable(rules: &Rules, shares: &[Share]) -> Vec<(Share, String)> {
    let names = names(shares);
    shares
        .iter()
        .zip(names)
        .filter(|(s, _)| problem(rules, s).is_none())
        .map(|(s, n)| (s.clone(), n))
        .collect()
}

fn problem(rules: &Rules, s: &Share) -> Option<String> {
    match std::fs::canonicalize(&s.path) {
        Ok(c) if c == s.path && c.is_dir() => rules.allowed(&c).err(),
        Ok(_) => Some("The folder moved or is now a link; remove it and add it again.".into()),
        Err(_) => Some("Folder not found; it is skipped until it is back.".into()),
    }
}

/// What the running container should carry: compared with its label to tell whether a restart is needed.
pub fn spec(rules: &Rules) -> String {
    let m = mountable(rules, &load());
    json!(m.iter().map(|(s, n)| json!([n, s.path, s.readonly])).collect::<Vec<_>>()).to_string()
}

/// `docker run` arguments for the shares plus the label recording them.
pub fn run_args(rules: &Rules) -> Vec<String> {
    let mut a = vec![];
    for (s, name) in mountable(rules, &load()) {
        a.push("--mount".into());
        a.push(format!(
            "type=bind,src={},dst={MOUNT_ROOT}/{name}{}",
            s.path.display(),
            if s.readonly { ",readonly" } else { "" }
        ));
    }
    a.push("--label".into());
    a.push(format!("{LABEL}={}", spec(rules)));
    a
}

pub async fn view() -> Value {
    let rules = match Rules::from_env() {
        Ok(r) => r,
        Err(e) => return json!({"shares": [], "error": e}),
    };
    let shares = load();
    let names = names(&shares);
    let list: Vec<Value> = shares
        .iter()
        .zip(&names)
        .map(|(s, n)| {
            let mut v = json!({
                "path": s.path, "display": rules.display(&s.path), "readonly": s.readonly,
                "target": format!("{MOUNT_ROOT}/{n}"),
            });
            if let Some(p) = problem(&rules, s) {
                v["problem"] = json!(p);
            }
            v
        })
        .collect();
    let label = crate::sandbox::docker(&[
        "inspect", "--format", &format!("{{{{index .Config.Labels \"{LABEL}\"}}}}"), crate::sandbox::CONTAINER,
    ])
    .await
    .ok();
    // No container yet: the shares are used when it is created. A container from before shares existed has no label.
    let current = label.map(|l| if l.is_empty() || l == "<no value>" { "[]".to_string() } else { l });
    let pending = current.as_ref().is_some_and(|c| *c != spec(&rules));
    json!({"shares": list, "container": current.is_some(), "pending": pending, "home": rules.home})
}

/// Lists the subfolders of `path` (default: home) that the page may browse into, and whether `path` may be shared.
pub fn browse(rules: &Rules, path: Option<&str>) -> Result<Value, String> {
    let dir = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => std::fs::canonicalize(rules.expand(p)?).map_err(|_| format!("Folder not found: {p}"))?,
        None => rules.home.clone(),
    };
    let Ok(rel) = dir.strip_prefix(&rules.home) else {
        return Err("Browsing is limited to your home folder.".into());
    };
    for (i, c) in rel.components().enumerate() {
        let c = c.as_os_str().to_string_lossy();
        if c.starts_with('.') || (i == 0 && c == "Library") {
            return Err("Hidden folders and ~/Library are not browsed.".into());
        }
    }
    let mut dirs: Vec<Value> = vec![];
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("Cannot list {}: {e}", rules.display(&dir)))?;
    let mut entries: Vec<(String, PathBuf)> = rd
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(n, _)| !n.starts_with('.') && !(dir == rules.home && n == "Library"))
        .collect();
    entries.sort_by_key(|(n, _)| n.to_lowercase());
    let more = entries.len() > MAX_LIST;
    for (name, p) in entries.into_iter().take(MAX_LIST) {
        dirs.push(json!({"name": name, "path": p}));
    }
    let shareable = rules.allowed(&dir);
    Ok(json!({
        "path": dir,
        "display": rules.display(&dir),
        "parent": (dir != rules.home).then(|| dir.parent().map(Path::to_path_buf)).flatten(),
        "dirs": dirs,
        "more": more,
        "shareable": shareable.is_ok(),
        "reason": shareable.err(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_home() -> (PathBuf, Rules) {
        let base = std::env::temp_dir().join(format!("dd-shares-{}", crate::sandbox::random_hex()));
        for d in ["work/proj", "work/other", ".ssh", "Library/Keys", "dock/.runtime", "work/proj/.git", "a,b"] {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
        std::fs::write(base.join("file.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(base.join(".ssh"), base.join("work/keys")).unwrap();
        let home = std::fs::canonicalize(&base).unwrap();
        let runtime = Some(home.join("dock/.runtime"));
        (base, Rules { home, runtime })
    }

    #[test]
    fn what_may_be_shared() {
        let (base, r) = fake_home();
        assert_eq!(r.check("~/work/proj").unwrap(), r.home.join("work/proj"));
        assert!(r.check(&format!("{}/work", base.display())).is_ok());
        let no = |p: &str, why: &str| {
            let e = r.check(p).unwrap_err();
            assert!(e.contains(why), "{p}: {e}");
        };
        no("~", "whole home folder");
        no("~/", "whole home folder");
        no("~/.ssh", "Hidden");
        no("~/work/proj/.git", "Hidden");
        no("~/work/keys", "Hidden"); // a link into ~/.ssh is judged by where it points
        no("~/Library/Keys", "Library");
        no("~/dock", "DeviceDock");
        no("~/work/../dock", "DeviceDock");
        no("~/file.txt", "Not a folder");
        no("~/missing", "not found");
        no("/", "Only folders inside");
        no("/tmp", "Only folders inside");
        no("work/proj", "full path");
        no("~/a,b", "commas");
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn mount_names_are_safe_and_unique() {
        let s = |p: &str| Share { path: PathBuf::from(p), readonly: false };
        let n = names(&[s("/h/a/proj"), s("/h/b/proj"), s("/h/My Project!"), s("/h/.x"), s("/h/b/proj-2")]);
        assert_eq!(n, ["proj", "proj-2", "My-Project-", "x", "proj-2-2"]);
    }

    #[test]
    fn browse_stays_in_home_and_hides_secrets() {
        let (base, r) = fake_home();
        let v = browse(&r, None).unwrap();
        let names: Vec<&str> = v["dirs"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["a,b", "dock", "work"]);
        assert_eq!(v["shareable"], false);
        assert!(v["parent"].is_null());
        let w = browse(&r, Some("~/work")).unwrap();
        assert_eq!(w["shareable"], true);
        assert_eq!(w["display"], "~/work");
        assert!(browse(&r, Some("/")).is_err());
        assert!(browse(&r, Some("~/..")).is_err());
        assert!(browse(&r, Some("~/.ssh")).is_err());
        assert!(browse(&r, Some("~/work/keys")).is_err()); // link into ~/.ssh
        assert!(browse(&r, Some("~/Library")).is_err());
        std::fs::remove_dir_all(base).ok();
    }
}
