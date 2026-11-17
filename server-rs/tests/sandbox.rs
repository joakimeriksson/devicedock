//! The sandbox side end to end, outside Docker: the backend, `devicedock bridge` (on test ports), a page that shares
//! a mock device, and the agent-side tools: the `device` CLI, the MCP server and an RFC 2217 client.
mod common;
use common::*;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PORT: u16 = 47963;
const BRIDGE: u16 = 47964;
const RFC2217: u16 = 22170;
const PROBE: u16 = 22180;

struct Out {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}
impl Out {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

fn sandbox_env(token_file: &std::path::Path) -> Vec<(&'static str, String)> {
    vec![
        ("DEVICEDOCK_BRIDGE_PORT", BRIDGE.to_string()),
        ("DEVICEDOCK_BRIDGE_TOKEN_FILE", token_file.display().to_string()),
        ("DEVICEDOCK_RFC2217_PORT", RFC2217.to_string()),
        ("DEVICEDOCK_PROBE_PORT", PROBE.to_string()),
    ]
}

/// Runs `devicedock <args>` to completion (off the async runtime).
async fn run(env: &[(&'static str, String)], args: &[&str], stdin: &str) -> Out {
    let (env, args, stdin) = (env.to_vec(), args.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin.to_string());
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(BIN);
        cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in &env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        let o = child.wait_with_output().unwrap();
        Out { code: o.status.code().unwrap_or(-1), stdout: o.stdout, stderr: String::from_utf8_lossy(&o.stderr).into_owned() }
    })
    .await
    .unwrap()
}

async fn read_until(s: &mut tokio::net::TcpStream, want: &[u8]) -> Vec<u8> {
    let mut got = vec![];
    let mut buf = [0u8; 4096];
    while !got.windows(want.len()).any(|w| w == want) {
        match tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => got.extend(&buf[..n]),
            _ => break,
        }
    }
    got
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_tools_reach_a_shared_device_through_bridge_and_backend() {
    let token = "s".repeat(64);
    let boot = "c".repeat(64);
    let dir = scratch(&token);
    let token_file = dir.join(".runtime/bridge-token");
    std::fs::create_dir_all(dir.join("workspace")).unwrap();
    let env = sandbox_env(&token_file);
    let mut bridge_env = env.clone();
    bridge_env.push(("DEVICEDOCK_BRIDGE_HOST", "127.0.0.1".into()));
    bridge_env.push(("DEVICEDOCK_WORKSPACE", dir.join("workspace").display().to_string()));
    let _bridge = spawn(&dir, &["bridge"], &bridge_env, "Container device bridge ready");

    // Before the backend is connected, tools get the bridge's answer.
    let early = run(&env, &["device", "list"], "").await;
    assert_eq!((early.code, early.stderr.trim()), (1, "Bridge returned HTTP 503"));

    let _backend = backend(&dir, PORT, BRIDGE, &boot);
    let (cookie, csrf) = session(PORT, &boot).await;
    let origin = format!("http://127.0.0.1:{PORT}");
    let (page, _) = page_socket(PORT, &format!("dock, {csrf}"), &cookie, &origin).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    page.send(json!({"type": "expose", "device": {"id": id, "name": "Mock", "kind": "mock", "generation": 1, "autoApprove": true, "baudRate": 115200}}));
    // The page answers like the browser mock: PING -> PONG, other bytes echoed.
    let p = page.clone();
    let dev = id.clone();
    tokio::spawn(async move {
        loop {
            if let Some(m) = p.take(|m| m["type"] == "operation") {
                let req = &m["request"];
                if req["op"] == "serial.write" {
                    let data = req["args"]["data"].as_str().unwrap();
                    let data = if data == "UElORwo=" { "UE9ORwo=" } else { data }; // PING\n -> PONG\n
                    p.send(json!({"type": "data", "deviceId": dev, "generation": 1, "data": data}));
                }
                p.send(json!({"type": "reply", "id": req["id"], "ok": true}));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    // `device list`, once the backend has dialled the bridge (it retries every 3 s).
    let mut list = early;
    for _ in 0..100 {
        list = run(&env, &["device", "list"], "").await;
        if list.code == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(list.code, 0, "{}", list.stderr);
    let devices: Value = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(devices[0]["id"], json!(id));
    assert_eq!(devices[0]["simulated"], true);
    assert_eq!(devices[0]["rfc2217"], format!("rfc2217://127.0.0.1:{RFC2217}"));
    assert!(list.text().starts_with("[\n  {\n    \"id\": "), "pretty-printed like before: {}", list.text());

    let ping = run(&env, &["device", "send", &id, "--text", "PING\n", "--read", "1"], "").await;
    assert_eq!((ping.code, ping.text()), (0, "PONG\n".to_string()), "{}", ping.stderr);
    let bin = run(&env, &["device", "send", &id, "--hex", "00 ff 80 0d 0a", "--read", "1"], "").await;
    assert_eq!(bin.stdout, [0, 255, 128, 13, 10]);
    let flash = run(&env, &["device", "flash-open", &id, "--purpose", "esptool chip-id"], "").await;
    assert_eq!(flash.code, 0, "{}", flash.stderr);
    assert_eq!(flash.text(), "No flash session needed: this device is a simulator or in autonomous mode.\n");
    assert_eq!(flash.stderr, "Waiting for approval in the DeviceDock page (up to 25 s)...\n");
    let closed = run(&env, &["device", "flash-close", &id], "").await;
    assert_eq!((closed.code, closed.text()), (0, "Flash session closed.\n".to_string()));
    for (args, msg) in [
        (vec!["device", "nope", &id], "Commands: list, connect, configure"),
        (vec!["device", "send"], "Device not exposed; run device list"),
        (vec!["device", "signals", &id, "--rts", "maybe"], "--rts requires true or false"),
    ] {
        let o = run(&env, &args, "").await;
        assert_eq!(o.code, 1, "{args:?}");
        assert!(o.stderr.starts_with(msg), "{args:?}: {}", o.stderr);
    }
    let help = run(&env, &["device", "--help"], "").await;
    assert_eq!(help.code, 0);
    assert!(help.text().contains("Commands: list"));
    std::fs::write(dir.join("wrong-token"), "w".repeat(64)).unwrap();
    let mut wrong = env.clone();
    wrong[1].1 = dir.join("wrong-token").display().to_string();
    assert_eq!(run(&wrong, &["device", "list"], "").await.stderr.trim(), "Bridge returned HTTP 403");

    // The bridge's own guards: Host, Origin, one backend at a time.
    let auth = format!("Bearer {token}");
    let rpc = |headers: Vec<(&'static str, String)>| async move {
        let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        http(BRIDGE, "POST", "/rpc", &h, "{}").await.status
    };
    assert_eq!(rpc(vec![("Authorization", auth.clone())]).await, 400);
    assert_eq!(rpc(vec![("Authorization", auth.clone()), ("Host", "localhost:47964".into())]).await, 403);
    assert_eq!(rpc(vec![("Authorization", auth.clone()), ("Origin", "http://127.0.0.1".into())]).await, 403);
    assert_eq!(rpc(vec![]).await, 403);
    let upgrade = [("Authorization", auth.as_str()), ("Connection", "Upgrade"), ("Upgrade", "websocket"), ("Sec-WebSocket-Version", "13"), ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")];
    assert_eq!(http(BRIDGE, "GET", "/bridge", &upgrade, "").await.status, 403, "a second backend is refused");

    // MCP over stdio.
    let requests = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "devices_list", "arguments": {}}}),
    ];
    let input: String = requests.iter().map(|r| r.to_string() + "\n").collect();
    // Keep stdin open briefly so the call can finish before the server sees EOF.
    let mcp = tokio::task::spawn_blocking({
        let env = env.clone();
        move || {
            let mut cmd = Command::new(BIN);
            cmd.arg("mcp").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
            for (k, v) in &env {
                cmd.env(k, v);
            }
            let mut child = cmd.spawn().unwrap();
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(input.as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            drop(stdin);
            child.wait_with_output().unwrap()
        }
    })
    .await
    .unwrap();
    let replies: Vec<Value> = String::from_utf8_lossy(&mcp.stdout).lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let reply = |id: i64| replies.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("no reply {id}: {replies:?}"));
    assert_eq!(replies.len(), 3);
    assert_eq!(reply(1)["result"]["serverInfo"]["name"], "devicedock");
    assert_eq!(reply(2)["result"]["tools"].as_array().unwrap().len(), 9);
    let listed: Value = serde_json::from_str(reply(3)["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listed[0]["id"], json!(id));

    // RFC 2217: the handshake, then PING -> PONG through the lease.
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", RFC2217)).await.unwrap();
    let hello = read_until(&mut s, &[255, 253, 3]).await;
    assert!(hello.starts_with(&[255, 251, 44]), "{hello:?}");
    s.write_all(b"PING\n").await.unwrap();
    let got = read_until(&mut s, b"PONG\n").await;
    assert!(got.ends_with(b"PONG\n"), "{got:?}");
    drop(s);
    // Ports without a device or probe close the connection.
    for port in [RFC2217 + 1, PROBE] {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut buf = vec![];
        let r = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf)).await;
        assert!(r.is_ok(), "port {port} stays open");
    }
    // The RFC 2217 session released its lease: the device is free again.
    let mut free = run(&env, &["device", "send", &id, "--text", "x"], "").await;
    for _ in 0..20 {
        if free.code == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        free = run(&env, &["device", "send", &id, "--text", "x"], "").await;
    }
    assert_eq!(free.code, 0, "{}", free.stderr);
    page.close();
    std::fs::remove_dir_all(dir).ok();
}
