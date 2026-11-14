//! Network firewall for the sandbox. The sandbox runs with `--network none`; its only way out is the tunnel
//! (tunnel.rs) to this backend, which acts as the HTTP(S) proxy: it lets through the host names on the human's allow
//! list, asks the human (Allow / Block in the page) about any other host, and connects out from the host itself.
//!
//! Rules: host names only (an IP address is refused), ports 80 and 443 unless an entry names another port, and a
//! name that resolves to a private, loopback or link-local address is refused, so an allowed name can never be
//! used to reach the laptop or the local network. The policy lives in .runtime/firewall.json (mode 0600).
use crate::sandbox::{docker, CONTAINER};
use crate::tunnel::{Incoming, Mux, Side, SANDBOX_BIN};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

const POLICY_FILE: &str = ".runtime/firewall.json";
const ASK: Duration = Duration::from_secs(30);
const DENY_FOR_MS: i64 = 10 * 60 * 1000;
const MAX_LOG: usize = 200;
const MAX_PENDING: usize = 32;
const MAX_HEAD: usize = 16 * 1024;

/// Environment for the sandbox: every common tool (curl, git, pip, npm, Claude Code, Codex) honours these.
pub const PROXY_ENV: [&str; 6] = [
    "HTTP_PROXY=http://127.0.0.1:3128",
    "HTTPS_PROXY=http://127.0.0.1:3128",
    "http_proxy=http://127.0.0.1:3128",
    "https_proxy=http://127.0.0.1:3128",
    "NO_PROXY=localhost,127.0.0.1",
    "no_proxy=localhost,127.0.0.1",
];

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub hosts: &'static [&'static str],
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "agents",
        label: "AI agents (Claude, Codex, OpenCode)",
        hosts: &[
            "api.anthropic.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com", "sentry.io",
            "api.openai.com", "auth.openai.com", "chatgpt.com", "*.chatgpt.com", "opencode.ai", "models.dev",
        ],
    },
    Preset {
        id: "code",
        label: "GitHub and package registries (npm, PyPI)",
        hosts: &[
            "github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org", "pypi.org",
            "files.pythonhosted.org",
        ],
    },
    Preset {
        id: "embedded",
        label: "Embedded toolchains (ESP-IDF, PlatformIO, Arm)",
        hosts: &["dl.espressif.com", "*.espressif.com", "components.espressif.com", "*.platformio.org", "developer.arm.com"],
    },
];

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Policy {
    pub mode: String,
    pub allow: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        let allow = PRESETS.iter().flat_map(|p| p.hosts.iter().map(|h| h.to_string())).collect();
        Policy { mode: "allowlist".into(), allow }
    }
}

/// A DNS name (lower case, no IP address). Single-label names are allowed as targets, not as list entries.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-'))
        && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
        && !name.bytes().all(|c| c.is_ascii_digit() || c == b'.')
}

fn parse_port(p: &str) -> Option<u16> {
    if p.is_empty() || p.len() > 5 || !p.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    p.parse::<u16>().ok().filter(|n| *n != 0)
}

/// An allow-list entry: `example.com`, `*.example.com`, optionally `:port`.
pub fn valid_entry(e: &str) -> bool {
    let (name, port) = match e.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (e, None),
    };
    if port.is_some_and(|p| parse_port(p).is_none()) {
        return false;
    }
    let name = name.strip_prefix("*.").unwrap_or(name);
    name.contains('.') && valid_name(name)
}

/// Parses a policy from the page: mode + allow list (lower-cased, deduplicated, validated).
pub fn parse_policy(v: &Value) -> Result<Policy, String> {
    let mode = v.get("mode").and_then(Value::as_str).ok_or("mode is required")?;
    if !["offline", "allowlist", "open"].contains(&mode) {
        return Err("mode must be offline, allowlist or open".into());
    }
    let list = v.get("allow").and_then(Value::as_array).ok_or("allow must be a list")?;
    if list.len() > 500 {
        return Err("at most 500 entries".into());
    }
    let mut allow: Vec<String> = Vec::new();
    for e in list {
        let e = e.as_str().ok_or("entries must be strings")?.trim().trim_end_matches('.').to_ascii_lowercase();
        if !valid_entry(&e) {
            return Err(format!("not a host name: {e} (use example.com, *.example.com or example.com:8080)"));
        }
        if !allow.contains(&e) {
            allow.push(e);
        }
    }
    Ok(Policy { mode: mode.into(), allow })
}

