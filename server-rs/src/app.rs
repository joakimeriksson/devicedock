//! Port of apps/server/app.ts: loopback-only HTTP + WebSocket server (one-time login links, session cookie, CSRF),
//! the device WebSocket for pages, the terminal WebSockets, and the outbound connection to the sandbox bridge.
use crate::broker::{now_ms, Broker, Sink, Source};
use crate::protocol::{parse_browser_message, parse_request, BrowserMessage};
use crate::sandbox::{bridge_token, health, random_hex, BRIDGE_PORT};
use crate::terminals::{Terminals, KINDS};
use axum::body::{to_bytes, Body};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../dist"]
#[allow_missing = true]
struct Embedded;

pub fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

pub struct Options {
    pub port: u16,
    pub bootstrap: String,
    /// Authorises POST /admin/session-link. Never the bridge token. None = endpoint disabled.
    pub admin_token: Option<String>,
}

struct SessionState {
    csrf: String,
    expires: i64,
}

pub struct App {
    pub origin: String,
    host: String,
    cookie_name: String,
    admin_token: Option<String>,
    /// One-time login tokens: the startup token (no expiry) plus renewals minted by the admin endpoint (5 min).
    bootstraps: Mutex<Vec<(String, i64)>>,
    sessions: Mutex<HashMap<String, SessionState>>,
    pub broker: Arc<Broker>,
    terminals: Terminals,
    ws_clients: AtomicUsize,
    /// Serve the web UI from ./dist when it exists (development), else from the copy embedded at build time.
    disk_dist: Option<std::path::PathBuf>,
    shutdown: Notify,
    closed: AtomicBool,
}

type Shared = Arc<App>;

impl App {
    pub fn new(o: Options) -> Shared {
        let disk = std::path::Path::new("dist");
        Arc::new(App {
            origin: format!("http://127.0.0.1:{}", o.port),
            host: format!("127.0.0.1:{}", o.port),
            // Cookies are not isolated by port, so another local instance would overwrite a shared name.
            cookie_name: format!("dock_{}", o.port),
            admin_token: o.admin_token,
            bootstraps: Mutex::new(vec![(o.bootstrap, i64::MAX)]),
            sessions: Mutex::default(),
            broker: Broker::new(),
            terminals: Terminals::default(),
            ws_clients: AtomicUsize::new(0),
            disk_dist: disk.join("index.html").is_file().then(|| disk.to_path_buf()),
            shutdown: Notify::new(),
            closed: AtomicBool::new(false),
        })
    }

    fn consume_bootstrap(&self, token: &str) -> bool {
        let now = now_ms();
        let mut b = self.bootstraps.lock().unwrap();
        b.retain(|(_, exp)| *exp > now);
        match b.iter().position(|(t, _)| equal(token, t)) {
            Some(i) => {
                b.remove(i);
                true
            }
            None => false,
        }
    }

    fn session(&self, headers: &HeaderMap) -> Option<String> {
        let prefix = format!("{}=", self.cookie_name);
        let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
        let key = cookie.split("; ").find(|v| v.starts_with(&prefix))?[prefix.len()..].to_string();
        let s = self.sessions.lock().unwrap();
        s.get(&key).filter(|s| s.expires > now_ms()).map(|s| s.csrf.clone())
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.shutdown.notify_waiters();
        self.broker.close();
        self.terminals.close();
    }
}

fn hdr<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

fn json_response(status: StatusCode, v: Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], v.to_string()).into_response()
}

fn security_headers(app: &App, r: &mut Response) {
    let h = r.headers_mut();
    let csp = format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://{}; frame-ancestors 'none'; base-uri 'none'",
        app.host
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).unwrap());
}

fn terminal_kind(path_and_query: &str) -> Option<&'static str> {
    let rest = path_and_query.strip_prefix("/ws/terminal/")?;
    let end = rest.find('?').unwrap_or(rest.len());
    let name = &rest[..end];
    if name.is_empty() || !name.bytes().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    // "/ws/terminal/agent" is kept as an alias for Codex.
    let name = if name == "agent" { "codex" } else { name };
    KINDS.iter().copied().find(|k| *k == name)
}

