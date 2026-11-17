//! Inside the sandbox: `devicedock mcp`, a stdio MCP server with the device tools (newline-delimited JSON-RPC 2.0).
//! The tools go through the same device client and bridge as the `device` CLI, so leases and approvals are the
//! broker's. Tool names, descriptions and input schemas are what agents were configured with: keep them stable.
use crate::device::DeviceClient;
use crate::protocol::{decode_base64, is_uuid, serial_options, R, MAX_BYTES};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const SERVER_NAME: &str = "devicedock";
const SERVER_VERSION: &str = "0.1.0";
const LATEST_PROTOCOL: &str = "2025-11-25";
const PROTOCOLS: [&str; 5] = [LATEST_PROTOCOL, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

fn device_json() -> Value {
    json!({
        "type": "object",
        "properties": {"id": {"type": "string", "format": "uuid"}, "generation": {"type": "integer", "minimum": 1}},
        "required": ["id", "generation"],
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": description, "inputSchema": {"type": "object", "properties": properties, "required": required}})
}

/// The tools as `tools/list` returns them.
pub fn tools() -> Vec<Value> {
    let lease = || json!({"device": device_json(), "lease": {"type": "string", "format": "uuid"}});
    let with = |extra: Value| {
        let mut p = lease();
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        p
    };
    let options = json!({"options": {
        "type": "object",
        "properties": {
            "baudRate": {"type": "integer", "minimum": 300, "maximum": 4000000},
            "dataBits": {"enum": [7, 8]},
            "stopBits": {"enum": [1, 2]},
            "parity": {"enum": ["none", "even", "odd"]},
            "flowControl": {"enum": ["none", "hardware"]},
        },
        "required": ["baudRate"],
    }});
    vec![
        tool("devices_list", "Discover browser-exposed devices", json!({}), &[]),
        tool("serial_acquire", "Acquire a 30-second exclusive lease. Operations renew it.", json!({"device": device_json()}), &["device"]),
        tool("serial_release", "release device access", lease(), &["device", "lease"]),
        tool("serial_disconnect", "disconnect device access", lease(), &["device", "lease"]),
        tool(
            "serial_read",
            "Consume bytes from the lease queue",
            with(json!({"maxBytes": {"type": "integer", "minimum": 1, "maximum": 16384}})),
            &["device", "lease"],
        ),
        tool(
            "serial_write",
            "Write base64 bytes. Physical devices require approval for every operation.",
            with(json!({"data": {"type": "string", "description": "Base64; maximum 16384 decoded bytes"}})),
            &["device", "lease", "data"],
        ),
        tool("serial_connect", "Configure serial port; physical devices require approval", with(options.clone()), &["device", "lease", "options"]),
        tool("serial_configure", "Configure serial port; physical devices require approval", with(options), &["device", "lease", "options"]),
        tool(
            "serial_signals",
            "Set control/reset lines; physical devices require approval",
            with(json!({"signals": {
                "type": "object",
                "properties": {
                    "dataTerminalReady": {"type": "boolean"},
                    "requestToSend": {"type": "boolean"},
                    "break": {"type": "boolean"},
                },
            }})),
            &["device", "lease", "signals"],
        ),
    ]
}

// ---------- argument checks (the same rules the original zod schemas applied) ----------

fn strict(a: &Map<String, Value>, allowed: &[&str]) -> R<()> {
    match a.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(format!("Unrecognized key: \"{k}\"")),
        None => Ok(()),
    }
}
fn required<'a>(a: &'a Map<String, Value>, k: &str) -> R<&'a Value> {
    a.get(k).ok_or_else(|| format!("{k}: Required"))
}
/// A device descriptor: `id` and `generation` are required, the rest defaults; unknown keys are dropped.
fn device_arg(a: &Map<String, Value>) -> R<Value> {
    let d = required(a, "device")?.as_object().ok_or("device: Expected object")?;
    let id = d.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or("device.id: Invalid uuid")?;
    let generation = d
        .get("generation")
        .and_then(Value::as_f64)
        .filter(|g| g.fract() == 0.0 && *g >= 1.0 && *g <= 9_007_199_254_740_991.0)
        .ok_or("device.generation: Expected a positive integer")?;
    let name = match d.get("name") {
        None => "Device",
        Some(v) => v.as_str().ok_or("device.name: Expected string")?,
    };
    let kind = match d.get("kind") {
        None => "serial",
        Some(v) => v.as_str().filter(|k| crate::protocol::DEVICE_KINDS.contains(k)).ok_or("device.kind: Invalid enum value")?,
    };
    let baud = match d.get("baudRate") {
        None => json!(115200),
        Some(v) if v.is_number() => v.clone(),
        Some(_) => return Err("device.baudRate: Expected number".into()),
    };
    Ok(json!({"id": id, "generation": generation as i64, "name": name, "kind": kind, "baudRate": baud}))
}
fn lease_arg(a: &Map<String, Value>) -> R<String> {
    required(a, "lease")?.as_str().filter(|s| is_uuid(s)).map(String::from).ok_or_else(|| "lease: Invalid uuid".into())
}

