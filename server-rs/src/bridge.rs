//! Inside the sandbox: the bridge service (`devicedock bridge`, the container's main process).
//! It listens on :47832. The backend dials `GET /bridge` (a WebSocket, through the tunnel) and keeps it open; agent
//! tools POST each request to `/rpc`, and the bridge relays it over that WebSocket and returns the backend's reply.
//! Both need the bridge token (`Authorization: Bearer`, provisioned by the backend into /home/node/.bridge-token).
//! The bridge holds no policy: leases and approvals are the backend broker's. It also runs the RFC 2217 servers
//! (rfc2217.rs), the OpenOCD endpoints for debug probes (dap.rs), and keeps the agent instructions current
//! (instructions.rs).
//!
//! Wire format (unchanged from the TypeScript bridge it replaces):
//!   tool -> bridge   POST /rpc  {"client": <uuid>, "request": <request>}  ->  the reply as JSON
//!   bridge -> backend           {"client": ..., "request": <normalised request>}
//!   backend -> bridge           {"id", "ok": true, "result"} | {"id", "ok": false, "error"}
use crate::device::{bridge_port, probe_base, rfc2217_base, token_file, DeviceClient};
use crate::protocol::{parse_request, parse_response, PROBE_SLOTS, RFC2217_SLOTS};
use axum::body::{to_bytes, Body};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

const MAX_BODY: usize = 65536;
const MAX_PENDING: usize = 64;

pub struct Bridge {
    port: u16,
    token_file: PathBuf,
    /// `127.0.0.1:<port>`: the only Host header accepted.
    host: OnceLock<String>,
    /// The backend's WebSocket (connection number, outgoing messages); at most one.
    backend: Mutex<Option<(u64, mpsc::UnboundedSender<Message>)>>,
    next_conn: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

/// An HTTP status the bridge answers with instead of a reply.
type Status = (StatusCode, Option<&'static str>);

/// Forgets a pending request whose caller went away (the HTTP client closed, or the reply arrived).
struct PendingGuard<'a>(&'a Bridge, String);
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.0.pending.lock().unwrap().remove(&self.1);
    }
}

impl Bridge {
    pub fn new(port: u16, token_file: PathBuf) -> Arc<Self> {
        Arc::new(Bridge {
            port,
            token_file,
            host: OnceLock::new(),
            backend: Mutex::new(None),
            next_conn: AtomicU64::new(0),
            pending: Mutex::default(),
        })
    }