pub async fn handle(State(app): State<Shared>, req: Request) -> Response {
    let is_upgrade = hdr(req.headers(), "upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let mut r = if is_upgrade { upgrade(app.clone(), req).await } else { http(app.clone(), req).await };
    security_headers(&app, &mut r);
    r
}

async fn http(app: Shared, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let h = &parts.headers;
    if hdr(h, "host") != Some(&app.host) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = parts.uri.path().to_string();
    let method = parts.method.clone();
    let origin = hdr(h, "origin");
    let body = match to_bytes(body, 64 * 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let is_json = hdr(h, "content-type").is_some_and(|c| c.starts_with("application/json"));
    let json_body: Value = if is_json && !body.is_empty() {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        }
    } else {
        Value::Null
    };

    if method == Method::POST && path == "/api/session" {
        let token = json_body.get("token").and_then(Value::as_str);
        if origin != Some(&app.origin) || !token.is_some_and(|t| app.consume_bootstrap(t)) {
            return json_response(
                StatusCode::FORBIDDEN,
                json!({"error": "Invalid, expired or used session link. Run ./devicedock.sh open for a new one."}),
            );
        }
        let (key, csrf) = (random_hex(), random_hex());
        app.sessions.lock().unwrap().insert(key.clone(), SessionState { csrf: csrf.clone(), expires: now_ms() + 12 * 3600 * 1000 });
        let mut r = json_response(StatusCode::OK, json!({"csrf": csrf}));
        let cookie = format!("{}={key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200", app.cookie_name);
        r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
        return r;
    }
    // Mint a fresh one-time login link for a running backend, so an expired session never needs a restart.
    // Not for browsers: any Origin is refused, and the caller must present the admin token from .runtime/.
    if method == Method::POST && path == "/admin/session-link" {
        let Some(admin) = app.admin_token.as_ref().filter(|_| origin.is_none()) else {
            return StatusCode::FORBIDDEN.into_response();
        };
        if !equal(hdr(h, "authorization").unwrap_or(""), &format!("Bearer {admin}")) {
            return StatusCode::FORBIDDEN.into_response();
        }
        let now = now_ms();
        let mut b = app.bootstraps.lock().unwrap();
        b.retain(|(_, exp)| *exp > now);
        if b.len() >= 5 {
            return json_response(StatusCode::TOO_MANY_REQUESTS, json!({"error": "Too many unused login links"}));
        }
        let token = random_hex();
        b.push((token.clone(), now + 5 * 60 * 1000));
        return json_response(StatusCode::OK, json!({"url": format!("{}/#token={token}", app.origin), "expiresInSeconds": 300}));
    }
    if path == "/api" || path.starts_with("/api/") {
        let Some(csrf) = app.session(h) else {
            return json_response(StatusCode::UNAUTHORIZED, json!({"error": "Open a fresh login link: ./devicedock.sh, then type o."}));
        };
        if method != Method::GET && (origin != Some(&app.origin) || hdr(h, "x-csrf-token") != Some(&csrf)) {
            return StatusCode::FORBIDDEN.into_response();
        }
        if method == Method::GET && path == "/api/session" {
            return json_response(StatusCode::OK, json!({"csrf": csrf}));
        }
        if method == Method::GET && path == "/api/health" {
            return json_response(StatusCode::OK, health().await);
        }
    }
    if method == Method::GET || method == Method::HEAD {
        if let Some(r) = static_file(&app, &path, method == Method::HEAD) {
            return r;
        }
    }
    (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "Not Found").into_response()
}

fn static_file(app: &App, path: &str, head: bool) -> Option<Response> {
    let mut rel = percent_decode(path.trim_start_matches('/'))?;
    if rel.split('/').any(|seg| seg == ".." || seg.starts_with('.') && !seg.is_empty()) || rel.contains('\0') || rel.contains('\\') {
        return None;
    }
    if rel.is_empty() || rel.ends_with('/') {
        rel.push_str("index.html");
    }
    let bytes: Vec<u8> = match &app.disk_dist {
        Some(dir) => std::fs::read(dir.join(&rel)).ok()?,
        None => Embedded::get(&rel)?.data.into_owned(),
    };
    let mime = mime_guess::from_path(&rel).first_or_octet_stream();
    let ct = if mime.type_() == "text" || mime.essence_str() == "application/javascript" {
        format!("{}; charset=utf-8", mime.essence_str())
    } else {
        mime.essence_str().to_string()
    };
    let len = bytes.len();
    let mut r = Response::new(if head { Body::empty() } else { Body::from(bytes) });
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&ct).ok()?);
    r.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    Some(r)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

