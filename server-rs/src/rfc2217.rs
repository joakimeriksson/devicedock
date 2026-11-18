//! Inside the sandbox: RFC 2217 (Telnet COM-PORT-OPTION) servers exposing the shared browser devices.
//! Tools connect with `rfc2217://127.0.0.1:2217` (esptool, pyserial, PlatformIO, mpremote-via-pyserial); device N in
//! `order_devices` order is on port 2217+N. Baud/DTR/RTS/data become the same lease + bridge operations every other
//! client uses, so approvals and "autonomous mode" are enforced by the backend's broker, not here.
use crate::device::DeviceClient;
use crate::protocol::{order_devices, R};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};

pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;
pub const BINARY: u8 = 0;
pub const SGA: u8 = 3;
pub const COMPORT: u8 = 44;
// COM-PORT-OPTION sub-commands (client -> server); replies add 100.
const SET_BAUDRATE: u8 = 1;
const SET_DATASIZE: u8 = 2;
const SET_PARITY: u8 = 3;
const SET_STOPSIZE: u8 = 4;
const SET_CONTROL: u8 = 5;
const NOTIFY_MODEMSTATE: u8 = 7;
const SET_LINESTATE_MASK: u8 = 10;
const SET_MODEMSTATE_MASK: u8 = 11;
const PURGE_DATA: u8 = 12;
const WRITE_CHUNK: usize = 4096;
const SUPPORTED: [u8; 3] = [BINARY, SGA, COMPORT];
/// DTR/RTS changes closer together than this are applied as one operation (see `schedule_signals`).
const SIGNAL_WINDOW: Duration = Duration::from_millis(80);

/// Escapes 0xFF as IAC IAC for the telnet data stream.
pub fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
    out
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Data(Vec<u8>),
    Cmd(u8, u8),
    Sub(Vec<u8>),
}

#[derive(Default, Clone, Copy, PartialEq)]
enum St {
    #[default]
    Data,
    Iac,
    Neg,
    Sb,
    SbIac,
}

/// Incremental telnet parser: data (IAC-unescaped), option negotiations and subnegotiations.
#[derive(Default)]
pub struct TelnetParser {
    state: St,
    cmd: u8,
    sub: Vec<u8>,
}

impl TelnetParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Event> {
        let mut events = vec![];
        let mut data = vec![];
        let flush = |data: &mut Vec<u8>, events: &mut Vec<Event>| {
            if !data.is_empty() {
                events.push(Event::Data(std::mem::take(data)));
            }
        };
        for &b in chunk {
            match self.state {
                St::Data => {
                    if b == IAC {
                        self.state = St::Iac;
                    } else {
                        data.push(b);
                    }
                }
                St::Iac => {
                    if b == IAC {
                        data.push(IAC);
                        self.state = St::Data;
                    } else if b == SB {
                        flush(&mut data, &mut events);
                        self.sub.clear();
                        self.state = St::Sb;
                    } else if (WILL..=DONT).contains(&b) {
                        flush(&mut data, &mut events);
                        self.cmd = b;
                        self.state = St::Neg;
                    } else {
                        self.state = St::Data; // NOP and friends
                    }
                }
                St::Neg => {
                    events.push(Event::Cmd(self.cmd, b));
                    self.state = St::Data;
                }
                St::Sb => {
                    if b == IAC {
                        self.state = St::SbIac;
                    } else {
                        self.sub.push(b);
                    }
                }
                St::SbIac => {
                    if b == SE {
                        events.push(Event::Sub(std::mem::take(&mut self.sub)));
                        self.state = St::Data;
                    } else {
                        self.sub.push(b); // IAC IAC inside a subnegotiation = literal 255
                        self.state = St::Sb;
                    }
                }
            }
        }
        flush(&mut data, &mut events);
        events
    }
}

/// Line settings as the client asked for them.
#[derive(Clone, PartialEq)]
struct Cfg {
    baud: i64,
    data_bits: u8,
    stop_bits: u8,
    parity: &'static str,
    flow: &'static str,
}
impl Default for Cfg {
    fn default() -> Self {
        Cfg { baud: 115200, data_bits: 8, stop_bits: 1, parity: "none", flow: "none" }
    }
}
impl Cfg {
    fn json(&self) -> Value {
        json!({"baudRate": self.baud, "dataBits": self.data_bits, "stopBits": self.stop_bits, "parity": self.parity, "flowControl": self.flow})
    }
}

