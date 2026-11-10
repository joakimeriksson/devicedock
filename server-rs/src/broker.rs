//! Port of apps/server/broker.ts: exclusive leases, per-operation approval, autonomous mode, probe sessions.
//! All state sits behind one mutex; operations that need the page wait on a oneshot channel outside it.
use crate::protocol::*;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// A probe session lapses after this long without a transfer (OpenOCD runs come and go within one session).
pub const PROBE_IDLE_MS: i64 = 10 * 60 * 1000;

/// Delivers a message to the page that owns a device. Must not call back into the broker.
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Ui,
    Agent,
}

struct Lease {
    id: String,
    client: String,
    expires: i64,
}

struct Device {
    d: Descriptor,
    /// Identity of this exposure; a re-exposed device with the same id is a different object (JS `===`).
    token: u64,
    owner: String,
    send: Sink,
    lease: Option<Lease>,
    buffer: Vec<u8>,
    overflow: bool,
    busy: bool,
    probe_until: Option<i64>,
}

#[derive(PartialEq)]
enum Stage {
    Approval,
    Operation,
}

struct Pending {
    device_id: String,
    device_token: u64,
    owner: String,
    send: Sink,
    generation: i64,
    client: String,
    tx: oneshot::Sender<R<Option<String>>>,
    timer: JoinHandle<()>,
    stage: Stage,
    req: Request,
}

#[derive(Default)]
struct Inner {
    devices: IndexMap<String, Device>,
    pending: HashMap<String, Pending>,
    seen: HashMap<String, i64>,
}