async fn upgrade(app: Shared, req: Request) -> Response {
    let (mut parts, _) = req.into_parts();
    let h = parts.headers.clone();
    let url = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
    let protocols: Vec<String> = hdr(&h, "sec-websocket-protocol")
        .map(|p| p.split(',').map(|x| x.trim().to_string()).collect())
        .unwrap_or_default();
    let csrf = app.session(&h);
    if hdr(&h, "host") != Some(&app.host)
        || hdr(&h, "origin") != Some(&app.origin)
        || !csrf.as_ref().is_some_and(|c| protocols.contains(c))
        || app.ws_clients.load(Ordering::SeqCst) >= 8
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = url.split('?').next().unwrap_or("");
    let kind = terminal_kind(&url);
    if path != "/ws/devices" && kind.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // Like the `ws` package: answer with the first subprotocol the page offered.
    let ws = ws.protocols(protocols.first().cloned()).max_message_size(65536).max_frame_size(65536);
    let restart = url.ends_with("?restart=1");
    ws.on_upgrade(move |socket| async move {
        app.ws_clients.fetch_add(1, Ordering::SeqCst);
        match kind {
            Some(k) => terminal_socket(app.clone(), socket, k, restart).await,
            None => device_socket(app.clone(), socket).await,
        }
        app.ws_clients.fetch_sub(1, Ordering::SeqCst);
    })
}

/// Outbound queue for one page. About 1 MiB of backlog (approximated in messages) ends the connection.
const QUEUE: usize = 2048;

async fn terminal_socket(app: Shared, socket: WebSocket, kind: &'static str, restart: bool) {
    let (mut tx_ws, mut rx_ws) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(QUEUE);
    let peer = match app.terminals.attach(kind, tx.clone(), restart).await {
        Ok(p) => p,
        Err(e) => {
            let detail: String = e.chars().take(500).collect();
            eprintln!("Docker terminal failed: {detail}");
            let _ = tx_ws.send(Message::Text(json!({"type": "error", "error": format!("Unable to start Docker PTY: {detail}")}).to_string().into())).await;
            let _ = tx_ws.send(Message::Close(Some(CloseFrame { code: 1011, reason: "Terminal startup failed".into() }))).await;
            return;
        }
    };
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if tx_ws.send(Message::Text(m.to_string().into())).await.is_err() {
                break;
            }
        }
        let _ = tx_ws.send(Message::Close(Some(CloseFrame { code: 1008, reason: "Invalid terminal message".into() }))).await;
    });
    drop(tx);
    loop {
        tokio::select! {
            m = rx_ws.next() => match m {
                Some(Ok(Message::Text(t))) => {
                    if app.terminals.input(kind, &t).is_err() { break; }
                }
                Some(Ok(Message::Binary(b))) => {
                    if app.terminals.input(kind, &String::from_utf8_lossy(&b)).is_err() { break; }
                }
                Some(Ok(_)) => {}
                _ => break,
            },
            _ = app.shutdown.notified() => break,
        }
    }
    app.terminals.detach(kind, peer);
    writer.abort();
}

async fn device_socket(app: Shared, socket: WebSocket) {
    let owner = uuid::Uuid::new_v4().to_string();
    let (mut tx_ws, mut rx_ws) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(QUEUE);
    let overflow = Arc::new(Notify::new());
    let sink: Sink = {
        let (tx, overflow) = (tx.clone(), overflow.clone());
        Arc::new(move |m: Value| {
            if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(m) {
                overflow.notify_one();
            }
        })
    };
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if tx_ws.send(Message::Text(m.to_string().into())).await.is_err() {
                break;
            }
        }
    });
    let in_flight = Arc::new(AtomicUsize::new(0));
    let error = |sink: &Sink, e: String| sink(json!({"type": "error", "error": e.chars().take(400).collect::<String>()}));
    loop {
        let text = tokio::select! {
            m = rx_ws.next() => match m {
                Some(Ok(Message::Text(t))) => t.to_string(),
                Some(Ok(Message::Binary(b))) => String::from_utf8_lossy(&b).into_owned(),
                Some(Ok(_)) => continue,
                _ => break,
            },
            _ = overflow.notified() => break,
            _ = app.shutdown.notified() => break,
        };
        let msg = serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()).and_then(|v| parse_browser_message(&v));
        let b = &app.broker;
        let r: Result<(), String> = match msg {
            Err(e) => Err(e),
            Ok(BrowserMessage::Expose(d)) => b.expose(&owner, sink.clone(), d),
            Ok(BrowserMessage::Revoke { device_id }) => {
                b.revoke(&owner, &device_id);
                Ok(())
            }
            Ok(BrowserMessage::Autonomy { device_id, until }) => b.set_autonomy(&owner, &device_id, until),
            Ok(BrowserMessage::Data { device_id, generation, data }) => {
                b.data(&owner, &device_id, generation, &data);
                Ok(())
            }
            Ok(BrowserMessage::Approve { id, allow }) => {
                b.approve(&owner, &id, allow);
                Ok(())
            }
            Ok(BrowserMessage::Reply { id, ok, error, data }) => {
                b.reply(&owner, &id, ok, error, data);
                Ok(())
            }
            Ok(BrowserMessage::ProbeEnd { device_id }) => {
                b.end_probe(&owner, &device_id);
                Ok(())
            }
            Ok(BrowserMessage::Rpc(request)) => {
                if in_flight.load(Ordering::SeqCst) >= 32 {
                    Err("Too many requests".into())
                } else {
                    in_flight.fetch_add(1, Ordering::SeqCst);
                    let (b, sink, owner, in_flight) = (b.clone(), sink.clone(), owner.clone(), in_flight.clone());
                    tokio::spawn(async move {
                        let id = request.get("id").cloned().unwrap_or(Value::Null);
                        let reply = match b.run(&owner, Source::Ui, &request).await {
                            Ok(result) => json!({"type": "rpc-result", "id": id, "ok": true, "result": result}),
                            Err(e) => json!({"type": "rpc-result", "id": id, "ok": false, "error": e}),
                        };
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        sink(reply);
                    });
                    Ok(())
                }
            }
        };
        if let Err(e) = r {
            error(&sink, e);
        }
    }
    app.broker.disconnect_owner(&owner);
    app.broker.disconnect_client(&owner);
    writer.abort();
}