fn allowed_by_list(p: &Policy, host: &str, port: u16) -> bool {
    p.allow.iter().any(|entry| {
        let (name, eport) = match entry.rsplit_once(':') {
            Some((n, pt)) => (n, parse_port(pt)),
            None => (entry.as_str(), None),
        };
        let port_ok = match eport {
            Some(p) => p == port,
            None => port == 443 || port == 80,
        };
        port_ok && (name == host || name.strip_prefix('*').is_some_and(|suffix| host.ends_with(suffix)))
    })
}

/// True for addresses on the public internet. Everything that could reach the laptop, the local network, Docker's
/// networks or a cloud metadata service is refused.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => public_v4(a),
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = a.segments();
            // NAT64 (64:ff9b::/96) carries an IPv4 address in its last 32 bits.
            if s[0..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return public_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            !(a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || a == Ipv6Addr::from(0u128))
        }
    }
}

fn public_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    !(a.is_private()
        || a.is_loopback()
        || a.is_link_local()
        || a.is_broadcast()
        || a.is_documentation()
        || a.is_unspecified()
        || a.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64/10 carrier-grade NAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18/15 benchmarking
        || o[0] >= 240)
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Verdict {
    Allowed,
    Approved,
    Blocked,
    Denied,
    Timeout,
}

impl Verdict {
    fn ok(self) -> bool {
        matches!(self, Verdict::Allowed | Verdict::Approved)
    }
    fn name(self) -> &'static str {
        match self {
            Verdict::Allowed => "allowed",
            Verdict::Approved => "approved",
            Verdict::Blocked => "blocked",
            Verdict::Denied => "denied",
            Verdict::Timeout => "timeout",
        }
    }
}

struct Pending {
    id: String,
    host: String,
    port: u16,
    t: i64,
    waiters: Vec<oneshot::Sender<Verdict>>,
}

#[derive(Default)]
struct Live {
    pending: HashMap<String, Pending>,
    denied: HashMap<String, i64>,
    log: VecDeque<Value>,
}

/// How the sandbox container is connected.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NetMode {
    /// `--network none` + the tunnel: the firewall applies.
    Tunnel,
    /// Created before the firewall, or from an image without the tunnel: open network, published bridge port.
    Open,
    /// No sandbox running (yet).
    Absent,
}

pub struct Firewall {
    policy: Mutex<Policy>,
    live: Mutex<Live>,
    mode: Mutex<NetMode>,
    mux: Mutex<Option<Mux>>,
    policy_file: Option<PathBuf>,
    ask: Duration,
    /// Tests only: let names resolve to loopback.
    allow_private: bool,
}

impl Default for Firewall {
    fn default() -> Self {
        Self::new()
    }
}

