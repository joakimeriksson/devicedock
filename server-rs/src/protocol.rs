//! Wire protocol: a hand-written port of packages/protocol/index.ts (the zod schemas). Keep the two in step.
//! Parsing mirrors zod: unknown keys on the outer request/message objects are dropped, `.strict()` objects reject
//! them, and defaults are filled in so what we forward to the browser is the normalised request.
use base64::alphabet::STANDARD;
use base64::engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig};
use base64::Engine;
use serde_json::{json, Map, Value};

pub const MAX_AUTONOMY_MS: i64 = 2 * 60 * 60 * 1000;
pub const MAX_BYTES: usize = 16384;
pub const MAX_BUFFER: usize = 65536;
pub const MAX_PENDING: usize = 64;
pub const MAX_DAP_PACKET: usize = 1024;

const B64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

pub type R<T> = Result<T, String>;

pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Same rule as the zod `base64` schema: canonical padded base64, at most `max` decoded bytes.
pub fn decode_base64(s: &str, max: usize) -> R<Vec<u8>> {
    if s.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("Payload too large".into());
    }
    let bytes = B64.decode(s).map_err(|_| "Invalid base64".to_string())?;
    if bytes.len() > max {
        return Err("Payload too large".into());
    }
    Ok(bytes)
}

pub fn encode_base64(b: &[u8]) -> String {
    B64.encode(b)
}

fn obj<'a>(v: &'a Value, what: &str) -> R<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| format!("{what}: expected an object"))
}
fn strict(m: &Map<String, Value>, allowed: &[&str], what: &str) -> R<()> {
    match m.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(format!("{what}: unrecognized key \"{k}\"")),
        None => Ok(()),
    }
}
/// zod `.int()`: any finite JSON number without a fractional part (5.0 counts), within the safe-integer range.
fn int(v: &Value) -> Option<i64> {
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0).then_some(f as i64)
}
/// Present-and-valid, absent, or an error (null is not "absent" for zod `.optional()`).
fn opt<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    m.get(k)
}
fn req_int(m: &Map<String, Value>, k: &str, lo: i64, hi: i64) -> R<i64> {
    let v = m.get(k).ok_or_else(|| format!("{k}: required"))?;
    int(v).filter(|n| *n >= lo && *n <= hi).ok_or_else(|| format!("{k}: expected an integer in {lo}..{hi}"))
}
fn opt_int(m: &Map<String, Value>, k: &str, lo: i64, hi: i64) -> R<Option<i64>> {
    match opt(m, k) {
        None => Ok(None),
        Some(_) => req_int(m, k, lo, hi).map(Some),
    }
}
fn opt_uuid(m: &Map<String, Value>, k: &str) -> R<Option<String>> {
    match opt(m, k) {
        None => Ok(None),
        Some(Value::String(s)) if is_uuid(s) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{k}: invalid uuid")),
    }
}
fn req_uuid(m: &Map<String, Value>, k: &str) -> R<String> {
    opt_uuid(m, k)?.ok_or_else(|| format!("{k}: required"))
}
fn req_bool(m: &Map<String, Value>, k: &str) -> R<bool> {
    m.get(k).and_then(Value::as_bool).ok_or_else(|| format!("{k}: expected a boolean"))
}
fn opt_str(m: &Map<String, Value>, k: &str, min: usize, max: usize) -> R<Option<String>> {
    match opt(m, k) {
        None => Ok(None),
        // zod counts UTF-16 code units.
        Some(Value::String(s)) if (min..=max).contains(&s.encode_utf16().count()) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{k}: expected a string of {min}..{max} characters")),
    }
}
fn enum_default(m: &Map<String, Value>, k: &str, allowed: &[&str], default: &str) -> R<Value> {
    match opt(m, k) {
        None => Ok(json!(default)),
        Some(Value::String(s)) if allowed.contains(&s.as_str()) => Ok(json!(s)),
        Some(_) => Err(format!("{k}: expected one of {allowed:?}")),
    }
}
fn lit_default(m: &Map<String, Value>, k: &str, allowed: &[i64], default: i64) -> R<Value> {
    match opt(m, k) {
        None => Ok(json!(default)),
        Some(v) => match v.as_i64().filter(|n| allowed.contains(n)) {
            Some(n) => Ok(json!(n)),
            None => Err(format!("{k}: expected one of {allowed:?}")),
        },
    }
}

pub const OPS: [&str; 12] = [
    "devices.list", "serial.acquire", "serial.release", "serial.connect", "serial.disconnect", "serial.configure",
    "serial.signals", "serial.write", "probe.open", "probe.close", "probe.transfer", "serial.read",
];

#[derive(Clone, Debug)]
pub struct Request {
    pub id: String,
    pub device_id: Option<String>,
    pub generation: Option<i64>,
    pub deadline: i64,
    pub lease: Option<String>,
    pub op: String,
    /// Normalised arguments (defaults filled in), forwarded to the page as is.
    pub args: Value,
}