#[derive(Default)]
struct State {
    cfg: Cfg,
    applied: Cfg,
    dtr: bool,
    rts: bool,
    /// A DTR/RTS change is waiting in the merge window.
    signals_pending: bool,
    /// Bumped by every schedule and flush, so a superseded timer does nothing.
    signals_gen: u64,
    cfg_changed_at: i64,
    last_activity: i64,
    device: Option<Value>,
    lease: Option<String>,
}

pub struct Server {
    api: DeviceClient,
    port: u16,
    log: Log,
    /// The live session per slot. A new connection replaces it instead of being refused: tools such as esptool
    /// reconnect after a failed attempt, and the dead session must not block them.
    current: Mutex<HashMap<u16, Live>>,
    /// Leases this server still holds because a release failed (e.g. the device was busy with a pending approval), by
    /// device id. The client id is shared, so a later session may release them itself.
    held: Mutex<HashMap<String, (Value, String)>>,
    /// Replacing a session happens one connection at a time.
    queue: tokio::sync::Mutex<()>,
}

/// Starts one server per slot on `port`+slot; returns the addresses that could be bound.
pub async fn start(api: DeviceClient, port: u16, host: &str, log: Log, slots: u16) -> Vec<SocketAddr> {
    let srv = Arc::new(Server { api, port, log: log.clone(), current: Mutex::default(), held: Mutex::default(), queue: Default::default() });
    let mut addrs = vec![];
    for slot in 0..slots {
        let listener = match TcpListener::bind((host, port + slot)).await {
            Ok(l) => l,
            Err(e) => {
                log(&format!("rfc2217: port {}: {e}", port + slot));
                continue;
            }
        };
        addrs.extend(listener.local_addr());
        let srv = srv.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((socket, _)) = listener.accept().await {
                    tokio::spawn(srv.clone().accept(socket, slot));
                }
            }
        });
    }
    log(&format!(
        "RFC 2217 serial servers on {host}:{port}-{} (device N is on port {port}+N, see `device list`)",
        port + slots.max(1) - 1
    ));
    addrs
}

impl Server {
    async fn accept(self: Arc<Self>, socket: TcpStream, slot: u16) {
        let q = self.queue.lock().await;
        let prev = self.current.lock().unwrap().get(&slot).cloned();
        if let Some((prev, mut done)) = prev {
            (self.log)(&format!("rfc2217: new connection on port {} replaces the previous session", self.port + slot));
            prev.end();
            let _ = tokio::time::timeout(Duration::from_secs(5), until_set(&mut done)).await;
        }
        let (session, done, run) = Session::new(self.clone(), socket, slot);
        self.current.lock().unwrap().insert(slot, (session.clone(), done));
        drop(q);
        run.await;
        let mut cur = self.current.lock().unwrap();
        if cur.get(&slot).is_some_and(|(s, _)| Arc::ptr_eq(s, &session)) {
            cur.remove(&slot);
        }
    }
}

type Job = BoxFuture<'static, ()>;
/// A running session and its "finished" flag.
type Live = (Arc<Session>, watch::Receiver<bool>);

pub struct Session {
    srv: Arc<Server>,
    slot: u16,
    open: AtomicBool,
    closed: watch::Sender<bool>,
    out: mpsc::UnboundedSender<Vec<u8>>,
    st: Mutex<State>,
    /// Bridge operations run one at a time, in order (the broker rejects overlapping operations on one lease). None
    /// once the session has ended.
    jobs: Mutex<Option<mpsc::UnboundedSender<Job>>>,
}

fn now() -> i64 {
    crate::broker::now_ms()
}

/// Waits until the flag is set.
async fn until_set(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|c| *c).await;
}

