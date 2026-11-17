//! Helpers for the black-box tests: they run the real binary in a scratch directory on test ports, so they never
//! touch a running DeviceDock (its .runtime, its ports or its sandbox).
#![allow(dead_code)]
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

pub const BIN: &str = env!("CARGO_BIN_EXE_devicedock");

/// A scratch working directory with a bridge token and a stand-in web page.
pub fn scratch(bridge_token: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dd-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".runtime")).unwrap();
    std::fs::write(dir.join(".runtime/bridge-token"), bridge_token).unwrap();
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    std::fs::write(dir.join("dist/index.html"), "<!doctype html><title>dock</title>").unwrap();
    dir
}

/// Kills the process when dropped.
pub struct Proc(pub Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Starts `devicedock <args>` and waits until its stdout prints a line containing `ready`.
pub fn spawn(dir: &PathBuf, args: &[&str], env: &[(&str, String)], ready: &str) -> Proc {
    let mut cmd = Command::new(BIN);
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("start the binary");
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        if out.read_line(&mut line).unwrap() == 0 {
            panic!("devicedock {args:?} exited before it was ready");
        }
        if line.contains(ready) {
            break;
        }
    }
    // Keep draining stdout so the process never blocks on a full pipe.
    std::thread::spawn(move || for _ in out.lines() {});
    Proc(child)
}

pub fn backend(dir: &PathBuf, port: u16, bridge_port: u16, bootstrap: &str) -> Proc {
    spawn(
        dir,
        &["serve"],
        &[("PORT", port.to_string()), ("DEVICEDOCK_TEST_BOOTSTRAP", bootstrap.into()), ("DEVICEDOCK_BRIDGE_PORT", bridge_port.to_string())],
        "listening",
    )
}

pub struct Resp {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}
impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap()
    }
}

/// One HTTP/1.1 request over a fresh connection. `Host` defaults to 127.0.0.1:<port>.
pub async fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        req += &format!("Host: 127.0.0.1:{port}\r\n");
    }
    for (k, v) in headers {
        req += &format!("{k}: {v}\r\n");
    }
    req += &format!("Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.lines();
    let status = lines.next().unwrap_or("").split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    Resp { status, headers, body: body.to_string() }
}

pub async fn login(port: u16, token: &str) -> Resp {
    let origin = format!("http://127.0.0.1:{port}");
    let body = serde_json::json!({ "token": token }).to_string();
    http(port, "POST", "/api/session", &[("Content-Type", "application/json"), ("Origin", &origin)], &body).await
}

/// A WebSocket whose incoming JSON messages collect in `inbox`; `send` queues outgoing text.
#[derive(Clone)]
pub struct Ws {
    pub inbox: Arc<Mutex<Vec<Value>>>,
    out: mpsc::UnboundedSender<Message>,
}

impl Ws {
    pub fn new<S>(ws: tokio_tungstenite::WebSocketStream<S>) -> Ws
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut tx, mut rx) = ws.split();
        let inbox: Arc<Mutex<Vec<Value>>> = Arc::default();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                let close = matches!(m, Message::Close(_));
                if tx.send(m).await.is_err() || close {
                    break;
                }
            }
        });
        let i = inbox.clone();
        tokio::spawn(async move {
            while let Some(Ok(m)) = rx.next().await {
                if let Message::Text(t) = m {
                    if let Ok(v) = serde_json::from_str(&t) {
                        i.lock().unwrap().push(v);
                    }
                }
            }
        });
        Ws { inbox, out }
    }
    pub fn send(&self, v: Value) {
        let _ = self.out.send(Message::Text(v.to_string().into()));
    }
    pub fn close(&self) {
        let _ = self.out.send(Message::Close(None));
    }
    /// Takes the first message matching `pred` (waits up to 3 s).
    pub async fn next(&self, pred: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..300 {
            if let Some(m) = self.take(&pred) {
                return m;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no such message; inbox: {:?}", self.inbox.lock().unwrap());
    }
    pub fn take(&self, pred: impl Fn(&Value) -> bool) -> Option<Value> {
        let mut i = self.inbox.lock().unwrap();
        let k = i.iter().position(pred)?;
        Some(i.remove(k))
    }
}

/// Opens the page's device WebSocket, or returns the HTTP status it was refused with.
pub async fn page_socket(port: u16, protocols: &str, cookie: &str, origin: &str) -> Result<(Ws, Option<String>), u16> {
    let mut req = format!("ws://127.0.0.1:{port}/ws/devices").into_client_request().unwrap();
    let h = req.headers_mut();
    h.insert("sec-websocket-protocol", protocols.parse().unwrap());
    h.insert("cookie", cookie.parse().unwrap());
    h.insert("origin", origin.parse().unwrap());
    match tokio_tungstenite::connect_async(req).await {
        Ok((ws, resp)) => {
            let proto = resp.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()).map(String::from);
            Ok((Ws::new(ws), proto))
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("{e}"),
    }
}

/// Logs in with `bootstrap` and returns (cookie, csrf).
pub async fn session(port: u16, bootstrap: &str) -> (String, String) {
    let r = login(port, bootstrap).await;
    assert_eq!(r.status, 200);
    let cookie = r.headers["set-cookie"].split(';').next().unwrap().to_string();
    (cookie, r.json()["csrf"].as_str().unwrap().to_string())
}