impl Request {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("v".into(), json!(1));
        m.insert("id".into(), json!(self.id));
        if let Some(d) = &self.device_id {
            m.insert("deviceId".into(), json!(d));
        }
        if let Some(g) = self.generation {
            m.insert("generation".into(), json!(g));
        }
        m.insert("deadline".into(), json!(self.deadline));
        if let Some(l) = &self.lease {
            m.insert("lease".into(), json!(l));
        }
        m.insert("op".into(), json!(self.op));
        m.insert("args".into(), self.args.clone());
        Value::Object(m)
    }
    pub fn arg_i64(&self, k: &str) -> Option<i64> {
        self.args.get(k).and_then(Value::as_i64)
    }
}

fn serial_options(a: &Map<String, Value>) -> R<Value> {
    strict(a, &["baudRate", "dataBits", "stopBits", "parity", "flowControl"], "args")?;
    Ok(json!({
        "baudRate": req_int(a, "baudRate", 300, 4_000_000)?,
        "dataBits": lit_default(a, "dataBits", &[7, 8], 8)?,
        "stopBits": lit_default(a, "stopBits", &[1, 2], 1)?,
        "parity": enum_default(a, "parity", &["none", "even", "odd"], "none")?,
        "flowControl": enum_default(a, "flowControl", &["none", "hardware"], "none")?,
    }))
}

fn parse_args(op: &str, v: &Value) -> R<Value> {
    let a = obj(v, "args")?;
    match op {
        "devices.list" | "serial.acquire" | "serial.release" | "serial.disconnect" | "probe.open" | "probe.close" => {
            strict(a, &[], "args")?;
            Ok(json!({}))
        }
        "serial.connect" | "serial.configure" => serial_options(a),
        "serial.signals" => {
            strict(a, &["dataTerminalReady", "requestToSend", "break"], "args")?;
            let mut out = Map::new();
            for k in ["dataTerminalReady", "requestToSend", "break"] {
                if let Some(x) = a.get(k) {
                    out.insert(k.into(), json!(x.as_bool().ok_or_else(|| format!("{k}: expected a boolean"))?));
                }
            }
            Ok(Value::Object(out))
        }
        "serial.write" | "probe.transfer" => {
            strict(a, &["data"], "args")?;
            let s = a.get("data").and_then(Value::as_str).ok_or("data: expected a string")?;
            let bytes = decode_base64(s, MAX_BYTES)?;
            if op == "probe.transfer" && (bytes.is_empty() || bytes.len() > MAX_DAP_PACKET) {
                return Err("DAP packet empty or larger than 1024 bytes".into());
            }
            Ok(json!({ "data": s }))
        }
        "serial.read" => {
            strict(a, &["maxBytes"], "args")?;
            let n = opt_int(a, "maxBytes", 1, MAX_BYTES as i64)?.unwrap_or(MAX_BYTES as i64);
            Ok(json!({ "maxBytes": n }))
        }
        _ => Err(format!("Invalid operation \"{op}\"")),
    }
}

pub fn parse_request(v: &Value) -> R<Request> {
    let m = obj(v, "request")?;
    if m.get("v").and_then(int) != Some(1) {
        return Err("v: expected 1".into());
    }
    let op = m.get("op").and_then(Value::as_str).ok_or("op: required")?;
    if !OPS.contains(&op) {
        return Err(format!("Invalid operation \"{op}\""));
    }
    Ok(Request {
        id: req_uuid(m, "id")?,
        device_id: opt_uuid(m, "deviceId")?,
        generation: opt_int(m, "generation", 1, i64::MAX)?,
        deadline: req_int(m, "deadline", 1, i64::MAX)?,
        lease: opt_uuid(m, "lease")?,
        op: op.to_string(),
        args: parse_args(op, m.get("args").ok_or("args: required")?)?,
    })
}

pub const DEVICE_KINDS: [&str; 4] = ["serial", "mock", "sim", "probe"];
pub fn is_physical(kind: &str) -> bool {
    kind == "serial" || kind == "probe"
}

#[derive(Clone, Debug)]
pub struct Descriptor {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub engine: Option<String>,
    pub board: Option<String>,
    pub generation: i64,
    pub auto_approve: bool,
    pub autonomous_until: Option<i64>,
    pub baud_rate: i64,
}

pub fn parse_descriptor(v: &Value) -> R<Descriptor> {
    let m = obj(v, "device")?;
    strict(
        m,
        &["id", "name", "kind", "engine", "board", "generation", "autoApprove", "autonomousUntil", "baudRate"],
        "device",
    )?;
    let kind = m.get("kind").and_then(Value::as_str).filter(|k| DEVICE_KINDS.contains(k));
    Ok(Descriptor {
        id: req_uuid(m, "id")?,
        name: opt_str(m, "name", 1, 100)?.ok_or("name: required")?,
        kind: kind.ok_or("kind: invalid")?.to_string(),
        engine: opt_str(m, "engine", 0, 40)?,
        board: opt_str(m, "board", 0, 60)?,
        generation: req_int(m, "generation", 1, i64::MAX)?,
        auto_approve: req_bool(m, "autoApprove")?,
        autonomous_until: opt_int(m, "autonomousUntil", 1, i64::MAX)?,
        baud_rate: req_int(m, "baudRate", 300, 4_000_000)?,
    })
}