async fn call_tool(client: &DeviceClient, name: &str, args: &Value) -> R<Value> {
    let empty = Map::new();
    let a = match args {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return Err("Expected object".into()),
    };
    let leased = |extra: &[&str]| -> R<(Value, String)> {
        let mut allowed = vec!["device", "lease"];
        allowed.extend(extra);
        strict(a, &allowed)?;
        Ok((device_arg(a)?, lease_arg(a)?))
    };
    match name {
        "devices_list" => {
            strict(a, &[])?;
            Ok(Value::Array(client.list().await?))
        }
        "serial_acquire" => {
            strict(a, &["device"])?;
            client.op("serial.acquire", &device_arg(a)?, json!({}), None).await
        }
        "serial_release" | "serial_disconnect" => {
            let (d, l) = leased(&[])?;
            let op = if name == "serial_release" { "serial.release" } else { "serial.disconnect" };
            client.op(op, &d, json!({}), Some(&l)).await
        }
        "serial_read" => {
            let (d, l) = leased(&["maxBytes"])?;
            let max = match a.get("maxBytes") {
                None => 16384,
                Some(v) => v
                    .as_f64()
                    .filter(|n| n.fract() == 0.0 && (1.0..=16384.0).contains(n))
                    .ok_or("maxBytes: Expected an integer from 1 to 16384")? as i64,
            };
            client.op("serial.read", &d, json!({"maxBytes": max}), Some(&l)).await
        }
        "serial_write" => {
            let (d, l) = leased(&["data"])?;
            let data = required(a, "data")?.as_str().ok_or("data: Expected string")?;
            decode_base64(data, MAX_BYTES).map_err(|e| format!("data: {e}"))?;
            client.op("serial.write", &d, json!({"data": data}), Some(&l)).await
        }
        "serial_connect" | "serial_configure" => {
            let (d, l) = leased(&["options"])?;
            let o = required(a, "options")?.as_object().ok_or("options: Expected object")?;
            let options = serial_options(o).map_err(|e| format!("options.{e}"))?;
            let op = if name == "serial_connect" { "serial.connect" } else { "serial.configure" };
            client.op(op, &d, options, Some(&l)).await
        }
        "serial_signals" => {
            let (d, l) = leased(&["signals"])?;
            let s = required(a, "signals")?.as_object().ok_or("signals: Expected object")?;
            strict(s, &["dataTerminalReady", "requestToSend", "break"])?;
            let mut out = Map::new();
            for k in ["dataTerminalReady", "requestToSend", "break"] {
                if let Some(v) = s.get(k) {
                    out.insert(k.into(), json!(v.as_bool().ok_or_else(|| format!("signals.{k}: Expected boolean"))?));
                }
            }
            client.op("serial.signals", &d, Value::Object(out), Some(&l)).await
        }
        _ => Err("Unsupported device tool".into()),
    }
}

/// One JSON-RPC message in; the reply, or None for notifications and responses.
pub async fn handle(client: &DeviceClient, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let method = msg.get("method")?.as_str()?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or_default();
            let version = if PROTOCOLS.contains(&asked) { asked } else { LATEST_PROTOCOL };
            json!({
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools()}),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            match call_tool(client, name, params.get("arguments").unwrap_or(&Value::Null)).await {
                Ok(r) => json!({"content": [{"type": "text", "text": r.to_string()}]}),
                Err(e) => json!({"isError": true, "content": [{"type": "text", "text": json!({"error": e}).to_string()}]}),
            }
        }
        _ => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// `devicedock mcp`: serves stdin/stdout until stdin closes. Requests run concurrently (a write waiting for the human's