pub struct Broker {
    inner: Mutex<Inner>,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    lease_ms: i64,
    tokens: AtomicU64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

impl Broker {
    pub fn new() -> Arc<Self> {
        Self::with_clock(Box::new(now_ms), 30000)
    }
    pub fn with_clock(clock: Box<dyn Fn() -> i64 + Send + Sync>, lease_ms: i64) -> Arc<Self> {
        Arc::new(Broker { inner: Mutex::default(), clock, lease_ms, tokens: AtomicU64::new(1) })
    }
    fn now(&self) -> i64 {
        (self.clock)()
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn check_autonomy(&self, until: i64) -> R<()> {
        let left = until - self.now();
        if left <= 0 || left > MAX_AUTONOMY_MS {
            return Err("Autonomous mode must expire within 2 hours".into());
        }
        Ok(())
    }

    pub fn expose(&self, owner: &str, send: Sink, info: Descriptor) -> R<()> {
        if is_physical(&info.kind) && info.auto_approve {
            return Err("Physical devices require approval".into());
        }
        if let Some(u) = info.autonomous_until {
            self.check_autonomy(u)?;
        }
        let mut s = self.lock();
        if s.devices.contains_key(&info.id) {
            return Err("Revoke the existing connection first".into());
        }
        if s.devices.len() >= 32 {
            return Err("Device limit reached".into());
        }
        let token = self.tokens.fetch_add(1, Ordering::Relaxed);
        s.devices.insert(
            info.id.clone(),
            Device {
                d: info,
                token,
                owner: owner.into(),
                send,
                lease: None,
                buffer: vec![],
                overflow: false,
                busy: false,
                probe_until: None,
            },
        );
        Ok(())
    }

    /// Browser owner turns autonomous mode on (with expiry) or off (None).
    pub fn set_autonomy(&self, owner: &str, id: &str, until: Option<i64>) -> R<()> {
        let mut s = self.lock();
        let Some(d) = s.devices.get_mut(id).filter(|d| d.owner == owner) else { return Ok(()) };
        if let Some(u) = until {
            self.check_autonomy(u)?;
        }
        d.d.autonomous_until = until;
        Ok(())
    }

    fn autonomous(&self, d: &Device) -> bool {
        (!is_physical(&d.d.kind) && d.d.auto_approve) || d.d.autonomous_until.is_some_and(|u| u > self.now())
    }

    pub fn revoke(&self, owner: &str, id: &str) {
        let mut s = self.lock();
        Self::revoke_locked(&mut s, owner, id);
    }
    fn revoke_locked(s: &mut Inner, owner: &str, id: &str) {
        if !s.devices.get(id).is_some_and(|d| d.owner == owner) {
            return;
        }
        s.devices.shift_remove(id);
        let keys: Vec<String> = s.pending.iter().filter(|(_, p)| p.device_id == id).map(|(k, _)| k.clone()).collect();
        for k in keys {
            Self::finish_locked(s, &k, Err("Device revoked or disconnected".into()));
        }
    }

    pub fn disconnect_owner(&self, owner: &str) {
        let mut s = self.lock();
        let ids: Vec<String> = s.devices.values().filter(|d| d.owner == owner).map(|d| d.d.id.clone()).collect();
        for id in ids {
            Self::revoke_locked(&mut s, owner, &id);
        }
    }

    pub fn disconnect_client(&self, client: &str) {
        let mut s = self.lock();
        for d in s.devices.values_mut() {
            if d.lease.as_ref().is_some_and(|l| l.client == client) {
                d.lease = None;
                d.buffer.clear();
            }
        }
        let keys: Vec<String> = s.pending.iter().filter(|(_, p)| p.client == client).map(|(k, _)| k.clone()).collect();
        for k in keys {
            Self::finish_locked(&mut s, &k, Err("Client disconnected".into()));
        }
    }

    pub fn data(&self, owner: &str, id: &str, generation: i64, bytes: &[u8]) {
        let now = self.now();
        let mut s = self.lock();
        let Some(d) = s.devices.get_mut(id) else { return };
        if d.owner != owner || d.d.generation != generation {
            return;
        }
        if d.lease.as_ref().is_some_and(|l| l.expires > now) {
            if d.buffer.len() + bytes.len() > MAX_BUFFER {
                d.overflow = true;
                d.buffer.clear();
            } else if !d.overflow {
                d.buffer.extend_from_slice(bytes);
            }
        }
    }

    fn finish_locked(s: &mut Inner, id: &str, result: R<Option<String>>) {
        if let Some(p) = s.pending.remove(id) {
            p.timer.abort();
            let _ = p.tx.send(result);
        }
    }
    fn finish(&self, id: &str, result: R<Option<String>>) {
        Self::finish_locked(&mut self.lock(), id, result);
    }

    fn probe_active(&self, d: &Device) -> bool {
        d.probe_until.is_some_and(|u| u > self.now())
    }
    fn end_probe_session(d: &mut Device) {
        if d.probe_until.take().is_some() {
            (d.send)(json!({"type": "probe-session", "deviceId": d.d.id, "active": false}));
        }
    }
    /// The owner cut the session off in the page; transfers fail until a new probe.open is approved.
    pub fn end_probe(&self, owner: &str, id: &str) {
        let mut s = self.lock();
        if let Some(d) = s.devices.get_mut(id).filter(|d| d.owner == owner) {
            Self::end_probe_session(d);
        }
    }

    fn valid(&self, s: &Inner, p: &Pending) -> bool {
        let now = self.now();
        s.devices.get(&p.device_id).is_some_and(|d| {
            d.token == p.device_token
                && d.d.generation == p.generation
                && p.req.deadline > now
                && d.lease.as_ref().is_some_and(|l| Some(&l.id) == p.req.lease.as_ref() && l.expires > now)
        })
    }

    pub fn approve(&self, owner: &str, id: &str, allow: bool) {
        let mut s = self.lock();
        let Some(p) = s.pending.get(id) else { return };
        if p.stage != Stage::Approval || p.owner != owner {
            return;
        }
        if !allow {
            return Self::finish_locked(&mut s, id, Err("Human denied operation".into()));
        }
        if !self.valid(&s, p) {
            return Self::finish_locked(&mut s, id, Err("Approval expired or lease invalid".into()));
        }
        let p = s.pending.get_mut(id).unwrap();
        p.stage = Stage::Operation;
        (p.send)(json!({"type": "operation", "request": p.req.to_json()}));
    }

    pub fn reply(&self, owner: &str, id: &str, ok: bool, error: Option<String>, data: Option<String>) {
        let mut s = self.lock();
        let Some(p) = s.pending.get(id) else { return };
        if p.stage != Stage::Operation || p.owner != owner {
            return;
        }
        let result = if !self.valid(&s, p) {
            Err("Stale operation reply".into())
        } else if ok {
            Ok(data)
        } else {
            Err(error.unwrap_or_else(|| "Device operation failed".into()))
        };
        Self::finish_locked(&mut s, id, result);
    }

    pub async fn run(self: &Arc<Self>, client: &str, source: Source, input: &Value) -> R<Value> {
        let r = parse_request(input)?;
        let now = self.now();
        let (rx, device_id, token) = {
            let mut s = self.lock();
            if r.deadline <= now || r.deadline > now + 60000 {
                return Err("Deadline expired or exceeds 60 seconds".into());
            }
            s.seen.retain(|_, t| *t >= now);
            if s.seen.contains_key(&r.id) {
                return Err("Request replay rejected".into());
            }
            if s.seen.len() >= 10000 {
                return Err("Request rate limit".into());
            }
            s.seen.insert(r.id.clone(), r.deadline);
            if r.op == "devices.list" {
                return Ok(Value::Array(s.devices.values().map(|d| list_entry(d, now)).collect()));
            }
            let pending_full = s.pending.len() >= MAX_PENDING;
            let lease_ms = self.lease_ms;
            let d = match r.device_id.as_ref().and_then(|id| s.devices.get_mut(id)) {
                Some(d) if r.generation == Some(d.d.generation) => d,
                _ => return Err("Device unavailable or stale generation".into()),
            };
            if d.lease.as_ref().is_some_and(|l| l.expires <= now) {
                d.lease = None;
                d.buffer.clear();
                d.overflow = false;
            }
            if r.op == "serial.acquire" {
                if d.lease.is_some() {
                    return Err("Device already leased".into());
                }
                let l = Lease { id: uuid::Uuid::new_v4().to_string(), client: client.into(), expires: now + lease_ms };
                let out = json!({"lease": l.id, "expires": l.expires});
                d.lease = Some(l);
                d.buffer.clear();
                d.overflow = false;
                return Ok(out);
            }
            if !d.lease.as_ref().is_some_and(|l| Some(&l.id) == r.lease.as_ref() && l.client == client) {
                return Err("Valid exclusive lease required".into());
            }
            if d.busy {
                return Err("Device operation in progress".into());
            }
            if r.op == "serial.release" {
                d.lease = None;
                d.buffer.clear();
                return Ok(json!({}));
            }
            let probe_op = r.op.starts_with("probe.");
            if probe_op != (d.d.kind == "probe") && r.op != "serial.read" {
                return Err(if probe_op {
                    "Not a debug probe".into()
                } else {
                    "A debug probe has no serial port; use its OpenOCD endpoint".into()
                });
            }
            if r.op == "probe.close" {
                Self::end_probe_session(d);
                return Ok(json!({}));
            }
            // Transfers run only inside an approved session. Autonomous mode opens one without asking.
            let mut quiet = false;
            if r.op == "probe.transfer" && !self.probe_active(d) {
                if !self.autonomous(d) {
                    return Err("No approved probe session: run `device probe-open <id>` and approve it in the page".into());
                }
                d.probe_until = Some(now + PROBE_IDLE_MS);
                (d.send)(json!({"type": "probe-session", "deviceId": d.d.id, "active": true}));
            }
            if r.op == "probe.transfer" {
                d.probe_until = Some(now + PROBE_IDLE_MS);
                quiet = true;
            }
            if r.op == "probe.open" && self.probe_active(d) {
                d.probe_until = Some(now + PROBE_IDLE_MS);
                return Ok(json!({"session": "active"}));
            }
            d.lease.as_mut().unwrap().expires = now + lease_ms;
            if r.op == "serial.read" {
                if d.overflow {
                    d.overflow = false;
                    return Err("Receive buffer overflow: bytes were lost".into());
                }
                let max = r.arg_i64("maxBytes").unwrap_or(MAX_BYTES as i64) as usize;
                let n = max.min(d.buffer.len());
                let out: Vec<u8> = d.buffer.drain(..n).collect();
                return Ok(json!({"data": encode_base64(&out)}));
            }
            if pending_full {
                return Err("Too many pending requests".into());
            }
            d.busy = true;
            // Approval is per operation, except DAP transfers: those were covered by approving the session.
            let approval = source == Source::Agent && !quiet && !self.autonomous(d);
            let (tx, rx) = oneshot::channel();
            let weak = Arc::downgrade(self);
            let rid = r.id.clone();
            let delay = (r.deadline - now).min(lease_ms).max(0) as u64;
            let timer = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                if let Some(b) = weak.upgrade() {
                    b.finish(&rid, Err("Operation timed out; do not automatically retry writes".into()));
                }
            });
            let send = d.send.clone();
            let (owner, token, generation, id) = (d.owner.clone(), d.token, d.d.generation, d.d.id.clone());
            let msg = json!({"type": if approval { "approval" } else { "operation" }, "request": r.to_json()});
            s.pending.insert(
                r.id.clone(),
                Pending {
                    device_id: id.clone(),
                    device_token: token,
                    owner,
                    send: send.clone(),
                    generation,
                    client: client.into(),
                    tx,
                    timer,
                    stage: if approval { Stage::Approval } else { Stage::Operation },
                    req: r.clone(),
                },
            );
            send(msg);
            (rx, id, token)
        };
        let result = rx.await.unwrap_or_else(|_| Err("Bridge stopped".into()));
        let mut s = self.lock();
        if let Some(d) = s.devices.get_mut(&device_id).filter(|d| d.token == token) {
            d.busy = false;
        }
        let data = result?;
        Ok(match r.op.as_str() {
            "probe.transfer" => json!({"data": data.unwrap_or_default()}),
            "probe.open" => {
                let until = self.now() + PROBE_IDLE_MS;
                if let Some(d) = s.devices.get_mut(&device_id).filter(|d| d.token == token) {
                    d.probe_until = Some(until);
                    (d.send)(json!({"type": "probe-session", "deviceId": d.d.id, "active": true}));
                }
                json!({"session": "opened"})
            }
            op => {
                if op == "serial.disconnect" {
                    let owner = s.devices.get(&device_id).filter(|d| d.token == token).map(|d| d.owner.clone());
                    if let Some(o) = owner {
                        Self::revoke_locked(&mut s, &o, &device_id);
                    }
                }
                if op == "serial.configure" || op == "serial.connect" {
                    if let Some(d) = s.devices.get_mut(&device_id).filter(|d| d.token == token) {
                        d.d.baud_rate = r.arg_i64("baudRate").unwrap_or(d.d.baud_rate);
                    }
                }
                json!({})
            }
        })
    }