    /// Binds and serves in the background; returns the port (useful when `port` was 0).
    pub async fn listen(self: Arc<Self>, addr: &str) -> Result<u16, String> {
        let listener = tokio::net::TcpListener::bind((addr, self.port)).await.map_err(|e| format!("bridge: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let _ = self.host.set(format!("127.0.0.1:{port}"));
        let router = axum::Router::new().fallback(handle).with_state(self);
        tokio::spawn(async move { axum::serve(listener, router).await });
        Ok(port)
    }

    /// A device client for the bridge's own endpoints (RFC 2217, OpenOCD): requests go straight in, without HTTP.
    pub fn client(self: &Arc<Self>) -> DeviceClient {
        let b = self.clone();
        DeviceClient::new(Arc::new(move |m: Value| {
            let b = b.clone();
            Box::pin(async move { b.submit(&m).await.map_err(|(s, _)| format!("Bridge returned HTTP {}", s.as_u16())) })
        }))
    }

    fn authenticated(&self, value: Option<&str>) -> bool {
        let Ok(token) = std::fs::read_to_string(&self.token_file) else { return false };
        value.is_some_and(|v| crate::app::equal(v, &format!("Bearer {}", token.trim())))
    }

    fn connected(&self) -> bool {
        self.backend.lock().unwrap().is_some()
    }

    fn ready(&self) -> Result<(), Status> {
        if !self.connected() {
            return Err((StatusCode::SERVICE_UNAVAILABLE, Some(r#"{"error":"Mac bridge is disconnected"}"#)));
        }
        if self.pending.lock().unwrap().len() >= MAX_PENDING {
            return Err((StatusCode::TOO_MANY_REQUESTS, None));
        }
        Ok(())
    }

    /// Relays one `{client, request}` to the backend and waits for its reply (or the request's deadline).
    pub async fn submit(&self, m: &Value) -> Result<Value, Status> {
        self.ready()?;
        let invalid = (StatusCode::BAD_REQUEST, Some(r#"{"error":"Invalid device request"}"#));
        let r = parse_request(m.get("request").unwrap_or(&Value::Null)).map_err(|_| invalid)?;
        let client = m.get("client").and_then(Value::as_str).unwrap_or_default();
        if client.len() != 36 || !client.bytes().all(|c| matches!(c, b'a'..=b'f' | b'0'..=b'9' | b'-')) {
            return Err(invalid);
        }
        let ms = r.deadline - crate::broker::now_ms();
        if ms <= 0 || ms > 60000 {
            return Err(invalid);
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut p = self.pending.lock().unwrap();
            if p.contains_key(&r.id) {
                return Err(invalid);
            }
            p.insert(r.id.clone(), tx);
        }
        let _guard = PendingGuard(self, r.id.clone());
        let msg = json!({"client": client, "request": r.to_json()}).to_string();
        let sent = self.backend.lock().unwrap().as_ref().is_some_and(|(_, out)| out.send(Message::Text(msg.into())).is_ok());
        if !sent {
            return Err((StatusCode::SERVICE_UNAVAILABLE, Some(r#"{"error":"Mac bridge is disconnected"}"#)));
        }
        Ok(match tokio::time::timeout(Duration::from_millis(ms as u64), rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => json!({"id": r.id, "ok": false, "error": "Mac bridge disconnected"}),
            Err(_) => json!({"id": r.id, "ok": false, "error": "Bridge timeout; writes must not be automatically retried"}),
        })
    }

    async fn serve_backend(self: Arc<Self>, socket: WebSocket) {
        let (mut tx, mut rx) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let conn = self.next_conn.fetch_add(1, Ordering::SeqCst);
        {
            let mut b = self.backend.lock().unwrap();
            if b.is_some() {
                return;
            }
            *b = Some((conn, out.clone()));
        }
        let writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                let close = matches!(m, Message::Close(_));
                if tx.send(m).await.is_err() || close {
                    break;
                }
            }
        });
        while let Some(Ok(m)) = rx.next().await {
            let raw = match m {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => break,
                _ => continue,
            };
            match serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()).and_then(|v| parse_response(&v)) {
                Ok(reply) => {
                    let id = reply["id"].as_str().unwrap_or_default().to_string();
                    if let Some(p) = self.pending.lock().unwrap().remove(&id) {
                        let _ = p.send(reply);
                    }
                }
                Err(_) => {
                    // A protocol error closes the connection (policy violation).
                    let _ = out.send(Message::Close(Some(CloseFrame { code: 1008, reason: "".into() })));
                    break;
                }
            }
        }
        {
            let mut b = self.backend.lock().unwrap();
            if b.as_ref().is_some_and(|(c, _)| *c == conn) {
                *b = None;
            }
        }
        for (id, p) in self.pending.lock().unwrap().drain() {
            let _ = p.send(json!({"id": id, "ok": false, "error": "Mac bridge disconnected"}));
        }
        drop(out);
        let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    }
}

fn status(s: Status) -> Response {
    match s.1 {
        Some(body) => (s.0, body).into_response(),
        None => s.0.into_response(),
    }
}

async fn handle(State(b): State<Arc<Bridge>>, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    let h = |k: &str| parts.headers.get(k).and_then(|v| v.to_str().ok());
    let allowed = b.host.get().is_some_and(|host| h("host") == Some(host.as_str()))
        && h("origin").is_none()
        && b.authenticated(h("authorization"));
    let path = parts.uri.to_string();
    let forbidden = || StatusCode::FORBIDDEN.into_response();
    if h("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        // The backend's link; only one at a time.
        if !allowed || path != "/bridge" || b.connected() {
            return forbidden();
        }
        let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else { return forbidden() };
        return ws.max_message_size(MAX_BODY).max_frame_size(MAX_BODY).on_upgrade(move |s| b.serve_backend(s));
    }
    if !allowed || path != "/rpc" || parts.method != Method::POST {
        return forbidden();
    }
    if let Err(s) = b.ready() {
        return status(s);
    }
    let Ok(bytes) = to_bytes(Body::new(body), MAX_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let Ok(m) = serde_json::from_slice::<Value>(&bytes) else {
        return status((StatusCode::BAD_REQUEST, Some(r#"{"error":"Invalid device request"}"#)));
    };
    match b.submit(&m).await {
        Ok(reply) => ([(header::CONTENT_TYPE, "application/json")], reply.to_string()).into_response(),
        Err(s) => status(s),
    }
}

/// `devicedock bridge`: the sandbox container's main process.
pub async fn run() -> Result<(), String> {
    let bridge = Bridge::new(bridge_port(), token_file());
    // 0.0.0.0: older backends reach the bridge on a port published to the host's loopback, not through the tunnel.
    let addr = std::env::var("DEVICEDOCK_BRIDGE_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    bridge.clone().listen(&addr).await?;
    println!("Container device bridge ready");
    let log: crate::rfc2217::Log = Arc::new(|m: &str| eprintln!("{m}"));
    // RFC 2217 serial servers for esptool/pyserial/PlatformIO, and the OpenOCD endpoints for shared debug probes.
    // Loopback only; never published.
    let client = bridge.client();
    crate::rfc2217::start(client.clone(), rfc2217_base(), "127.0.0.1", log.clone(), RFC2217_SLOTS).await;
    crate::dap::start(client, probe_base(), "127.0.0.1", log, PROBE_SLOTS).await;
    // Keep DeviceDock's section of the agent instructions current in the workspace (see instructions.rs): the user's
    // own text in AGENTS.md / CLAUDE.md is never touched.
    let workspace = std::env::var("DEVICEDOCK_WORKSPACE").unwrap_or_else(|_| "/workspace".into());
    for f in ["AGENTS.md", "CLAUDE.md"] {
        let path = std::path::Path::new(&workspace).join(f);
        if let Err(e) = crate::instructions::sync(&path, std::path::Path::new(crate::instructions::SOURCE)) {
            eprintln!("Could not update {f}: {e}");
        }
    }
    std::future::pending::<()>().await;
    Ok(())
}