impl Firewall {
    pub fn new() -> Firewall {
        let policy = std::fs::read_to_string(POLICY_FILE)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| parse_policy(&v).ok())
            .unwrap_or_default();
        Firewall::with(policy, Some(POLICY_FILE.into()), ASK, false)
    }

    fn with(policy: Policy, policy_file: Option<PathBuf>, ask: Duration, allow_private: bool) -> Firewall {
        Firewall {
            policy: Mutex::new(policy),
            live: Mutex::default(),
            mode: Mutex::new(NetMode::Absent),
            mux: Mutex::new(None),
            policy_file,
            ask,
            allow_private,
        }
    }

    pub fn policy(&self) -> Policy {
        self.policy.lock().unwrap().clone()
    }

    pub fn mode(&self) -> NetMode {
        *self.mode.lock().unwrap()
    }

    pub fn mux(&self) -> Option<Mux> {
        self.mux.lock().unwrap().clone().filter(|m| !m.is_closed())
    }

    fn record(&self, host: &str, port: u16, result: &str) {
        let mut live = self.live.lock().unwrap();
        live.log.push_back(json!({"t": crate::broker::now_ms(), "host": host, "port": port, "result": result}));
        while live.log.len() > MAX_LOG {
            live.log.pop_front();
        }
    }

    pub fn set_policy(&self, p: Policy) -> Result<(), String> {
        if let Some(f) = &self.policy_file {
            let json = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;
            crate::sandbox::write_secret(&f.to_string_lossy(), &json).map_err(|e| e.to_string())?;
        }
        *self.policy.lock().unwrap() = p.clone();
        // A new policy answers whatever it now decides.
        let keys: Vec<(String, Verdict)> = {
            let live = self.live.lock().unwrap();
            live.pending
                .iter()
                .filter_map(|(k, q)| match p.mode.as_str() {
                    "open" => Some((k.clone(), Verdict::Approved)),
                    "offline" => Some((k.clone(), Verdict::Blocked)),
                    _ if allowed_by_list(&p, &q.host, q.port) => Some((k.clone(), Verdict::Approved)),
                    _ => None,
                })
                .collect()
        };
        for (k, v) in keys {
            self.settle(&k, v);
        }
        Ok(())
    }

    fn settle(&self, key: &str, v: Verdict) {
        let q = {
            let mut live = self.live.lock().unwrap();
            if v == Verdict::Denied {
                live.denied.insert(key.to_string(), crate::broker::now_ms() + DENY_FOR_MS);
            }
            live.pending.remove(key)
        };
        if let Some(q) = q {
            for w in q.waiters {
                let _ = w.send(v);
            }
        }
    }

    /// Decides one outgoing connection; for an unknown host in allow-list mode, waits for the human.
    pub async fn decide(self: &Arc<Self>, host: &str, port: u16) -> Verdict {
        let rx = {
            let p = self.policy.lock().unwrap();
            match p.mode.as_str() {
                "open" => return Verdict::Allowed,
                "offline" => return Verdict::Blocked,
                _ if allowed_by_list(&p, host, port) => return Verdict::Allowed,
                _ => {}
            }
            let key = format!("{host}:{port}");
            let mut live = self.live.lock().unwrap();
            let now = crate::broker::now_ms();
            live.denied.retain(|_, until| *until > now);
            if live.denied.contains_key(&key) {
                return Verdict::Blocked;
            }
            let (tx, rx) = oneshot::channel();
            if let Some(q) = live.pending.get_mut(&key) {
                q.waiters.push(tx);
            } else {
                if live.pending.len() >= MAX_PENDING {
                    return Verdict::Blocked;
                }
                let id = uuid::Uuid::new_v4().to_string();
                live.pending.insert(key.clone(), Pending { id: id.clone(), host: host.into(), port, t: now, waiters: vec![tx] });
                let me = self.clone();
                let ask = self.ask;
                tokio::spawn(async move {
                    tokio::time::sleep(ask).await;
                    let same = me.live.lock().unwrap().pending.get(&key).is_some_and(|q| q.id == id);
                    if same {
                        me.settle(&key, Verdict::Timeout);
                    }
                });
            }
            rx
        };
        rx.await.unwrap_or(Verdict::Blocked)
    }

    /// The page's answer. Allow puts the host on the list (which answers every waiting connection to it).
    pub fn answer(&self, id: &str, allow: bool) -> Result<(), String> {
        let found = {
            let live = self.live.lock().unwrap();
            live.pending.iter().find(|(_, q)| q.id == id).map(|(k, q)| (k.clone(), q.host.clone(), q.port))
        };
        let (key, host, port) = found.ok_or("That request is no longer waiting.")?;
        if !allow {
            self.settle(&key, Verdict::Denied);
            return Ok(());
        }
        let entry = if port == 443 || port == 80 { host } else { format!("{host}:{port}") };
        let mut p = self.policy();
        if !p.allow.contains(&entry) {
            p.allow.push(entry);
        }
        self.set_policy(p)
    }

    /// The page's view: policy, presets, whether the firewall is in force, waiting questions, recent connections.
    pub fn view(&self) -> Value {
        let (active, reason) = match (self.mode(), self.mux().is_some()) {
            (NetMode::Tunnel, true) => (true, None),
            (NetMode::Tunnel, false) => (false, Some("Connecting to the sandbox…")),
            (NetMode::Open, _) => (
                false,
                Some("This sandbox has open internet: it was created before the firewall, or from an older image. Get a current image (console: i to build, or p to download) and recreate the sandbox (rs)."),
            ),
            (NetMode::Absent, _) => (false, Some("The sandbox is not running.")),
        };
        let live = self.live.lock().unwrap();
        let mut pending: Vec<&Pending> = live.pending.values().collect();
        pending.sort_by_key(|q| q.t);
        json!({
            "active": active,
            "reason": reason,
            "policy": self.policy(),
            "presets": PRESETS.iter().map(|p| json!({"id": p.id, "label": p.label, "hosts": p.hosts})).collect::<Vec<_>>(),
            "pending": pending.iter().map(|q| json!({"id": q.id, "host": q.host, "port": q.port, "t": q.t})).collect::<Vec<_>>(),
            "log": live.log.iter().rev().take(100).rev().cloned().collect::<Vec<_>>(),
        })
    }

    /// Keeps `devicedock tunnel` running in the sandbox while the sandbox runs with `--network none`.
    pub async fn run_tunnel(self: Arc<Self>) {
        loop {
            let mode = network_mode().await;
            *self.mode.lock().unwrap() = mode;
            if mode == NetMode::Tunnel {
                if let Err(e) = self.tunnel_once().await {
                    debug(&format!("tunnel: {e}"));
                }
                *self.mux.lock().unwrap() = None;
            }
            // Quick restart while the sandbox runs; otherwise just watch for it to appear.
            let wait = if mode == NetMode::Tunnel { 1 } else { 3 };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    }

    async fn tunnel_once(self: &Arc<Self>) -> Result<(), String> {
        use std::process::Stdio;
        let mut child = tokio::process::Command::new("docker")
            .args(["exec", "-i", CONTAINER, SANDBOX_BIN, "tunnel"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let (stdin, stdout, stderr) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                debug(&format!("tunnel (sandbox): {}", l.chars().take(300).collect::<String>()));
            }
        });
        let (mux, mut incoming) = Mux::start(stdout, stdin, Side::Backend);
        *self.mux.lock().unwrap() = Some(mux.clone());
        loop {
            tokio::select! {
                inc = incoming.recv() => match inc {
                    Some(Incoming { target, stream }) if target == b"proxy" => {
                        let me = self.clone();
                        tokio::spawn(async move { me.serve_proxy(stream).await });
                    }
                    Some(_) => {} // dropped: only proxy streams may come from the sandbox
                    None => break,
                },
                _ = mux.closed() => break,
                s = child.wait() => {
                    mux.close();
                    return Err(format!("tunnel exited ({})", s.map(|s| s.to_string()).unwrap_or_default()));
                }
            }
        }
        mux.close();
        let _ = child.kill().await;
        Ok(())
    }

    /// One proxied connection from the sandbox: CONNECT host:port (HTTPS) or an absolute-form http:// request.
    pub async fn serve_proxy(self: &Arc<Self>, mut s: DuplexStream) {
        let mut buf = Vec::with_capacity(2048);
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                if i > MAX_HEAD {
                    return reply(&mut s, 431, "Request header too large").await;
                }
                break i + 4;
            }
            if buf.len() > MAX_HEAD {
                return reply(&mut s, 431, "Request header too large").await;
            }
            let mut chunk = [0u8; 4096];
            match tokio::time::timeout(Duration::from_secs(30), s.read(&mut chunk)).await {
                Ok(Ok(n)) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                _ => return,
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let rest = buf[head_end..].to_vec();
        let mut lines = head.split("\r\n");
        let first = lines.next().unwrap_or("");
        let mut parts = first.split(' ');
        let (method, target, version) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if !version.starts_with("HTTP/1.") {
            return reply(&mut s, 400, "Bad request").await;
        }
        let connect = method.eq_ignore_ascii_case("CONNECT");
        let (authority, path) = if connect {
            (target, "")
        } else {
            let lower = target.to_ascii_lowercase();
            let Some(after) = lower.strip_prefix("http://").map(|_| &target[7..]) else {
                return reply(&mut s, 400, "DeviceDock firewall: only http:// requests and CONNECT (for https) go through this proxy.").await;
            };
            match after.find('/') {
                Some(i) => (&after[..i], &after[i..]),
                None => (after, "/"),
            }
        };
        let Some((host, port)) = split_authority(authority, if connect { 443 } else { 80 }) else {
            return reply(&mut s, 400, "DeviceDock firewall: bad host").await;
        };
        if host.parse::<IpAddr>().is_ok() || host.starts_with('[') {
            self.record(&host, port, "blocked");
            return reply(&mut s, 403, &format!("DeviceDock firewall: {host} is an IP address. Only host names can be allowed; use the name.")).await;
        }
        if !valid_name(&host) {
            return reply(&mut s, 400, "DeviceDock firewall: bad host name").await;
        }
        let verdict = self.decide(&host, port).await;
        if !verdict.ok() {
            self.record(&host, port, verdict.name());
            let why = if verdict == Verdict::Timeout { " (nobody answered in the page)" } else { "" };
            return reply(&mut s, 403, &format!(
                "DeviceDock firewall: {host} is not allowed{why}. Ask the human to allow it in the DeviceDock page (Network)."
            ))
            .await;
        }
        let addrs: Vec<SocketAddr> = match tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host((host.as_str(), port))).await {
            Ok(Ok(a)) => a.collect(),
            _ => {
                self.record(&host, port, "failed");
                return reply(&mut s, 502, &format!("DeviceDock firewall: cannot resolve {host}")).await;
            }
        };
        let public: Vec<SocketAddr> = addrs.iter().copied().filter(|a| self.allow_private || is_public(a.ip())).collect();
        if public.is_empty() {
            self.record(&host, port, "private");
            return reply(&mut s, 403, &format!(
                "DeviceDock firewall: {host} points to a private or local address; the sandbox may not reach the laptop or the local network."
            ))
            .await;
        }
        let mut upstream = None;
        for a in &public {
            if let Ok(Ok(c)) = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(a)).await {
                upstream = Some(c);
                break;
            }
        }
        let Some(mut up) = upstream else {
            self.record(&host, port, "failed");
            return reply(&mut s, 502, &format!("DeviceDock firewall: cannot connect to {host}:{port}")).await;
        };
        self.record(&host, port, verdict.name());
        if connect {
            if s.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.is_err() {
                return;
            }
        } else {
            // Origin-form request line; proxy headers removed; one request per connection.
            let mut out = format!("{method} {path} {version}\r\n");
            for l in lines.filter(|l| !l.is_empty()) {
                let name = l.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
                if !["proxy-connection", "proxy-authorization", "connection", "keep-alive"].contains(&name.as_str()) {
                    out.push_str(l);
                    out.push_str("\r\n");
                }
            }
            out.push_str("Connection: close\r\n\r\n");
            if up.write_all(out.as_bytes()).await.is_err() {
                return;
            }
        }
        if !rest.is_empty() && up.write_all(&rest).await.is_err() {
            return;
        }
        let _ = tokio::io::copy_bidirectional(&mut s, &mut up).await;
    }
}

