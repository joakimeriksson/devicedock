//! Port of apps/server/terminals.ts: one `docker exec -it` PTY per kind, shared by every page that attaches,
//! with the last 64 KiB of output replayed to a newcomer and a 30 s grace period after the last page leaves.
use crate::sandbox::{verify_managed, CONTAINER};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

pub const KINDS: [&str; 4] = ["shell", "codex", "claude", "opencode"];
const BUFFER_CHARS: usize = 65536;

fn command(kind: &str) -> &'static [&'static str] {
    match kind {
        "shell" => &["bash", "-l"],
        "codex" => &["codex"],
        "claude" => &["claude"],
        _ => &["opencode"],
    }
}

/// Outgoing messages to one page; `None` asks its socket to close with a policy error.
pub type PeerTx = mpsc::Sender<Value>;

struct Session {
    id: u64,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    buffer: String,
    peers: HashMap<u64, PeerTx>,
    timer: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Clone, Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<&'static str, Session>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}

fn kind_static(kind: &str) -> Option<&'static str> {
    KINDS.iter().copied().find(|k| *k == kind)
}

/// Keeps the tail of the replay buffer at roughly 64 Ki characters, cutting on a char boundary.
fn trim(buf: &mut String) {
    let n = buf.chars().count();
    if n > BUFFER_CHARS {
        let cut = buf.char_indices().nth(n - BUFFER_CHARS).map(|(i, _)| i).unwrap_or(0);
        buf.drain(..cut);
    }
}

impl Terminals {
    fn id(&self) -> u64 {
        self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Attaches a page to the PTY for `kind`, starting it if needed. Returns the peer id for input/detach.
    pub async fn attach(&self, kind: &str, peer: PeerTx, restart: bool) -> Result<u64, String> {
        let kind = kind_static(kind).ok_or("Unknown terminal")?;
        verify_managed().await?;
        let peer_id = self.id();
        let mut sessions = self.sessions.lock().unwrap();
        if restart {
            if let Some(mut s) = sessions.remove(kind) {
                let _ = s.child.kill();
            }
        }
        if !sessions.contains_key(kind) {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 28, cols: 100, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| e.to_string())?;
            let mut cmd = CommandBuilder::new("docker");
            cmd.args(["exec", "-it", "-w", "/workspace", CONTAINER]);
            cmd.args(command(kind));
            cmd.env("TERM", "xterm-256color");
            let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            let sid = self.id();
            // The PTY is read on a plain thread; output is decoded incrementally so a UTF-8 sequence split across
            // reads never turns into replacement characters.
            let (tx, mut rx) = mpsc::unbounded_channel::<Option<String>>();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let mut carry: Vec<u8> = vec![];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            carry.extend_from_slice(&buf[..n]);
                            let valid = match std::str::from_utf8(&carry) {
                                Ok(_) => carry.len(),
                                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                                Err(_) => carry.len(),
                            };
                            let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                            carry.drain(..valid);
                            if !text.is_empty() && tx.send(Some(text)).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = tx.send(None);
            });
            let me = self.clone();
            tokio::spawn(async move {
                while let Some(chunk) = rx.recv().await {
                    let mut sessions = me.sessions.lock().unwrap();
                    let Some(s) = sessions.get_mut(kind).filter(|s| s.id == sid) else {
                        if chunk.is_none() {
                            break;
                        }
                        continue;
                    };
                    match chunk {
                        Some(data) => {
                            s.buffer.push_str(&data);
                            trim(&mut s.buffer);
                            // A page that cannot keep up (about 1 MiB queued) is dropped, like ws.terminate().
                            s.peers.retain(|_, p| p.try_send(json!({"type": "output", "data": data})).is_ok());
                        }
                        None => {
                            let code = s.child.try_wait().ok().flatten().map(|st| st.exit_code()).unwrap_or(0);
                            for p in s.peers.values() {
                                let _ = p.try_send(json!({"type": "exit", "exitCode": code}));
                            }
                            sessions.remove(kind);
                            break;
                        }
                    }
                }
            });
            sessions.insert(
                kind,
                Session { id: sid, child, master: pair.master, writer, buffer: String::new(), peers: HashMap::new(), timer: None },
            );
        }
        let s = sessions.get_mut(kind).unwrap();
        if let Some(t) = s.timer.take() {
            t.abort();
        }
        let _ = peer.try_send(json!({"type": "output", "data": s.buffer}));
        s.peers.insert(peer_id, peer);
        Ok(peer_id)
    }

    /// Handles one message from a page. Err means the socket must close with 1008.
    pub fn input(&self, kind: &str, msg: &str) -> Result<(), ()> {
        let m: Value = serde_json::from_str(msg).map_err(|_| ())?;
        let mut sessions = self.sessions.lock().unwrap();
        let s = kind_static(kind).and_then(|k| sessions.get_mut(k));
        match m.get("type").and_then(Value::as_str) {
            Some("input") => {
                let data = m.get("data").and_then(Value::as_str).ok_or(())?;
                if data.encode_utf16().count() > 8192 {
                    return Err(());
                }
                if let Some(s) = s {
                    let _ = s.writer.write_all(data.as_bytes());
                    let _ = s.writer.flush();
                }
                Ok(())
            }
            Some("resize") => {
                let int = |k: &str| m.get(k).and_then(Value::as_f64).filter(|f| f.fract() == 0.0);
                let (Some(c), Some(r)) = (int("cols"), int("rows")) else { return Err(()) };
                if let Some(s) = s {
                    let _ = s.master.resize(PtySize {
                        cols: c.clamp(20.0, 300.0) as u16,
                        rows: r.clamp(5.0, 120.0) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Ok(())
            }
            _ => Err(()),
        }
    }

    pub fn detach(&self, kind: &str, peer_id: u64) {
        let Some(kind) = kind_static(kind) else { return };
        let mut sessions = self.sessions.lock().unwrap();
        let Some(s) = sessions.get_mut(kind) else { return };
        s.peers.remove(&peer_id);
        if s.peers.is_empty() {
            let (me, sid) = (self.clone(), s.id);
            s.timer = Some(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let mut sessions = me.sessions.lock().unwrap();
                if sessions.get(kind).is_some_and(|s| s.id == sid && s.peers.is_empty()) {
                    if let Some(mut s) = sessions.remove(kind) {
                        let _ = s.child.kill();
                    }
                }
            }));
        }
    }

    pub fn close(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            if let Some(t) = s.timer.take() {
                t.abort();
            }
            let _ = s.child.kill();
        }
    }
}