/// approval does not hold up the others).
pub async fn run() -> Result<(), String> {
    let client = DeviceClient::http();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() || out.write_all(b"\n").await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    });
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
            if !line.trim().is_empty() {
                let _ = tx.send(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}}).to_string());
            }
            continue;
        };
        let (client, tx) = (client.clone(), tx.clone());
        tokio::spawn(async move {
            if let Some(reply) = handle(&client, &msg).await {
                let _ = tx.send(reply.to_string());
            }
        });
    }
    drop(tx);
    writer.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::Broker;
    use crate::device::tests::{descriptor, direct};
    use std::sync::Arc;

    async fn call(client: &DeviceClient, name: &str, arguments: Value) -> Value {
        let r = handle(client, &json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":name,"arguments":arguments}})).await;
        r.unwrap()["result"].clone()
    }
    fn text(r: &Value) -> Value {
        serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn discovery_and_writes_use_leases_and_physical_approval() {
        let broker = Broker::new();
        let sent: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let d = descriptor("serial", false);
        let (s, b) = (sent.clone(), Arc::downgrade(&broker));
        broker
            .expose(
                "browser",
                Arc::new(move |m: Value| {
                    s.lock().unwrap().push(m.clone());
                    if m["type"] == "approval" {
                        let b = b.clone();
                        // The human says no (from a task: the broker holds its lock while it calls us).
                        tokio::spawn(async move { b.upgrade().unwrap().approve("browser", m["request"]["id"].as_str().unwrap(), false) });
                    }
                }),
                d.clone(),
            )
            .unwrap();
        let client = direct(broker.clone());
        let init = handle(&client, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"], json!({"name":"devicedock","version":"0.1.0"}));
        assert_eq!(init["result"]["capabilities"], json!({"tools":{}}));
        assert!(handle(&client, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.is_none());
        let listed = handle(&client, &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await.unwrap();
        let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            ["devices_list", "serial_acquire", "serial_release", "serial_disconnect", "serial_read", "serial_write", "serial_connect", "serial_configure", "serial_signals"]
        );
        let dev = json!({"id": d.id, "name": "Physical fixture", "kind": "serial", "generation": 1, "baudRate": 115200, "autoApprove": false});
        let listed = call(&client, "devices_list", json!({})).await;
        assert_eq!(text(&listed)[0]["id"], json!(d.id));
        let acquired = call(&client, "serial_acquire", json!({"device": dev})).await;
        let lease = text(&acquired)["lease"].as_str().unwrap().to_string();
        let denied = call(&client, "serial_write", json!({"device": dev, "lease": lease, "data": "AA=="})).await;
        assert_eq!(denied["isError"], true);
        assert!(text(&denied)["error"].as_str().unwrap().contains("denied"));
        assert_eq!(sent.lock().unwrap()[0]["type"], "approval");
        let missing = call(&client, "serial_write", json!({"device": dev, "lease": uuid::Uuid::new_v4().to_string(), "data": "AA=="})).await;
        assert_eq!(missing["isError"], true);
        assert!(text(&missing)["error"].as_str().unwrap().contains("lease required"));
        // Arguments are checked before anything reaches the broker.
        for (name, args) in [
            ("devices_list", json!({"x": 1})),
            ("serial_write", json!({"device": dev, "lease": lease, "data": "%%"})),
            ("serial_read", json!({"device": dev, "lease": lease, "maxBytes": 0})),
            ("serial_signals", json!({"device": dev, "lease": lease, "signals": {"dtr": true}})),
            ("serial_configure", json!({"device": dev, "lease": lease, "options": {"baudRate": 1}})),
            ("serial_acquire", json!({"device": {"id": "nope", "generation": 1}})),
            ("nope", json!({})),
        ] {
            assert_eq!(call(&client, name, args).await["isError"], true, "{name}");
        }
        assert_eq!(text(&call(&client, "nope", json!({})).await)["error"], "Unsupported device tool");
        let released = call(&client, "serial_release", json!({"device": dev, "lease": lease})).await;
        assert_eq!(released["content"][0]["text"], "{}");
        let unknown = handle(&client, &json!({"jsonrpc":"2.0","id":3,"method":"resources/list"})).await.unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn schemas_are_the_published_ones() {
        let t = tools();
        assert_eq!(t[1]["inputSchema"], json!({"type":"object","properties":{"device":{"type":"object","properties":{"id":{"type":"string","format":"uuid"},"generation":{"type":"integer","minimum":1}},"required":["id","generation"]}},"required":["device"]}));
        assert_eq!(t[4]["inputSchema"]["properties"]["maxBytes"], json!({"type":"integer","minimum":1,"maximum":16384}));
        assert_eq!(t[0]["inputSchema"], json!({"type":"object","properties":{},"required":[]}));
    }
}