fn split_authority(a: &str, default_port: u16) -> Option<(String, u16)> {
    if a.is_empty() || a.contains('@') {
        return None;
    }
    if a.starts_with('[') {
        let end = a.find(']')?;
        let port = match &a[end + 1..] {
            "" => default_port,
            p => parse_port(p.strip_prefix(':')?)?,
        };
        return Some((a[..=end].to_string(), port));
    }
    let (h, p) = match a.rsplit_once(':') {
        Some((h, p)) => (h, parse_port(p)?),
        None => (a, default_port),
    };
    Some((h.trim_end_matches('.').to_ascii_lowercase(), p))
}

async fn reply(s: &mut DuplexStream, code: u16, msg: &str) {
    let reason = match code {
        400 => "Bad Request",
        403 => "Forbidden",
        431 => "Request Header Fields Too Large",
        _ => "Bad Gateway",
    };
    let body = format!("{msg}\n");
    let r = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(r.as_bytes()).await;
    let _ = s.shutdown().await;
}

fn debug(msg: &str) {
    if std::env::var_os("DEVICEDOCK_DEBUG").is_some() {
        eprintln!("{msg}");
    }
}

/// Reads how the running sandbox was created (label `devicedock.network`).
pub async fn network_mode() -> NetMode {
    match docker(&["inspect", "--format", "{{.State.Running}}|{{index .Config.Labels \"devicedock.network\"}}", CONTAINER]).await {
        Ok(s) if s.starts_with("true|") => {
            if s.ends_with("|tunnel") {
                NetMode::Tunnel
            } else {
                NetMode::Open
            }
        }
        _ => NetMode::Absent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn fw(mode: &str, allow: &[&str], allow_private: bool) -> Arc<Firewall> {
        let p = Policy { mode: mode.into(), allow: allow.iter().map(|s| s.to_string()).collect() };
        Arc::new(Firewall::with(p, None, Duration::from_millis(300), allow_private))
    }

    #[test]
    fn entries() {
        for ok in ["github.com", "*.github.com", "example.com:8080", "a-b.c.io"] {
            assert!(valid_entry(ok), "{ok}");
        }
        for bad in ["", "localhost", "10.0.0.1", "*.com:0", "ex ample.com", "-a.com", "a.com:99999", "*", "a.com:", "EXAMPLE.com"] {
            assert!(!valid_entry(bad), "{bad}");
        }
    }

    #[test]
    fn parse_normalises() {
        let p = parse_policy(&json!({"mode": "allowlist", "allow": [" GitHub.com. ", "github.com", "*.npmjs.org"]})).unwrap();
        assert_eq!(p.allow, vec!["github.com", "*.npmjs.org"]);
        assert!(parse_policy(&json!({"mode": "wide", "allow": []})).is_err());
        assert!(parse_policy(&json!({"mode": "open", "allow": ["192.168.1.1"]})).is_err());
    }

    #[test]
    fn default_policy_is_valid() {
        let d = Policy::default();
        assert!(d.allow.iter().all(|e| valid_entry(e)));
        assert_eq!(d.mode, "allowlist");
    }

    #[test]
    fn list_matching() {
        let p = Policy { mode: "allowlist".into(), allow: vec!["github.com".into(), "*.npmjs.org".into(), "mqtt.example.com:8883".into()] };
        assert!(allowed_by_list(&p, "github.com", 443));
        assert!(allowed_by_list(&p, "github.com", 80));
        assert!(!allowed_by_list(&p, "github.com", 22));
        assert!(!allowed_by_list(&p, "api.github.com", 443)); // exact entry
        assert!(!allowed_by_list(&p, "evilgithub.com", 443));
        assert!(allowed_by_list(&p, "registry.npmjs.org", 443));
        assert!(!allowed_by_list(&p, "npmjs.org", 443)); // *. means subdomains
        assert!(!allowed_by_list(&p, "evilnpmjs.org", 443));
        assert!(allowed_by_list(&p, "mqtt.example.com", 8883));
        assert!(!allowed_by_list(&p, "mqtt.example.com", 443));
    }

    #[test]
    fn private_addresses_are_refused() {
        for a in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1",
            "0.0.0.0", "255.255.255.255", "224.0.0.1", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "fc12::1",
            "::ffff:192.168.1.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1",
        ] {
            assert!(!is_public(a.parse().unwrap()), "{a}");
        }
        for a in ["1.1.1.1", "140.82.112.3", "172.32.0.1", "2606:4700::1111", "64:ff9b::101:101", "::ffff:8.8.8.8"] {
            assert!(is_public(a.parse().unwrap()), "{a}");
        }
    }

    #[test]
    fn authority() {
        assert_eq!(split_authority("GitHub.com:443", 443), Some(("github.com".into(), 443)));
        assert_eq!(split_authority("example.com", 80), Some(("example.com".into(), 80)));
        assert_eq!(split_authority("[::1]:443", 443), Some(("[::1]".into(), 443)));
        assert_eq!(split_authority("a.com:0", 443), None);
        assert_eq!(split_authority("user@a.com:443", 443), None);
        assert_eq!(split_authority("a.com:x", 443), None);
    }

    #[tokio::test]
    async fn ask_allow_block_and_timeout() {
        let f = fw("allowlist", &["github.com"], false);
        assert_eq!(f.decide("github.com", 443).await, Verdict::Allowed);

        // Allow: the host goes on the list and every waiting connection to it proceeds.
        let (a, b) = (f.clone(), f.clone());
        let w1 = tokio::spawn(async move { a.decide("example.org", 443).await });
        let w2 = tokio::spawn(async move { b.decide("example.org", 443).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let v = f.view();
        assert_eq!(v["pending"].as_array().unwrap().len(), 1);
        let id = v["pending"][0]["id"].as_str().unwrap().to_string();
        f.answer(&id, true).unwrap();
        assert_eq!(w1.await.unwrap(), Verdict::Approved);
        assert_eq!(w2.await.unwrap(), Verdict::Approved);
        assert!(f.policy().allow.contains(&"example.org".to_string()));
        assert_eq!(f.decide("example.org", 443).await, Verdict::Allowed);

        // Block: refused now, and not asked again for a while.
        let c = f.clone();
        let w = tokio::spawn(async move { c.decide("evil.example", 443).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let id = f.view()["pending"][0]["id"].as_str().unwrap().to_string();
        f.answer(&id, false).unwrap();
        assert_eq!(w.await.unwrap(), Verdict::Denied);
        assert_eq!(f.decide("evil.example", 443).await, Verdict::Blocked);

        // Nobody answers.
        assert_eq!(f.decide("slow.example", 443).await, Verdict::Timeout);
        assert!(f.answer("nope", true).is_err());

        // A non-standard port is its own entry.
        let d = f.clone();
        let w = tokio::spawn(async move { d.decide("mqtt.example.com", 8883).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let id = f.view()["pending"][0]["id"].as_str().unwrap().to_string();
        f.answer(&id, true).unwrap();
        assert_eq!(w.await.unwrap(), Verdict::Approved);
        assert!(f.policy().allow.contains(&"mqtt.example.com:8883".to_string()));
    }

    #[tokio::test]
    async fn mode_change_answers_waiting_connections() {
        let f = fw("allowlist", &[], false);
        let a = f.clone();
        let w = tokio::spawn(async move { a.decide("x.example", 443).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        f.set_policy(Policy { mode: "offline".into(), allow: vec![] }).unwrap();
        assert_eq!(w.await.unwrap(), Verdict::Blocked);
        assert_eq!(f.decide("x.example", 443).await, Verdict::Blocked);
        f.set_policy(Policy { mode: "open".into(), allow: vec![] }).unwrap();
        assert_eq!(f.decide("x.example", 443).await, Verdict::Allowed);
    }

    async fn through(f: &Arc<Firewall>, request: &[u8]) -> String {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let me = f.clone();
        tokio::spawn(async move { me.serve_proxy(server).await });
        client.write_all(request).await.unwrap();
        let mut out = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut out)).await;
        String::from_utf8_lossy(&out).into_owned()
    }

    async fn local_server(reply: &'static [u8]) -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut b = [0u8; 4096];
                    let n = c.read(&mut b).await.unwrap_or(0);
                    let got = String::from_utf8_lossy(&b[..n]).into_owned();
                    let _ = c.write_all(reply).await;
                    let _ = c.write_all(got.as_bytes()).await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn proxy_connect_and_http() {
        let f = fw("open", &[], true);
        let port = local_server(b"HELLO|").await;
        let r = through(&f, format!("CONNECT localhost:{port} HTTP/1.1\r\nHost: localhost\r\n\r\nraw-bytes").as_bytes()).await;
        assert!(r.starts_with("HTTP/1.1 200 Connection Established\r\n\r\nHELLO|raw-bytes"), "{r}");

        let r = through(&f, format!("GET http://localhost:{port}/path?q=1 HTTP/1.1\r\nHost: localhost\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: x\r\n\r\n").as_bytes()).await;
        assert!(r.starts_with("HELLO|GET /path?q=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"), "{r}");
        let log = f.view()["log"].clone();
        assert_eq!(log.as_array().unwrap().len(), 2);
        assert_eq!(log[0]["result"], "allowed");
    }

    #[tokio::test]
    async fn proxy_refusals() {
        // Loopback through an allowed name is refused when private addresses are not allowed (the real setting).
        let f = fw("open", &[], false);
        let port = local_server(b"SECRET").await;
        let r = through(&f, format!("CONNECT localhost:{port} HTTP/1.1\r\n\r\n").as_bytes()).await;
        assert!(r.starts_with("HTTP/1.1 403") && r.contains("private or local") && !r.contains("SECRET"), "{r}");
        // IP addresses, https absolute-form, junk.
        for (req, want) in [
            ("CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n", "403"),
            ("CONNECT [::1]:443 HTTP/1.1\r\n\r\n", "403"),
            ("GET https://example.com/ HTTP/1.1\r\n\r\n", "400"),
            ("GET / HTTP/1.1\r\n\r\n", "400"),
            ("CONNECT a.com:0 HTTP/1.1\r\n\r\n", "400"),
            ("CONNECT bad_name.com:443 HTTP/1.1\r\n\r\n", "400"),
            ("HELLO\r\n\r\n", "400"),
        ] {
            let r = through(&f, req.as_bytes()).await;
            assert!(r.starts_with(&format!("HTTP/1.1 {want}")), "{req:?} -> {r}");
        }
        // Offline.
        let f = fw("offline", &[], true);
        let r = through(&f, format!("CONNECT localhost:{port} HTTP/1.1\r\n\r\n").as_bytes()).await;
        assert!(r.starts_with("HTTP/1.1 403") && r.contains("not allowed"), "{r}");
        // Oversized head.
        let big = format!("CONNECT a.com:443 HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(20000));
        let r = through(&f, big.as_bytes()).await;
        assert!(r.starts_with("HTTP/1.1 431"), "{r}");
    }

    /// The whole path: a client in "the sandbox" connects to the tunnel's proxy stream, the backend decides.
    #[tokio::test]
    async fn through_the_tunnel() {
        let f = fw("open", &[], true);
        let port = local_server(b"VIA-TUNNEL|").await;
        let (a, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let (_backend, mut incoming) = Mux::start(ar, aw, Side::Backend);
        let (sandbox, _) = Mux::start(br, bw, Side::Sandbox);
        let me = f.clone();
        tokio::spawn(async move {
            while let Some(Incoming { target, stream }) = incoming.recv().await {
                assert_eq!(target, b"proxy");
                let me = me.clone();
                tokio::spawn(async move { me.serve_proxy(stream).await });
            }
        });
        let mut s = sandbox.open(b"proxy").await.unwrap();
        s.write_all(format!("CONNECT localhost:{port} HTTP/1.1\r\n\r\nping").as_bytes()).await.unwrap();
        let mut out = vec![0u8; 64];
        let mut got = Vec::new();
        while !String::from_utf8_lossy(&got).contains("ping") {
            let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut out)).await.unwrap().unwrap();
            assert!(n > 0);
            got.extend_from_slice(&out[..n]);
        }
        assert_eq!(String::from_utf8_lossy(&got), "HTTP/1.1 200 Connection Established\r\n\r\nVIA-TUNNEL|ping");
    }
}
