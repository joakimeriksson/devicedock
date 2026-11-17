//! Black-box tests of the backend: they drive the real binary over HTTP and WebSockets, the same way the page and the
//! sandbox's bridge service do (here a stand-in bridge that checks the exact messages).
mod common;
use common::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PORT: u16 = 47961;
const BRIDGE: u16 = 47962;

#[tokio::test(flavor = "multi_thread")]
async fn backend_auth_csrf_admin_links_static_files_and_the_page_broker_bridge_flow() {
    let boot = "b".repeat(64);
    let bridge_token = "t".repeat(64);
    let origin = format!("http://127.0.0.1:{PORT}");
    // The stand-in sandbox bridge must be up before the backend dials it.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", BRIDGE)).await.unwrap();
    let auth: Arc<Mutex<Option<String>>> = Arc::default();
    let a = auth.clone();
    let bridge_conn = tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        #[allow(clippy::result_large_err)] // the handshake callback's signature is tungstenite's
        let cb = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
            *a.lock().unwrap() = req.headers().get("authorization").and_then(|v| v.to_str().ok()).map(String::from);
            Ok(resp)
        };
        Ws::new(tokio_tungstenite::accept_hdr_async(s, cb).await.unwrap())
    });
    let dir = scratch(&bridge_token);
    let _backend = backend(&dir, PORT, BRIDGE, &boot);

    // HTTP auth
    assert_eq!(http(PORT, "GET", "/api/health", &[], "").await.status, 401);
    assert_eq!(http(PORT, "GET", "/api/health", &[("Host", "evil.example")], "").await.status, 403);
    assert_eq!(http(PORT, "GET", "/", &[("Host", "evil.example")], "").await.status, 403);
    let body = json!({"token": boot}).to_string();
    let evil = http(PORT, "POST", "/api/session", &[("Content-Type", "application/json"), ("Origin", "http://evil.example")], &body).await;
    assert_eq!(evil.status, 403);
    let page = http(PORT, "GET", "/", &[], "").await;
    assert_eq!(page.status, 200);
    assert!(page.body.contains("<title>dock"));
    assert_eq!(page.headers["cache-control"], "no-store");
    assert!(page.headers["content-security-policy"].contains("frame-ancestors 'none'"));
    assert_eq!(http(PORT, "GET", "/nope.js", &[], "").await.status, 404);
    assert_eq!(http(PORT, "GET", "/.runtime/admin-token", &[], "").await.status, 404);
    assert_ne!(http(PORT, "GET", "/../.runtime/admin-token", &[], "").await.status, 200);
    let admin = std::fs::read_to_string(dir.join(".runtime/admin-token")).unwrap().trim().to_string();
    assert_eq!(admin.len(), 64);
    assert_eq!(std::fs::read_to_string(dir.join(".runtime/session-link")).unwrap(), format!("{origin}/#token={boot}"));

    // One-time login links
    let r = login(PORT, &boot).await;
    assert_eq!(r.status, 200);
    assert!(r.headers["set-cookie"].contains("HttpOnly; SameSite=Strict"));
    let cookie = r.headers["set-cookie"].split(';').next().unwrap().to_string();
    let csrf = r.json()["csrf"].as_str().unwrap().to_string();
    assert_eq!(login(PORT, &boot).await.status, 403, "the startup link works once");
    assert_eq!(http(PORT, "POST", "/api/anything", &[("Cookie", &cookie), ("Origin", &origin)], "").await.status, 403, "CSRF");
    assert_eq!(http(PORT, "GET", "/api/session", &[("Cookie", &cookie)], "").await.json()["csrf"], json!(csrf));
    let bearer = format!("Bearer {admin}");
    let mint = |h: Vec<(&'static str, String)>| async move {
        let h: Vec<(&str, &str)> = h.iter().map(|(k, v)| (*k, v.as_str())).collect();
        http(PORT, "POST", "/admin/session-link", &h, "").await
    };
    assert_eq!(mint(vec![]).await.status, 403);
    assert_eq!(mint(vec![("Authorization", bearer.clone()), ("Origin", origin.clone())]).await.status, 403, "never from a browser");
    let ok = mint(vec![("Authorization", bearer.clone())]).await;
    assert_eq!(ok.status, 200);
    let url = ok.json()["url"].as_str().unwrap().to_string();
    assert!(url.starts_with(&format!("{origin}/#token=")));
    assert_eq!(login(PORT, url.split("#token=").nth(1).unwrap()).await.status, 200);
    let mut codes = vec![];
    for _ in 0..6 {
        codes.push(mint(vec![("Authorization", bearer.clone())]).await.status);
    }
    assert_eq!(codes, [200, 200, 200, 200, 200, 429], "at most 5 unused links");

    // WebSocket guard
    assert_eq!(page_socket(PORT, &format!("dock, {csrf}"), &cookie, "http://evil.example").await.err(), Some(403));
    assert_eq!(page_socket(PORT, "dock", &cookie, &origin).await.err(), Some(403));

    // The page shares a device; an agent request via the bridge needs approval; the reply flows back.
    let (page, proto) = page_socket(PORT, &format!("dock, {csrf}"), &cookie, &origin).await.unwrap();
    assert_eq!(proto.as_deref(), Some("dock"));
    let id = uuid::Uuid::new_v4().to_string();
    let dev = json!({"id": id, "name": "LaunchPad", "kind": "serial", "generation": 1, "autoApprove": false, "baudRate": 115200});
    let mut auto = dev.clone();
    auto["autoApprove"] = json!(true);
    page.send(json!({"type": "expose", "device": auto}));
    assert!(page.next(|m| m["type"] == "error").await["error"].as_str().unwrap().contains("require approval"));
    page.send(json!({"type": "expose", "device": dev}));
    page.send(json!({"type": "bogus"}));
    page.next(|m| m["type"] == "error").await;

    let br = tokio::time::timeout(Duration::from_secs(10), bridge_conn).await.expect("the backend dials the bridge").unwrap();
    assert_eq!(auth.lock().unwrap().as_deref(), Some(format!("Bearer {bridge_token}").as_str()));
    let client = uuid::Uuid::new_v4().to_string();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let ask = |op: &'static str, args: Value, lease: Option<String>| {
        let (br, page, client, asked, id) = (br.clone(), page.clone(), client.clone(), asked.clone(), id.clone());
        async move {
            let rid = uuid::Uuid::new_v4().to_string();
            let deadline = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 10000;
            let mut request = json!({"v": 1, "id": rid, "op": op, "args": args, "deadline": deadline, "deviceId": id, "generation": 1});
            if let Some(l) = lease {
                request["lease"] = json!(l);
            }
            br.send(json!({"client": client, "request": request}));
            for _ in 0..300 {
                if let Some(r) = br.take(|r| r["id"] == json!(rid)) {
                    return r;
                }
                if op == "serial.write" || op == "flash.open" {
                    if let Some(m) = page.take(|m| m["type"] == "approval" && m["request"]["id"] == json!(rid)) {
                        assert_eq!(m["request"]["args"], args);
                        asked.lock().unwrap().push(op.to_string());
                        page.send(json!({"type": "approve", "id": rid, "allow": true}));
                    }
                    if page.take(|m| m["type"] == "operation" && m["request"]["id"] == json!(rid)).is_some() {
                        page.send(json!({"type": "reply", "id": rid, "ok": true}));
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no reply for {op}");
        }
    };
    let list = ask("devices.list", json!({}), None).await;
    assert_eq!(list["ok"], true);
    assert_eq!(
        list["result"],
        json!([{"id": id, "name": "LaunchPad", "kind": "serial", "simulated": false, "generation": 1, "baudRate": 115200, "autonomous": false, "flashSession": false}])
    );
    let acq = ask("serial.acquire", json!({}), None).await;
    assert_eq!(acq["ok"], true);
    let lease = acq["result"]["lease"].as_str().unwrap().to_string();
    page.send(json!({"type": "data", "deviceId": id, "generation": 1, "data": "aGVsbG8K"}));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let rd = ask("serial.read", json!({}), Some(lease.clone())).await;
    assert_eq!(rd["result"]["data"], "aGVsbG8K"); // "hello\n"
    let wr = ask("serial.write", json!({"data": "UElORw=="}), Some(lease.clone())).await;
    assert_eq!(wr, json!({"id": wr["id"], "ok": true, "result": {}}));
    let bad = ask("serial.read", json!({}), Some(uuid::Uuid::new_v4().to_string())).await;
    assert_eq!(bad["ok"], false);
    assert!(bad["error"].as_str().unwrap().contains("lease required"));
    // A flash session: one approval (showing the agent's purpose), then writes go straight to the page, until the page
    // cuts it off.
    asked.lock().unwrap().clear();
    let fo = ask("flash.open", json!({"purpose": "esptool write-flash 0x0 app.bin"}), Some(lease.clone())).await;
    assert_eq!(fo["result"], json!({"session": "opened"}));
    assert_eq!(page.next(|m| m["type"] == "flash-session").await["active"], true);
    assert_eq!(ask("serial.write", json!({"data": "AA=="}), Some(lease.clone())).await["ok"], true);
    assert_eq!(*asked.lock().unwrap(), ["flash.open"]);
    assert_eq!(ask("devices.list", json!({}), None).await["result"][0]["flashSession"], true);
    page.send(json!({"type": "flash-end", "deviceId": id}));
    assert_eq!(page.next(|m| m["type"] == "flash-session").await["active"], false);
    assert_eq!(ask("serial.write", json!({"data": "AA=="}), Some(lease.clone())).await["ok"], true);
    assert_eq!(*asked.lock().unwrap(), ["flash.open", "serial.write"]);
    // The page's own RPC path.
    let rid = uuid::Uuid::new_v4().to_string();
    let deadline = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 5000;
    page.send(json!({"type": "rpc", "request": {"v": 1, "id": rid, "op": "devices.list", "args": {}, "deadline": deadline}}));
    let rr = page.next(|m| m["type"] == "rpc-result").await;
    assert_eq!(rr["id"], json!(rid));
    assert_eq!(rr["result"].as_array().unwrap().len(), 1);
    // Closing the page revokes its devices.
    page.close();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(ask("devices.list", json!({}), None).await["result"], json!([]));
    std::fs::remove_dir_all(dir).ok();
}