/// Keeps a connection to the sandbox's bridge service and runs the agents' requests through the broker.
pub fn spawn_bridge(app: Shared) {
    tokio::spawn(async move {
        loop {
            if app.closed.load(Ordering::SeqCst) {
                return;
            }
            if let Err(e) = bridge_once(&app).await {
                if std::env::var_os("DEVICEDOCK_DEBUG").is_some() {
                    eprintln!("bridge: {e}");
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                _ = app.shutdown.notified() => return,
            }
        }
    });
}

async fn bridge_once(app: &Shared) -> Result<(), String> {
    let token = bridge_token().map_err(|e| e.to_string())?;
    // DEVICEDOCK_BRIDGE_PORT lets the parity tests point the backend at a fake bridge.
    let port = std::env::var("DEVICEDOCK_BRIDGE_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(BRIDGE_PORT);
    let mut req = format!("ws://127.0.0.1:{port}/bridge").into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert("authorization", HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?);
    let cfg = tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(65536)).max_frame_size(Some(65536));
    let (ws, _) = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async_with_config(req, Some(cfg), false))
        .await
        .map_err(|_| "handshake timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut tx_ws, mut rx_ws) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if tx_ws.send(tungstenite::Message::Text(m.into())).await.is_err() {
                break;
            }
        }
    });
    let clients: Arc<Mutex<HashSet<String>>> = Arc::default();
    loop {
        let raw = tokio::select! {
            m = rx_ws.next() => match m {
                Some(Ok(tungstenite::Message::Text(t))) => t.to_string(),
                Some(Ok(tungstenite::Message::Binary(b))) => String::from_utf8_lossy(&b).into_owned(),
                Some(Ok(tungstenite::Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => continue,
            },
            _ = app.shutdown.notified() => break,
        };
        let (app, tx, clients) = (app.clone(), tx.clone(), clients.clone());
        tokio::spawn(async move {
            let mut rid = String::new();
            let r: Result<Value, String> = async {
                let m: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                let client = m.get("client").and_then(Value::as_str).unwrap_or("");
                if client.len() != 36 || !client.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == b'-') {
                    return Err("Invalid client".into());
                }
                let request = m.get("request").cloned().unwrap_or(Value::Null);
                rid = parse_request(&request)?.id;
                {
                    let mut c = clients.lock().unwrap();
                    if c.len() >= 128 && !c.contains(client) {
                        return Err("Client limit; restart the backend to begin a new client session".into());
                    }
                    c.insert(client.to_string());
                }
                app.broker.run(client, Source::Agent, &request).await
            }
            .await;
            let out = match r {
                Ok(result) => json!({"id": rid, "ok": true, "result": result}),
                Err(_) if rid.is_empty() => return,
                Err(e) => json!({"id": rid, "ok": false, "error": e.chars().take(400).collect::<String>()}),
            };
            let _ = tx.send(out.to_string());
        });
    }
    for c in clients.lock().unwrap().drain() {
        app.broker.disconnect_client(&c);
    }
    writer.abort();
    Ok(())
}