impl Session {
    fn new(srv: Arc<Server>, socket: TcpStream, slot: u16) -> (Arc<Self>, watch::Receiver<bool>, BoxFuture<'static, ()>) {
        let _ = socket.set_nodelay(true);
        let (mut rd, mut wr) = socket.into_split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (jobs, mut jobs_rx) = mpsc::unbounded_channel::<Job>();
        let (closed, _) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        let s = Arc::new(Session {
            srv,
            slot,
            open: AtomicBool::new(true),
            closed,
            out,
            st: Mutex::new(State { last_activity: now(), ..Default::default() }),
            jobs: Mutex::new(Some(jobs)),
        });
        // Writer: the socket's only writer. What was queued before the session ended still goes out (nothing is queued
        // after: `send` checks `open`).
        let mut closed_rx = s.closed.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    b = out_rx.recv() => match b {
                        Some(b) => if wr.write_all(&b).await.is_err() { break },
                        None => break,
                    },
                    _ = until_set(&mut closed_rx) => break,
                }
            }
        });
        // Reader: telnet events from the client.
        let me = s.clone();
        let mut closed_rx = s.closed.subscribe();
        tokio::spawn(async move {
            let mut parser = TelnetParser::default();
            let mut buf = vec![0u8; 16384];
            loop {
                tokio::select! {
                    r = rd.read(&mut buf) => match r {
                        Ok(0) => { me.open.store(false, Ordering::SeqCst); break }
                        Ok(n) => {
                            me.st.lock().unwrap().last_activity = now();
                            for ev in parser.push(&buf[..n]) {
                                me.on_event(ev);
                            }
                        }
                        Err(_) => { me.end(); break }
                    },
                    _ = until_set(&mut closed_rx) => break,
                }
            }
        });
        // Offer the options RFC 2217 clients expect.
        for (c, o) in [(WILL, COMPORT), (WILL, BINARY), (DO, BINARY), (WILL, SGA), (DO, SGA)] {
            s.send_cmd(c, o);
        }
        let (attached_tx, attached_rx) = oneshot::channel::<()>();
        // Operations wait until the device is attached (or attaching failed).
        tokio::spawn(async move {
            let _ = attached_rx.await;
            while let Some(job) = jobs_rx.recv().await {
                job.await;
            }
        });
        let me = s.clone();
        let run = Box::pin(async move {
            me.clone().run(attached_tx).await;
            let _ = done_tx.send(true);
        });
        (s, done_rx, run)
    }

    fn log(&self, m: &str) {
        (self.srv.log)(m)
    }
    fn send(&self, b: Vec<u8>) {
        if self.open.load(Ordering::SeqCst) {
            let _ = self.out.send(b);
        }
    }
    fn send_cmd(&self, c: u8, o: u8) {
        self.send(vec![IAC, c, o]);
    }
    fn reply(&self, code: u8, payload: &[u8]) {
        let mut v = vec![IAC, SB, COMPORT, code + 100];
        v.extend(escape_iac(payload));
        v.extend([IAC, SE]);
        self.send(v);
    }
    /// Closes the client's connection; queued operations still run.
    fn end(&self) {
        self.open.store(false, Ordering::SeqCst);
        self.closed.send_replace(true);
    }

    fn enqueue(&self, job: Job) {
        if let Some(j) = self.jobs.lock().unwrap().as_ref() {
            let _ = j.send(job);
        }
    }

    /// Queues a bridge operation; the line settings are applied first when they changed.
    fn op(self: &Arc<Self>, name: &'static str, args: Value) -> impl std::future::Future<Output = R<Value>> {
        let (tx, rx) = oneshot::channel();
        let me = self.clone();
        self.enqueue(Box::pin(async move {
            let _ = tx.send(me.run_op(name, args).await);
        }));
        async move { rx.await.unwrap_or_else(|_| Err("session ended".into())) }
    }

    /// Resolves once every operation queued before it has finished.
    fn barrier(&self) -> impl std::future::Future<Output = ()> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Box::pin(async move {
            let _ = tx.send(());
        }));
        async move {
            let _ = rx.await;
        }
    }

    async fn run_op(&self, name: &str, args: Value) -> R<Value> {
        let (device, lease, need_sync) = {
            let st = self.st.lock().unwrap();
            // Modem-control lines do not depend on the baud rate, so they never force a reconfigure. Reads wait until
            // the settings have been stable briefly, so a client's transient baud flips (esptool opens at 9600 then
            // sets 115200) never cause a port reopen.
            let sync = if name == "serial.read" { now() - st.cfg_changed_at > 1000 } else { name != "serial.signals" };
            (st.device.clone(), st.lease.clone(), sync)
        };
        let device = device.ok_or("no device attached")?;
        if need_sync {
            // SET_* requests only update `cfg`; the port is reconfigured lazily, right before the next real operation,
            // and only if the final value differs from what is applied. Clients like esptool flip the baud rate several
            // times at connect (115200 -> 9600 -> 115200); in the browser a reconfigure closes and reopens the port,
            // which can reset the attached board, so collapse them.
            let next = {
                let st = self.st.lock().unwrap();
                (st.cfg != st.applied).then(|| st.cfg.clone())
            };
            if let Some(next) = next {
                self.srv.api.op("serial.configure", &device, next.json(), lease.as_deref()).await?;
                self.st.lock().unwrap().applied = next;
            }
        }
        self.srv.api.op(name, &device, args, lease.as_deref()).await
    }

    fn apply_config(&self, f: impl FnOnce(&mut Cfg)) {
        let mut st = self.st.lock().unwrap();
        let mut next = st.cfg.clone();
        f(&mut next);
        if next != st.cfg {
            st.cfg_changed_at = now();
            st.cfg = next;
        }
    }

    // DTR and RTS must reach the port in ONE operation. esptool enters the bootloader by changing both back to back,
    // and a board's auto-reset circuit treats "both on" as neutral, so even a short gap (each bridge operation takes
    // tens of ms) lets the chip boot normally instead of into download mode. So changes are merged over a short
    // trailing-edge window (80 ms) and applied together. The window must exceed the gap between two consecutive
    // pyserial calls (~52 ms: rfc2217_set_control polls for the ack in 50 ms steps) and stay below the holds esptool
    // really intends (>= 100 ms).
    fn schedule_signals(self: &Arc<Self>) {
        let gen = {
            let mut st = self.st.lock().unwrap();
            st.signals_pending = true;
            st.signals_gen += 1;
            st.signals_gen
        };
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SIGNAL_WINDOW).await;
            if me.st.lock().unwrap().signals_gen == gen {
                me.flush_signals().await;
            }
        });
    }

    /// Queues the waiting DTR/RTS change now (so it goes before anything queued later); the future reports failure.
    fn flush_signals(self: &Arc<Self>) -> impl std::future::Future<Output = ()> {
        let pending = {
            let mut st = self.st.lock().unwrap();
            st.signals_gen += 1;
            std::mem::take(&mut st.signals_pending).then_some((st.dtr, st.rts))
        };
        let op = pending.map(|(dtr, rts)| self.op("serial.signals", json!({"dataTerminalReady": dtr, "requestToSend": rts})));
        let me = self.clone();
        async move {
            if let Some(op) = op {
                if let Err(e) = op.await {
                    me.log(&format!("rfc2217: signals failed: {e}"));
                    me.end();
                }
            }
        }
    }

    fn on_event(self: &Arc<Self>, ev: Event) {
        match ev {
            Event::Data(bytes) => self.write_out(&bytes),
            Event::Sub(p) => {
                if let Err(e) = self.handle_sub(&p) {
                    self.log(&format!("rfc2217: {e}"));
                    self.end();
                }
            }
            // Accept the options we support; the initial WILLs may already have been sent.
            Event::Cmd(DO, opt) if !SUPPORTED.contains(&opt) => self.send_cmd(WONT, opt),
            Event::Cmd(WILL, opt) => self.send_cmd(if SUPPORTED.contains(&opt) { DO } else { DONT }, opt),
            Event::Cmd(..) => {}
        }
    }

    fn write_out(self: &Arc<Self>, bytes: &[u8]) {
        tokio::spawn(self.flush_signals());
        for chunk in bytes.chunks(WRITE_CHUNK) {
            let op = self.op("serial.write", json!({"data": STANDARD.encode(chunk)}));
            let me = self.clone();
            tokio::spawn(async move {
                if let Err(e) = op.await {
                    me.log(&format!("rfc2217: write failed: {e}"));
                    me.end();
                }
            });
        }
    }

    fn handle_sub(self: &Arc<Self>, p: &[u8]) -> R<()> {
        if p.first() != Some(&COMPORT) || p.len() < 2 {
            return Ok(());
        }
        let (code, v) = (p[1], &p[2..]);
        let v0 = v.first().copied();
        match code {
            SET_BAUDRATE => {
                let b: [u8; 4] = v.get(..4).and_then(|b| b.try_into().ok()).ok_or("SET-BAUDRATE without a 4-byte value")?;
                let baud = u32::from_be_bytes(b);
                if baud > 0 {
                    self.apply_config(|c| c.baud = baud as i64);
                }
                let baud = self.st.lock().unwrap().cfg.baud as u32;
                self.reply(code, &baud.to_be_bytes());
            }
            SET_DATASIZE => {
                if let Some(n @ (7 | 8)) = v0 {
                    self.apply_config(|c| c.data_bits = n);
                }
                let n = self.st.lock().unwrap().cfg.data_bits;
                self.reply(code, &[n]);
            }
            SET_PARITY => {
                if let Some(p @ 1..=3) = v0 {
                    self.apply_config(|c| c.parity = ["none", "odd", "even"][p as usize - 1]);
                }
                let parity = self.st.lock().unwrap().cfg.parity;
                self.reply(code, &[match parity { "odd" => 2, "even" => 3, _ => 1 }]);
            }
            SET_STOPSIZE => {
                if let Some(n @ (1 | 2)) = v0 {
                    self.apply_config(|c| c.stop_bits = n);
                }
                let n = self.st.lock().unwrap().cfg.stop_bits;
                self.reply(code, &[n]);
            }
            SET_CONTROL => match v0 {
                Some(c @ (8 | 9 | 11 | 12)) => {
                    {
                        let mut st = self.st.lock().unwrap();
                        if c == 8 || c == 9 {
                            st.dtr = c == 8;
                        } else {
                            st.rts = c == 11;
                        }
                    }
                    self.schedule_signals();
                    self.reply(code, &[c]); // acknowledge now; the line change is applied atomically a moment later
                }
                Some(c @ (5 | 6)) => {
                    let op = self.op("serial.signals", json!({"break": c == 5}));
                    let me = self.clone();
                    tokio::spawn(async move {
                        match op.await {
                            Ok(_) => me.reply(code, &[c]),
                            Err(e) => {
                                me.log(&format!("rfc2217: {e}"));
                                me.end();
                            }
                        }
                    });
                }
                Some(c @ 1..=3) => {
                    self.apply_config(|cfg| cfg.flow = if c == 3 { "hardware" } else { "none" });
                    self.reply(code, &[c]);
                }
                Some(7) => {
                    let dtr = self.st.lock().unwrap().dtr;
                    self.reply(code, &[if dtr { 8 } else { 9 }]);
                }
                Some(10) => {
                    let rts = self.st.lock().unwrap().rts;
                    self.reply(code, &[if rts { 11 } else { 12 }]);
                }
                _ => self.reply(code, &[1]), // flow-control / break state queries
            },
            SET_LINESTATE_MASK | PURGE_DATA => self.reply(code, &[v0.unwrap_or(0)]),
            SET_MODEMSTATE_MASK => {
                self.reply(code, &[v0.unwrap_or(0)]);
                // Report a benign modem state (CTS+DSR+CD on) so clients that poll it do not stall.
                self.send(vec![IAC, SB, COMPORT, NOTIFY_MODEMSTATE + 100, 0xb0, IAC, SE]);
            }
            _ => {}
        }
        Ok(())
    }

    /// Picks the shared device and takes the exclusive lease. Retries while a previous holder lets go (our own stale
    /// lease is released first; another client's expires within 30 s).
    async fn attach(self: &Arc<Self>) -> R<()> {
        let (api, port) = (&self.srv.api, self.srv.port + self.slot);
        let devices = api.list().await?;
        let d = order_devices(&devices).into_iter().nth(self.slot as usize).ok_or_else(|| {
            if devices.is_empty() {
                "no shared device (share one in the browser, then check `device list`)".to_string()
            } else {
                format!("port {port} has no device (only {} shared; see rfc2217 URLs in `device list`)", devices.len())
            }
        })?;
        let id = d["id"].as_str().unwrap_or_default().to_string();
        let mut lease = None;
        for i in 0..70 {
            if !self.open.load(Ordering::SeqCst) {
                return Err("client went away before the device was free".into());
            }
            match api.acquire(&d).await {
                Ok(l) => {
                    lease = Some(l);
                    break;
                }
                Err(e) => {
                    if !e.to_lowercase().contains("already leased") || i == 69 {
                        return Err(e);
                    }
                    if i == 0 {
                        self.log("rfc2217: device is leased; waiting for it to be released");
                    }
                    let stale = self.srv.held.lock().unwrap().get(&id).cloned();
                    if let Some((sd, sl)) = stale {
                        if api.release(&sd, &sl).await.is_ok() {
                            self.srv.held.lock().unwrap().remove(&id);
                            continue;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        let lease = lease.ok_or("no lease")?;
        self.srv.held.lock().unwrap().insert(id, (d.clone(), lease.clone()));
        let mut st = self.st.lock().unwrap();
        st.applied.baud = d["baudRate"].as_i64().filter(|b| *b != 0).unwrap_or(115200);
        st.device = Some(d);
        st.lease = Some(lease);
        Ok(())
    }

    async fn run(self: Arc<Self>, attached: oneshot::Sender<()>) {
        let attach = self.attach().await;
        let _ = attached.send(());
        let r: R<()> = async {
            if let Err(e) = &attach {
                self.log(&format!("rfc2217: cannot attach: {e}"));
                self.end();
            }
            attach?;
            // Reader: poll the lease queue; poll fast while active, slowly when idle.
            while self.open.load(Ordering::SeqCst) {
                let r = self.op("serial.read", json!({"maxBytes": 16384})).await?;
                let data = STANDARD.decode(r["data"].as_str().unwrap_or_default()).unwrap_or_default();
                let idle_for = {
                    let mut st = self.st.lock().unwrap();
                    if !data.is_empty() {
                        st.last_activity = now();
                    }
                    now() - st.last_activity
                };
                if !data.is_empty() {
                    self.send(escape_iac(&data));
                    tokio::task::yield_now().await;
                } else {
                    tokio::time::sleep(Duration::from_millis(if idle_for < 2000 { 15 } else { 80 })).await;
                }
            }
            Ok(())
        }
        .await;
        if let Err(e) = r {
            self.log(&format!("rfc2217: read loop ended: {e}"));
        }
        self.end();
        let (device, lease) = {
            let st = self.st.lock().unwrap();
            (st.device.clone(), st.lease.clone())
        };
        if let (Some(device), Some(lease)) = (device, lease) {
            // Finish what the client asked for before letting go: esptool's last DTR/RTS change (releasing the reset
            // after a flash) can still be waiting in the 80 ms merge window when it closes the socket, and queued writes
            // or signals would otherwise fail on a released lease and leave the board held in reset.
            self.flush_signals().await;
            self.barrier().await;
            if self.srv.api.release(&device, &lease).await.is_ok() {
                let id = device["id"].as_str().unwrap_or_default();
                let mut held = self.srv.held.lock().unwrap();
                if held.get(id).is_some_and(|(_, l)| *l == lease) {
                    held.remove(id);
                }
            }
            // On failure `held` keeps the lease: the next session releases it (the broker may still be busy).
        }
        self.jobs.lock().unwrap().take();
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::device::DeviceClient;

    /// A device client whose bridge is a closure: (op, args) -> result or error.
    pub fn fake(f: impl Fn(&str, &Value) -> R<Value> + Send + Sync + 'static) -> DeviceClient {
        let f = Arc::new(f);
        DeviceClient::new(Arc::new(move |m: Value| {
            let f = f.clone();
            Box::pin(async move {
                let r = &m["request"];
                Ok(match f(r["op"].as_str().unwrap(), &r["args"]) {
                    Ok(result) => json!({"id": r["id"], "ok": true, "result": result}),
                    Err(e) => json!({"id": r["id"], "ok": false, "error": e}),
                })
            })
        }))
    }

    #[test]
    fn telnet_parser_splits_data_commands_and_subnegotiations() {
        let mut p = TelnetParser::default();
        let ev = p.push(&[b'a', IAC, IAC, b'b', IAC, WILL, COMPORT, IAC, SB, COMPORT, 1, IAC, IAC, IAC, SE, b'c', IAC, 241]);
        assert_eq!(
            ev,
            [Event::Data(vec![b'a', 255, b'b']), Event::Cmd(WILL, COMPORT), Event::Sub(vec![COMPORT, 1, 255]), Event::Data(vec![b'c'])]
        );
        // Split anywhere.
        let all = [IAC, SB, COMPORT, 5, 8, IAC, SE, b'x'];
        let mut p = TelnetParser::default();
        let ev: Vec<Event> = all.iter().flat_map(|b| p.push(&[*b])).collect();
        assert_eq!(ev, [Event::Sub(vec![COMPORT, 5, 8]), Event::Data(vec![b'x'])]);
        assert_eq!(escape_iac(&[1, 255, 2]), [1, 255, 255, 2]);
    }

    /// Reads from the server until `want` has been seen (in the raw telnet stream) or the socket closes.
    async fn read_until(s: &mut TcpStream, want: &[u8]) -> Vec<u8> {
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

    #[tokio::test]
    async fn last_signal_change_is_flushed_before_the_lease_is_released() {
        let calls: Arc<Mutex<Vec<String>>> = Arc::default();
        let c = calls.clone();
        let dev = uuid::Uuid::new_v4().to_string();
        let sent = AtomicBool::new(false);
        let api = fake(move |op, args| {
            c.lock().unwrap().push(format!("{op} {args}"));
            match op {
                "devices.list" => Ok(json!([{"id": dev, "generation": 1, "name": "board", "kind": "serial", "baudRate": 115200}])),
                "serial.acquire" => Ok(json!({"lease": uuid::Uuid::new_v4().to_string()})),
                "serial.read" if !sent.swap(true, Ordering::SeqCst) => Ok(json!({"data": STANDARD.encode(b"hi\xff")})),
                "serial.read" => Ok(json!({"data": ""})),
                _ => Ok(json!({})),
            }
        });
        let addrs = start(api, 0, "127.0.0.1", Arc::new(|_| {}), 1).await;
        let mut s = TcpStream::connect(addrs[0]).await.unwrap();
        // The handshake, then data from the board with 0xFF escaped.
        let got = read_until(&mut s, &[b'h', b'i', IAC, IAC]).await;
        assert!(got.starts_with(&[IAC, WILL, COMPORT, IAC, WILL, BINARY, IAC, DO, BINARY, IAC, WILL, SGA, IAC, DO, SGA]));
        // A baud change is acknowledged at once; DTR then RTS (back to back) and the socket closes inside the window.
        s.write_all(&[IAC, SB, COMPORT, SET_BAUDRATE, 0, 0x07, 0x08, 0x00, IAC, SE]).await.unwrap();
        let got = read_until(&mut s, &[IAC, SB, COMPORT, 101, 0, 0x07, 0x08, 0x00, IAC, SE]).await;
        assert!(got.ends_with(&[IAC, SE]));
        s.write_all(&[IAC, SB, COMPORT, SET_CONTROL, 8, IAC, SE, IAC, SB, COMPORT, SET_CONTROL, 11, IAC, SE, b'x']).await.unwrap();
        s.write_all(&[IAC, SB, COMPORT, SET_CONTROL, 9, IAC, SE]).await.unwrap();
        drop(s);
        for _ in 0..300 {
            if calls.lock().unwrap().iter().any(|c| c.starts_with("serial.release")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let calls = calls.lock().unwrap().clone();
        let ops: Vec<&str> = calls.iter().map(|c| c.split(' ').next().unwrap()).filter(|o| *o != "serial.read").collect();
        assert_eq!(ops.last(), Some(&"serial.release"), "{calls:?}");
        // DTR on + RTS on were merged and applied before the data; the last change (DTR off) before the release.
        let signals: Vec<&String> = calls.iter().filter(|c| c.starts_with("serial.signals")).collect();
        assert_eq!(signals.len(), 2, "{calls:?}");
        assert!(signals[0].contains(r#""dataTerminalReady":true,"requestToSend":true"#), "{calls:?}");
        assert!(signals[1].contains(r#""dataTerminalReady":false,"requestToSend":true"#), "{calls:?}");
        let pos = |p: &str| calls.iter().position(|c| c.starts_with(p)).unwrap();
        assert!(pos("serial.signals") < pos("serial.write"));
        // The new baud rate was applied before the write, once.
        assert_eq!(calls.iter().filter(|c| c.starts_with("serial.configure")).count(), 1);
        assert!(pos("serial.configure") < pos("serial.write"));
        assert!(calls.iter().any(|c| c.starts_with("serial.configure") && c.contains("460800")));
    }

    #[tokio::test]
    async fn a_port_without_a_device_closes_the_connection() {
        let api = fake(|op, _| if op == "devices.list" { Ok(json!([])) } else { Err("unexpected".into()) });
        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        let l = logs.clone();
        let addrs = start(api, 0, "127.0.0.1", Arc::new(move |m| l.lock().unwrap().push(m.to_string())), 1).await;
        let mut s = TcpStream::connect(addrs[0]).await.unwrap();
        let got = read_until(&mut s, b"never").await;
        assert!(got.starts_with(&[IAC, WILL, COMPORT]));
        assert!(logs.lock().unwrap().iter().any(|m| m.contains("cannot attach: no shared device")), "{logs:?}");
    }
}