#[derive(Debug)]
pub enum BrowserMessage {
    Expose(Descriptor),
    Revoke { device_id: String },
    Autonomy { device_id: String, until: Option<i64> },
    Data { device_id: String, generation: i64, data: Vec<u8> },
    Reply { id: String, ok: bool, error: Option<String>, data: Option<String> },
    ProbeEnd { device_id: String },
    Approve { id: String, allow: bool },
    Rpc(Value),
}

pub fn parse_browser_message(v: &Value) -> R<BrowserMessage> {
    let m = obj(v, "message")?;
    let ty = m.get("type").and_then(Value::as_str).ok_or("type: required")?;
    Ok(match ty {
        "expose" => BrowserMessage::Expose(parse_descriptor(m.get("device").ok_or("device: required")?)?),
        "revoke" => BrowserMessage::Revoke { device_id: req_uuid(m, "deviceId")? },
        "probe-end" => BrowserMessage::ProbeEnd { device_id: req_uuid(m, "deviceId")? },
        "autonomy" => BrowserMessage::Autonomy {
            device_id: req_uuid(m, "deviceId")?,
            until: match m.get("until") {
                Some(Value::Null) => None,
                Some(_) => Some(req_int(m, "until", 1, i64::MAX)?),
                None => return Err("until: required".into()),
            },
        },
        "data" => BrowserMessage::Data {
            device_id: req_uuid(m, "deviceId")?,
            generation: req_int(m, "generation", 1, i64::MAX)?,
            data: decode_base64(m.get("data").and_then(Value::as_str).ok_or("data: expected a string")?, MAX_BYTES)?,
        },
        "reply" => BrowserMessage::Reply {
            id: req_uuid(m, "id")?,
            ok: req_bool(m, "ok")?,
            error: opt_str(m, "error", 0, 300)?,
            data: match m.get("data") {
                None => None,
                Some(Value::String(s)) => {
                    decode_base64(s, MAX_BYTES)?;
                    Some(s.clone())
                }
                Some(_) => return Err("data: expected a string".into()),
            },
        },
        "approve" => BrowserMessage::Approve { id: req_uuid(m, "id")?, allow: req_bool(m, "allow")? },
        "rpc" => {
            let r = m.get("request").ok_or("request: required")?;
            parse_request(r)?;
            BrowserMessage::Rpc(r.clone())
        }
        _ => return Err(format!("Invalid message type \"{ty}\"")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    #[test]
    fn rejects_invalid_bytes_oversized_payloads_and_unsupported_ops() {
        assert!(decode_base64("%%%", MAX_BYTES).is_err());
        assert!(decode_base64(&encode_base64(&vec![0; 16385]), MAX_BYTES).is_err());
        assert!(decode_base64(&encode_base64(&vec![0; 16384]), MAX_BYTES).is_ok());
        assert!(parse_request(&json!({"v":1,"id":id(),"op":"flash","args":{},"deadline":1})).is_err());
    }
    #[test]
    fn dap_packet_limits() {
        let r = |data: String| parse_request(&json!({"v":1,"id":id(),"op":"probe.transfer","deadline":5,"args":{"data":data}}));
        assert!(r(encode_base64(&[0; 1024])).is_ok());
        assert!(r(encode_base64(&[0; 1025])).is_err());
        assert!(r(String::new()).is_err());
    }
    #[test]
    fn defaults_and_strictness() {
        let r = parse_request(&json!({"v":1,"id":id(),"op":"serial.configure","deadline":5,"args":{"baudRate":9600},"extra":1})).unwrap();
        assert_eq!(r.args, json!({"baudRate":9600,"dataBits":8,"stopBits":1,"parity":"none","flowControl":"none"}));
        assert!(parse_request(&json!({"v":1,"id":id(),"op":"serial.acquire","deadline":5,"args":{"x":1}})).is_err());
        let rd = parse_request(&json!({"v":1,"id":id(),"op":"serial.read","deadline":5.0,"args":{}})).unwrap();
        assert_eq!(rd.arg_i64("maxBytes"), Some(16384));
    }
    #[test]
    fn descriptor_kinds() {
        let d = json!({"id":id(),"name":"Sim","kind":"sim","engine":"esp32sim","generation":1,"autoApprove":true,"baudRate":115200});
        assert!(parse_descriptor(&d).is_ok());
        let mut q = d.clone();
        q["kind"] = json!("quantum");
        assert!(parse_descriptor(&q).is_err());
    }
}
