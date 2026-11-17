//! Inside the sandbox: the device client every agent-side tool goes through, and the `device` CLI.
//! `device <cmd>` (/usr/local/bin/device runs `devicedock device`), the MCP server (mcp.rs) and the bridge's own
//! RFC 2217 and OpenOCD endpoints all send their requests through a `DeviceClient`. Agents, sandbox/AGENTS.md and
//! sandbox/esptool-preflight.py depend on the CLI's syntax, messages and exit codes: change them only on purpose.
use crate::broker::now_ms;
use crate::protocol::{
    hex_bytes, openocd_config, order_devices, order_probes, parse_request, parse_response, rfc2217_url, R,
    PROBE_PORT_BASE, RFC2217_PORT_BASE,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Where the sandbox side listens and finds its token. The defaults are the image's; the variables exist for tests.
pub fn env_port(var: &str, default: u16) -> u16 {
    std::env::var(var).ok().and_then(|p| p.parse().ok()).unwrap_or(default)
}
pub fn bridge_port() -> u16 {
    env_port("DEVICEDOCK_BRIDGE_PORT", crate::sandbox::BRIDGE_PORT)
}
pub fn token_file() -> PathBuf {
    std::env::var_os("DEVICEDOCK_BRIDGE_TOKEN_FILE").map(PathBuf::from).unwrap_or_else(|| "/home/node/.bridge-token".into())
}
pub fn rfc2217_base() -> u16 {
    env_port("DEVICEDOCK_RFC2217_PORT", RFC2217_PORT_BASE)
}
pub fn probe_base() -> u16 {
    env_port("DEVICEDOCK_PROBE_PORT", PROBE_PORT_BASE)
}

/// Carries `{client, request}` to the bridge and returns its reply, or a transport error such as
/// "Bridge returned HTTP 503".
pub type Transport = Arc<dyn Fn(Value) -> BoxFuture<'static, R<Value>> + Send + Sync>;

pub const DEFAULT_TIMEOUT_MS: i64 = 25000;

/// One client of the broker: a random client id (leases belong to it) and a way to reach the bridge.
#[derive(Clone)]
pub struct DeviceClient {
    pub client: String,
    transport: Transport,
}

impl DeviceClient {
    pub fn new(transport: Transport) -> Self {
        DeviceClient { client: uuid::Uuid::new_v4().to_string(), transport }
    }

    /// The bridge service's authenticated HTTP endpoint (127.0.0.1:47832/rpc). The token is read on each request,
    /// since it is provisioned after the container starts.
    pub fn http() -> Self {
        Self::http_to(bridge_port(), token_file())
    }

    pub fn http_to(port: u16, file: PathBuf) -> Self {
        Self::new(Arc::new(move |body: Value| {
            let file = file.clone();
            Box::pin(async move {
                let token = std::fs::read_to_string(&file)
                    .map_err(|e| format!("Cannot read the bridge token {}: {e}", file.display()))?;
                post_rpc(port, token.trim(), &body.to_string()).await
            })
        }))
    }

    /// One operation. `device` is a device object as `devices.list` returns it (only `id` and `generation` are used).
    pub async fn call(&self, op: &str, device: Option<&Value>, args: Value, lease: Option<&str>, timeout_ms: i64) -> R<Value> {
        let mut req = json!({"v": 1, "id": uuid::Uuid::new_v4().to_string(), "op": op, "deadline": now_ms() + timeout_ms, "args": args});
        if let Some(d) = device {
            for k in ["id", "generation"] {
                if let Some(v) = d.get(k).filter(|v| !v.is_null()) {
                    req[if k == "id" { "deviceId" } else { k }] = v.clone();
                }
            }
        }
        if let Some(l) = lease {
            req["lease"] = json!(l);
        }
        let request = parse_request(&req)?.to_json();
        let send = (self.transport)(json!({"client": self.client, "request": request}));
        let reply = tokio::time::timeout(Duration::from_millis(timeout_ms as u64 + 1000), send)
            .await
            .map_err(|_| "The operation was aborted due to timeout".to_string())??;
        let m = parse_response(&reply)?;
        if m["ok"] == json!(true) {
            Ok(m.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(m["error"].as_str().unwrap_or_default().to_string())
        }
    }

    pub async fn op(&self, op: &str, device: &Value, args: Value, lease: Option<&str>) -> R<Value> {
        self.call(op, Some(device), args, lease, DEFAULT_TIMEOUT_MS).await
    }

    pub async fn list(&self) -> R<Vec<Value>> {
        match self.call("devices.list", None, json!({}), None, DEFAULT_TIMEOUT_MS).await? {
            Value::Array(a) => Ok(a),
            _ => Err("devices.list returned no list".into()),
        }
    }

    pub async fn acquire(&self, device: &Value) -> R<String> {
        let r = self.op("serial.acquire", device, json!({}), None).await?;
        r["lease"].as_str().map(String::from).ok_or_else(|| "serial.acquire returned no lease".into())
    }

    pub async fn release(&self, device: &Value, lease: &str) -> R<Value> {
        self.op("serial.release", device, json!({}), Some(lease)).await
    }
}

/// POST /rpc over a raw loopback connection (one request per connection; no HTTP client dependency).
async fn post_rpc(port: u16, token: &str, body: &str) -> R<Value> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Cannot reach the DeviceDock bridge on 127.0.0.1:{port}: {e}"))?;
    let req = format!(
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let (status, body) = parse_http_response(&buf)?;
    if !(200..300).contains(&status) {
        return Err(format!("Bridge returned HTTP {status}"));
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

/// Status and body of a complete HTTP/1.1 response (Content-Length or chunked).
pub fn parse_http_response(buf: &[u8]) -> R<(u16, Vec<u8>)> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("Invalid HTTP response")?;
    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
    let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).ok_or("Invalid HTTP response")?;
    let mut body = buf[end + 4..].to_vec();
    if head.lines().any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked")) {
        let (mut out, mut rest) = (vec![], &body[..]);
        while let Some(i) = rest.windows(2).position(|w| w == b"\r\n") {
            let size = std::str::from_utf8(&rest[..i]).ok().and_then(|s| usize::from_str_radix(s.split(';').next()?.trim(), 16).ok());
            let Some(n) = size.filter(|n| *n > 0 && rest.len() >= i + 2 + n) else { break };
            out.extend_from_slice(&rest[i + 2..i + 2 + n]);
            rest = &rest[(i + 4 + n).min(rest.len())..];
        }
        body = out;
    }
    Ok((status, body))
}

// ---------- the `device` CLI ----------

const COMMANDS: &str = "Commands: list, connect, configure, send (--text|--hex [--read SECONDS]), signals, monitor [--seconds N], disconnect, flash-open [--purpose TEXT], flash-close, probe-open, probe-close";

/// Set on Ctrl-C / SIGTERM, so a command stops cleanly and releases its lease (a killed client leaves it held for
/// 30 s, and the next command fails with "Device already leased").
static STOPPING: AtomicBool = AtomicBool::new(false);

struct Flags<'a>(&'a [String]);
impl Flags<'_> {
    fn has(&self, key: &str) -> bool {
        self.0.iter().any(|f| f == key)
    }
    /// The word after `key` (like the original: with `key` absent this is the first flag).
    fn value(&self, key: &str) -> Option<&str> {
        let i = self.0.iter().position(|f| f == key).map_or(0, |i| i + 1);
        self.0.get(i).map(String::as_str)
    }
    fn seconds(&self, key: &str) -> R<f64> {
        let n = js_number(self.value(key));
        if n.is_nan() || n <= 0.0 || n > 3600.0 {
            return Err(format!("{key} needs a number of seconds between 0 and 3600"));
        }
        Ok(n)
    }
}