    pub fn close(&self) {
        let mut s = self.lock();
        let keys: Vec<String> = s.pending.keys().cloned().collect();
        for k in keys {
            Self::finish_locked(&mut s, &k, Err("Bridge stopped".into()));
        }
        s.devices.clear();
    }

    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.lock().pending.len()
    }
    #[cfg(test)]
    pub fn autonomous_until(&self, id: &str) -> Option<i64> {
        self.lock().devices.get(id).and_then(|d| d.d.autonomous_until)
    }
}

fn list_entry(d: &Device, now: i64) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(d.d.id));
    m.insert("name".into(), json!(d.d.name));
    m.insert("kind".into(), json!(d.d.kind));
    // A software device is labelled as such, so agents never mistake a simulation for hardware.
    m.insert("simulated".into(), json!(!is_physical(&d.d.kind)));
    if let Some(e) = d.d.engine.as_ref().filter(|e| !e.is_empty()) {
        m.insert("engine".into(), json!(e));
    }
    if let Some(b) = d.d.board.as_ref().filter(|b| !b.is_empty()) {
        m.insert("board".into(), json!(b));
    }
    m.insert("generation".into(), json!(d.d.generation));
    m.insert("baudRate".into(), json!(d.d.baud_rate));
    m.insert("autonomous".into(), json!(d.d.autonomous_until.is_some_and(|u| u > now)));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    //! Ports of tests/unit/broker.test.ts and the broker half of tests/unit/probe.test.ts.
    use super::*;
    use std::sync::atomic::AtomicI64;

    type Sent = Arc<Mutex<Vec<Value>>>;
    fn uid() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn sink(sent: &Sent) -> Sink {
        let s = sent.clone();
        Arc::new(move |m| s.lock().unwrap().push(m))
    }
    fn desc(kind: &str, auto: bool) -> Descriptor {
        Descriptor {
            id: uid(),
            name: "Test device".into(),
            kind: kind.into(),
            engine: None,
            board: None,
            generation: 1,
            auto_approve: auto,
            autonomous_until: None,
            baud_rate: 115200,
        }
    }
    fn req(d: &str, op: &str, lease: Option<&str>, args: Value, deadline: i64) -> Value {
        let mut v = json!({"v":1,"id":uid(),"deviceId":d,"generation":1,"op":op,"args":args,"deadline":deadline});
        if let Some(l) = lease {
            v["lease"] = json!(l);
        }
        v
    }
    struct Fx {
        b: Arc<Broker>,
        d: Descriptor,
        sent: Sent,
    }
    fn fixture(auto: bool, kind: &str) -> Fx {
        let b = Broker::new();
        let sent: Sent = Arc::default();
        let d = desc(kind, auto);
        b.expose("browser", sink(&sent), d.clone()).unwrap();
        Fx { b, d, sent }
    }
    impl Fx {
        fn r(&self, op: &str, lease: Option<&str>, args: Value) -> Value {
            req(&self.d.id, op, lease, args, now_ms() + 5000)
        }
        async fn lease(&self, client: &str) -> String {
            let v = self.b.run(client, Source::Agent, &self.r("serial.acquire", None, json!({}))).await.unwrap();
            v["lease"].as_str().unwrap().to_string()
        }
        fn last(&self) -> Value {
            self.sent.lock().unwrap().last().cloned().unwrap()
        }
        fn count(&self) -> usize {
            self.sent.lock().unwrap().len()
        }
    }
    async fn tick() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    #[tokio::test]
    async fn binary_data_is_preserved_and_reads_consume_the_queue() {
        let f = fixture(true, "mock");
        let lease = f.lease("client").await;
        f.b.data("browser", &f.d.id, 1, &[0, 255, 128, 13, 10]);
        let r = f.b.run("client", Source::Agent, &f.r("serial.read", Some(&lease), json!({"maxBytes": 2}))).await.unwrap();
        assert_eq!(r["data"], json!(encode_base64(&[0, 255])));
        let r = f.b.run("client", Source::Agent, &f.r("serial.read", Some(&lease), json!({}))).await.unwrap();
        assert_eq!(r["data"], json!(encode_base64(&[128, 13, 10])));
    }

    #[tokio::test]
    async fn exclusive_leases_reject_competing_clients_and_expire() {
        let t = Arc::new(AtomicI64::new(now_ms()));
        let tc = t.clone();
        let b = Broker::with_clock(Box::new(move || tc.load(Ordering::SeqCst)), 100);
        let d = desc("mock", true);
        b.expose("browser", Arc::new(|_| {}), d.clone()).unwrap();
        let r = |op: &str, lease: Option<&str>| req(&d.id, op, lease, json!({}), t.load(Ordering::SeqCst) + 5000);
        let lease = b.run("a", Source::Agent, &r("serial.acquire", None)).await.unwrap()["lease"].as_str().unwrap().to_string();
        assert!(b.run("b", Source::Ui, &r("serial.acquire", None)).await.unwrap_err().contains("already leased"));
        assert!(b.run("b", Source::Ui, &r("serial.read", Some(&lease))).await.unwrap_err().contains("lease required"));
        t.fetch_add(101, Ordering::SeqCst);
        assert!(b.run("a", Source::Agent, &r("serial.read", Some(&lease))).await.unwrap_err().contains("lease required"));
        b.run("b", Source::Agent, &r("serial.acquire", None)).await.unwrap();
    }

    #[tokio::test]
    async fn physical_writes_need_single_use_owner_approval() {
        let f = fixture(false, "serial");
        let lease = f.lease("agent").await;
        let r = f.r("serial.write", Some(&lease), json!({"data": "UElORw=="}));
        let id = r["id"].as_str().unwrap().to_string();
        let (b, r2) = (f.b.clone(), r.clone());
        let p = tokio::spawn(async move { b.run("agent", Source::Agent, &r2).await });
        tick().await;
        assert_eq!(f.last()["type"], "approval");
        f.b.approve("wrong-owner", &id, true);
        assert_eq!(f.count(), 1);
        f.b.approve("browser", &id, true);
        assert_eq!(f.last()["type"], "operation");
        f.b.approve("browser", &id, true);
        assert_eq!(f.count(), 2);
        f.b.reply("browser", &id, true, None, None);
        p.await.unwrap().unwrap();
        assert!(f.b.run("agent", Source::Agent, &r).await.unwrap_err().contains("replay"));
        let denied = f.r("serial.signals", Some(&lease), json!({"dataTerminalReady": false}));
        let did = denied["id"].as_str().unwrap().to_string();
        let b = f.b.clone();
        let p2 = tokio::spawn(async move { b.run("agent", Source::Agent, &denied).await });
        tick().await;
        f.b.approve("browser", &did, false);
        assert!(p2.await.unwrap().unwrap_err().contains("denied"));
    }

    #[tokio::test]
    async fn revocation_rejects_pending_and_stale_generations() {
        let f = fixture(false, "mock");
        let lease = f.lease("a").await;
        let r = f.r("serial.write", Some(&lease), json!({"data": "AA=="}));
        let id = r["id"].as_str().unwrap().to_string();
        let b = f.b.clone();
        let p = tokio::spawn(async move { b.run("a", Source::Agent, &r).await });
        tick().await;
        f.b.revoke("browser", &f.d.id);
        assert!(p.await.unwrap().unwrap_err().contains("revoked"));
        let mut d2 = f.d.clone();
        d2.generation = 2;
        f.b.expose("browser", Arc::new(|_| {}), d2).unwrap();
        assert!(f.b.run("a", Source::Agent, &f.r("serial.read", Some(&lease), json!({}))).await.unwrap_err().contains("stale generation"));
        f.b.approve("browser", &id, true);
        assert_eq!(f.b.pending_len(), 0);
    }

    #[tokio::test]
    async fn timeout_expires_approvals_without_replaying_writes() {
        let f = fixture(false, "mock");
        let lease = f.lease("a").await;
        let r = req(&f.d.id, "serial.write", Some(&lease), json!({"data": "AA=="}), now_ms() + 20);
        let id = r["id"].as_str().unwrap().to_string();
        assert!(f.b.run("a", Source::Agent, &r).await.unwrap_err().contains("timed out"));
        f.b.approve("browser", &id, true);
        assert_eq!(f.count(), 1);
    }

    #[tokio::test]
    async fn overflow_is_explicit_and_stale_generation_data_is_dropped() {
        let f = fixture(true, "mock");
        let lease = f.lease("a").await;
        for _ in 0..5 {
            f.b.data("browser", &f.d.id, 1, &vec![0; MAX_BUFFER / 4]);
        }
        assert!(f.b.run("a", Source::Agent, &f.r("serial.read", Some(&lease), json!({}))).await.unwrap_err().contains("overflow"));
        f.b.data("browser", &f.d.id, 2, &[0]);
        assert_eq!(f.b.run("a", Source::Agent, &f.r("serial.read", Some(&lease), json!({}))).await.unwrap(), json!({"data": ""}));
    }

    #[test]
    fn physical_auto_approval_is_forbidden() {
        let b = Broker::new();
        assert!(b.expose("browser", Arc::new(|_| {}), desc("serial", true)).unwrap_err().contains("require approval"));
        assert!(b.expose("browser", Arc::new(|_| {}), desc("probe", true)).unwrap_err().contains("require approval"));
    }

    #[tokio::test]
    async fn autonomous_mode_skips_approval_only_while_open() {
        let f = fixture(false, "serial");
        let lease = f.lease("c").await;
        let run = |r: Value| {
            let b = f.b.clone();
            tokio::spawn(async move { b.run("c", Source::Agent, &r).await })
        };
        let w = run(f.r("serial.write", Some(&lease), json!({"data": "AA=="})));
        tick().await;
        assert_eq!(f.last()["type"], "approval");
        f.b.approve("browser", f.last()["request"]["id"].as_str().unwrap(), false);
        assert!(w.await.unwrap().unwrap_err().contains("denied"));
        f.b.set_autonomy("browser", &f.d.id, Some(now_ms() + 60_000)).unwrap();
        let r = f.r("serial.write", Some(&lease), json!({"data": "AA=="}));
        let id = r["id"].as_str().unwrap().to_string();
        let done = run(r);
        tick().await;
        assert_eq!(f.last()["type"], "operation");
        f.b.reply("browser", &id, true, None, None);
        done.await.unwrap().unwrap();
        f.b.set_autonomy("browser", &f.d.id, Some(now_ms() + 20)).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let p = run(f.r("serial.write", Some(&lease), json!({"data": "AA=="})));
        tick().await;
        assert_eq!(f.last()["type"], "approval");
        f.b.revoke("browser", &f.d.id);
        let _ = p.await;
    }

    #[test]
    fn autonomous_mode_is_owner_only_and_time_boxed() {
        let f = fixture(false, "serial");
        f.b.set_autonomy("someone-else", &f.d.id, Some(now_ms() + 60_000)).unwrap();
        assert_eq!(f.b.autonomous_until(&f.d.id), None);
        assert!(f.b.set_autonomy("browser", &f.d.id, Some(now_ms() + 3 * 3600 * 1000)).unwrap_err().contains("2 hours"));
        assert!(f.b.set_autonomy("browser", &f.d.id, Some(now_ms() - 1)).unwrap_err().contains("2 hours"));
        f.b.set_autonomy("browser", &f.d.id, Some(now_ms() + 60_000)).unwrap();
        assert!(f.b.autonomous_until(&f.d.id).is_some());
        f.b.set_autonomy("browser", &f.d.id, None).unwrap();
        assert_eq!(f.b.autonomous_until(&f.d.id), None);
    }

    #[tokio::test]
    async fn software_devices_waive_approval_and_are_labelled() {
        let sent: Sent = Arc::default();
        let b = Broker::new();
        let mut sim = desc("sim", true);
        sim.engine = Some("esp32sim".into());
        sim.board = Some("ttgo-tdisplay".into());
        b.expose("browser", sink(&sent), sim.clone()).unwrap();
        let list = b.run("c", Source::Agent, &json!({"v":1,"id":uid(),"op":"devices.list","args":{},"deadline":now_ms()+5000})).await.unwrap();
        assert_eq!(list[0]["simulated"], true);
        assert_eq!(list[0]["engine"], "esp32sim");
        assert_eq!(list[0]["board"], "ttgo-tdisplay");
        let lease = b.run("c", Source::Agent, &req(&sim.id, "serial.acquire", None, json!({}), now_ms() + 5000)).await.unwrap();
        let w = req(&sim.id, "serial.write", lease["lease"].as_str(), json!({"data": "AA=="}), now_ms() + 5000);
        let id = w["id"].as_str().unwrap().to_string();
        let b2 = b.clone();
        let done = tokio::spawn(async move { b2.run("c", Source::Agent, &w).await });
        tick().await;
        assert_eq!(sent.lock().unwrap().last().unwrap()["type"], "operation");
        b.reply("browser", &id, true, None, None);
        done.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn probe_transfers_need_an_approved_session() {
        let f = fixture(false, "probe");
        let lease = f.lease("bridge").await;
        let xfer = |f: &Fx| f.r("probe.transfer", Some(&lease), json!({"data": "AA=="}));
        assert!(f.b.run("bridge", Source::Agent, &xfer(&f)).await.unwrap_err().contains("No approved probe session"));
        assert!(f.b.run("bridge", Source::Agent, &f.r("serial.write", Some(&lease), json!({"data": "AA=="}))).await.unwrap_err().contains("no serial port"));
        // probe.open asks once.
        let open = f.r("probe.open", Some(&lease), json!({}));
        let b = f.b.clone();
        let p = tokio::spawn(async move { b.run("bridge", Source::Agent, &open).await });
        tick().await;
        let m = f.last();
        assert_eq!(m["type"], "approval");
        let oid = m["request"]["id"].as_str().unwrap().to_string();
        f.b.approve("browser", &oid, true);
        f.b.reply("browser", &oid, true, None, None);
        assert_eq!(p.await.unwrap().unwrap(), json!({"session": "opened"}));
        assert_eq!(f.last()["type"], "probe-session");
        // Transfers inside the session go straight to the page, carrying the response packet back.
        for _ in 0..3 {
            let x = xfer(&f);
            let xid = x["id"].as_str().unwrap().to_string();
            let b = f.b.clone();
            let p = tokio::spawn(async move { b.run("bridge", Source::Agent, &x).await });
            tick().await;
            assert_eq!(f.last()["type"], "operation");
            f.b.reply("browser", &xid, true, None, Some("gAA=".into()));
            assert_eq!(p.await.unwrap().unwrap(), json!({"data": "gAA="}));
        }
        // The owner cuts it off; transfers fail again.
        f.b.end_probe("browser", &f.d.id);
        assert_eq!(f.last()["active"], false);
        assert!(f.b.run("bridge", Source::Agent, &xfer(&f)).await.unwrap_err().contains("No approved probe session"));
    }
}