/// JavaScript's `Number(s)` for the inputs a flag can have: trimmed decimal, empty = 0, anything else NaN.
fn js_number(s: Option<&str>) -> f64 {
    match s.map(str::trim) {
        None => f64::NAN,
        Some("") => 0.0,
        Some(t) if t.bytes().all(|c| c.is_ascii_digit() || b".eE+-".contains(&c)) => t.parse().unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
}

/// An integer-valued number as a JSON integer (115200, not 115200.0); NaN becomes null, as in JSON.stringify.
fn js_json(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// Prints what the board sends for `ms` milliseconds (or until Ctrl-C), inside the caller's lease.
async fn read_for(client: &DeviceClient, d: &Value, lease: &str, ms: f64) -> R<()> {
    let end = now_ms() as f64 + ms;
    while !STOPPING.load(Ordering::SeqCst) && (now_ms() as f64) < end {
        let r = client.op("serial.read", d, json!({"maxBytes": 16384}), Some(lease)).await?;
        let bytes = STANDARD.decode(r["data"].as_str().unwrap_or_default()).unwrap_or_default();
        if !bytes.is_empty() {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(&bytes);
            let _ = out.flush();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

/// `devicedock device <cmd> [id] [flags]`: returns the exit code.
pub async fn main(args: &[String]) -> u8 {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h" | "help")) {
        println!("usage: device <command> [DEVICE_ID] [flags]\n{COMMANDS}");
        return 0;
    }
    for kind in [tokio::signal::unix::SignalKind::interrupt(), tokio::signal::unix::SignalKind::terminate()] {
        if let Ok(mut s) = tokio::signal::unix::signal(kind) {
            tokio::spawn(async move {
                while s.recv().await.is_some() {
                    STOPPING.store(true, Ordering::SeqCst);
                }
            });
        }
    }
    match run(DeviceClient::http(), args).await {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

pub async fn run(client: DeviceClient, args: &[String]) -> R<()> {
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let id = args.get(1).map(String::as_str);
    let flags = Flags(args.get(2..).unwrap_or_default());
    let devices = client.list().await?;
    if cmd == "list" {
        // Same order as the RFC 2217 ports: the Nth device here is on port 2217+N. Use its `rfc2217` URL for esptool,
        // pyserial, mpremote and PlatformIO (real hardware first, then simulators).
        // Debug probes follow, each with the OpenOCD commands for its own port (4441, 4442, ...).
        let mut out = vec![];
        for (i, mut d) in order_devices(&devices).into_iter().enumerate() {
            d["rfc2217"] = json!(rfc2217_url(rfc2217_base() + i as u16));
            out.push(d);
        }
        for (i, mut d) in order_probes(&devices).into_iter().enumerate() {
            d["openocd"] = json!(openocd_config(probe_base() + i as u16));
            out.push(d);
        }
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return Ok(());
    }
    let d = devices.iter().find(|d| id.is_some() && d["id"].as_str() == id).ok_or("Device not exposed; run device list")?;
    if cmd == "flash-close" {
        // No lease: the tool that just flashed may still hold the device, and closing only takes rights away.
        client.op("flash.close", d, json!({}), None).await?;
        println!("Flash session closed.");
        return Ok(());
    }
    let lease = client.acquire(d).await?;
    let r = with_lease(&client, d, &lease, cmd, &flags).await;
    let _ = client.release(d, &lease).await;
    r
}

async fn with_lease(client: &DeviceClient, d: &Value, lease: &str, cmd: &str, flags: &Flags<'_>) -> R<()> {
    let id = d["id"].as_str().unwrap_or_default();
    let call = |op: &'static str, args: Value| client.op(op, d, args, Some(lease));
    match cmd {
        "probe-open" => {
            // One human approval opens a debug session; OpenOCD runs inside it need no further clicks. It lapses after
            // 10 minutes without probe traffic, or when the human cuts it off in the page.
            eprintln!("Waiting for approval in the DeviceDock page (up to 25 s)...");
            let r = call("probe.open", json!({})).await?;
            println!(
                "Probe session {}. Now run OpenOCD with the device's `openocd` commands from `device list`.",
                js_string(&r["session"])
            );
        }
        "probe-close" => {
            call("probe.close", json!({})).await?;
            println!("Probe session closed.");
        }
        "flash-open" => {
            // One human approval covers one flash of a real board: writes, DTR/RTS resets and baud changes need no
            // further clicks until it is idle for 2 minutes, 20 minutes have passed, `flash-close`, or the human cuts
            // it off.
            let purpose = if flags.has("--purpose") { flags.value("--purpose") } else { None };
            if purpose.is_some_and(|p| p.is_empty() || p.encode_utf16().count() > 200) {
                return Err("--purpose needs a text of at most 200 characters".into());
            }
            eprintln!("Waiting for approval in the DeviceDock page (up to 25 s)...");
            let args = match purpose.filter(|p| !p.is_empty()) {
                Some(p) => json!({"purpose": p}),
                None => json!({}),
            };
            let r = call("flash.open", args).await?;
            if r["session"] == "not needed" {
                println!("No flash session needed: this device is a simulator or in autonomous mode.");
            } else {
                println!(
                    "Flash session {}. Flash now (esptool or idf.py with the device's rfc2217 URL), then run `device flash-close {id}`.",
                    js_string(&r["session"])
                );
            }
        }
        "send" => {
            let data = if flags.has("--hex") {
                hex_bytes(flags.value("--hex").ok_or("Enter complete hexadecimal byte pairs (maximum 16 KiB)")?)?
            } else if flags.has("--text") {
                flags.value("--text").ok_or("--text needs a text")?.as_bytes().to_vec()
            } else {
                return Err("Use --text or --hex".into());
            };
            // --text sends the characters as given: use \r for Enter on a REPL. --read N then prints the reply for N
            // seconds within the SAME lease; without it the reply is lost, because the lease's read queue ends with it.
            let wait = if flags.has("--read") { flags.seconds("--read")? } else { 0.0 };
            call("serial.write", json!({"data": STANDARD.encode(&data)})).await?;
            if wait > 0.0 {
                read_for(client, d, lease, wait * 1000.0).await?;
            }
        }
        "connect" | "configure" => {
            let baud = match flags.value("--baud").filter(|v| !v.is_empty()) {
                Some(v) => js_number(Some(v)),
                None => 115200.0,
            };
            let op = if cmd == "connect" { "serial.connect" } else { "serial.configure" };
            call(op, json!({"baudRate": js_json(baud)})).await?;
        }
        "disconnect" => {
            call("serial.disconnect", json!({})).await?;
        }
        "signals" => {
            let parse = |flag: &str| match flags.value(flag) {
                Some("true") => Ok(true),
                Some("false") => Ok(false),
                _ => Err(format!("{flag} requires true or false")),
            };
            let mut args = serde_json::Map::new();
            if flags.has("--dtr") {
                args.insert("dataTerminalReady".into(), json!(parse("--dtr")?));
            }
            if flags.has("--rts") {
                args.insert("requestToSend".into(), json!(parse("--rts")?));
            }
            call("serial.signals", Value::Object(args)).await?;
        }
        "monitor" => {
            // Runs until Ctrl-C, or for --seconds N. It holds the device exclusively: nothing else (another
            // `device send`, esptool on the RFC 2217 port) can talk to the board meanwhile.
            let ms = if flags.has("--seconds") { flags.seconds("--seconds")? * 1000.0 } else { f64::INFINITY };
            read_for(client, d, lease, ms).await?;
        }
        _ => return Err(COMMANDS.into()),
    }
    Ok(())
}

/// How a template literal shows a value: strings as is, anything else as JSON.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "undefined".into(),
        v => v.to_string(),
    }
}

#[cfg(test)]
pub mod tests {
    //! The device client end to end: HTTP to the real bridge service, its WebSocket to the backend's real bridge
    //! session, the real broker, and a page that answers like the browser mock (PING -> PONG, else echo).
    use super::*;
    use crate::broker::{Broker, Sink};
    use crate::protocol::{encode_base64, Descriptor};

    /// A client that talks to the broker directly, the way the bridge would relay it.
    pub fn direct(broker: Arc<Broker>) -> DeviceClient {
        DeviceClient::new(Arc::new(move |m: Value| {
            let b = broker.clone();
            Box::pin(async move {
                let client = m["client"].as_str().unwrap_or_default().to_string();
                let id = m["request"]["id"].clone();
                Ok(match b.run(&client, crate::broker::Source::Agent, &m["request"]).await {
                    Ok(result) => json!({"id": id, "ok": true, "result": result}),
                    Err(e) => json!({"id": id, "ok": false, "error": e}),
                })
            })
        }))
    }

    pub fn descriptor(kind: &str, auto: bool) -> Descriptor {
        Descriptor {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Mock".into(),
            kind: kind.into(),
            engine: None,
            board: None,
            generation: 1,
            auto_approve: auto,
            autonomous_until: None,
            baud_rate: 115200,
        }
    }

    /// The browser mock's behaviour: PING\n answers PONG\n, other bytes are echoed.
    fn mock_page(broker: &Arc<Broker>, d: &Descriptor) -> Sink {
        let (b, id) = (Arc::downgrade(broker), d.id.clone());
        Arc::new(move |m: Value| {
            if m["type"] != "operation" {
                return;
            }
            let (b, id) = (b.clone(), id.clone());
            // The broker holds its lock while it calls us: answer from a task.
            tokio::spawn(async move {
                let Some(b) = b.upgrade() else { return };
                let req = &m["request"];
                if req["op"] == "serial.write" {
                    let bytes = STANDARD.decode(req["args"]["data"].as_str().unwrap()).unwrap();
                    b.data("browser", &id, 1, if bytes == b"PING\n" { b"PONG\n" } else { &bytes });
                }
                b.reply("browser", req["id"].as_str().unwrap(), true, None, None);
            });
        })
    }

    #[tokio::test]
    async fn device_client_round_trips_through_bridge_and_broker_then_fails_after_revocation() {
        let dir = std::env::temp_dir().join(format!("dd-client-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let token = crate::sandbox::random_hex();
        std::fs::write(dir.join("token"), &token).unwrap();
        let bridge = crate::bridge::Bridge::new(0, dir.join("token"));
        let port = bridge.clone().listen("127.0.0.1").await.unwrap();
        // The backend's side: dial the bridge and run the real bridge session against a broker.
        let broker = Broker::new();
        let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://127.0.0.1:{port}/bridge"
        ))
        .unwrap();
        req.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        let (b, stop) = (broker.clone(), Arc::new(tokio::sync::Notify::new()));
        let s2 = stop.clone();
        tokio::spawn(async move { crate::app::bridge_session(&b, &s2, ws).await });
        let d = descriptor("mock", true);
        broker.expose("browser", mock_page(&broker, &d), d.clone()).unwrap();

        let client = DeviceClient::http_to(port, dir.join("token"));
        // The bridge may not have registered the backend's WebSocket yet.
        let mut list = Err(String::new());
        for _ in 0..100 {
            list = client.list().await;
            if list.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let found = list.unwrap().remove(0);
        assert_eq!(found["id"], json!(d.id));
        let lease = client.acquire(&found).await.unwrap();
        let w = |data: &[u8]| client.op("serial.write", &found, json!({"data": encode_base64(data)}), Some(&lease));
        let read = || client.op("serial.read", &found, json!({}), Some(&lease));
        w(b"PING\n").await.unwrap();
        assert_eq!(STANDARD.decode(read().await.unwrap()["data"].as_str().unwrap()).unwrap(), b"PONG\n");
        w(&[0, 255, 128, 10]).await.unwrap();
        assert_eq!(STANDARD.decode(read().await.unwrap()["data"].as_str().unwrap()).unwrap(), [0, 255, 128, 10]);
        broker.revoke("browser", &d.id);
        assert!(w(&[0]).await.unwrap_err().contains("unavailable"));
        client.release(&found, &lease).await.ok();
        assert_eq!(client.list().await.unwrap(), Vec::<Value>::new());

        // The token is checked, and the client says what went wrong.
        std::fs::write(dir.join("wrong"), "x".repeat(64)).unwrap();
        assert_eq!(DeviceClient::http_to(port, dir.join("wrong")).list().await.unwrap_err(), "Bridge returned HTTP 403");
        stop.notify_waiters();
        std::fs::remove_dir_all(dir).ok();
    }

    /// The CLI against a broker: its error messages (output goes to the test's stdout).
    #[tokio::test]
    async fn cli_messages() {
        let broker = Broker::new();
        let d = descriptor("mock", true);
        broker.expose("browser", mock_page(&broker, &d), d.clone()).unwrap();
        let client = direct(broker.clone());
        let run = |args: &[&str]| {
            let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            let c = client.clone();
            async move { run(c, &args).await }
        };
        assert_eq!(run(&["send", "nope"]).await.unwrap_err(), "Device not exposed; run device list");
        assert_eq!(run(&["--bogus"]).await.unwrap_err(), "Device not exposed; run device list");
        assert_eq!(run(&["bogus", &d.id]).await.unwrap_err(), COMMANDS);
        assert_eq!(run(&["send", &d.id]).await.unwrap_err(), "Use --text or --hex");
        assert!(run(&["send", &d.id, "--hex", "abc"]).await.unwrap_err().starts_with("Enter complete hexadecimal"));
        assert_eq!(run(&["send", &d.id, "--text", "x", "--read", "0"]).await.unwrap_err(), "--read needs a number of seconds between 0 and 3600");
        assert_eq!(run(&["signals", &d.id, "--dtr", "yes"]).await.unwrap_err(), "--dtr requires true or false");
        let long = "x".repeat(201);
        assert_eq!(run(&["flash-open", &d.id, "--purpose", &long]).await.unwrap_err(), "--purpose needs a text of at most 200 characters");
        run(&["list"]).await.unwrap();
        run(&["send", &d.id, "--text", "PING\n", "--read", "0.3"]).await.unwrap();
        run(&["signals", &d.id, "--dtr", "true", "--rts", "false"]).await.unwrap();
        run(&["configure", &d.id, "--baud", "9600"]).await.unwrap();
        run(&["flash-open", &d.id, "--purpose", "esptool chip-id"]).await.unwrap();
        run(&["flash-close", &d.id]).await.unwrap();
        // Every command released its lease: a new client can take the device at once.
        direct(broker.clone()).acquire(&json!({"id": d.id, "generation": 1})).await.unwrap();
    }

    #[test]
    fn numbers_and_flags_behave_like_the_original() {
        assert_eq!(js_number(Some(" 5 ")), 5.0);
        assert_eq!(js_number(Some("")), 0.0);
        assert!(js_number(Some("abc")).is_nan());
        assert!(js_number(None).is_nan());
        assert_eq!(js_json(115200.0), json!(115200));
        assert_eq!(js_json(f64::NAN), Value::Null);
        let f = vec!["--read".to_string()];
        assert_eq!(Flags(&f).value("--read"), None);
        assert_eq!(Flags(&f).value("--baud"), Some("--read"));
    }

    #[test]
    fn http_responses() {
        assert_eq!(parse_http_response(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}").unwrap(), (200, b"{}".to_vec()));
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n").unwrap(),
            (200, b"{}".to_vec())
        );
        assert_eq!(parse_http_response(b"HTTP/1.1 403 Forbidden\r\n\r\n").unwrap().0, 403);
    }
}
